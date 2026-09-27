const { buildMlReadyRows } = require('./backtest-features');
const { trainNearestCentroid, predictNearestCentroid } = require('./backtest-model');
const { selectTwoCorePlusDynamicThird } = require('./backtest-delta-two-core');
const { buildDeltaRows } = require('./backtest-cross-league-delta');
const { classificationMetrics } = require('./backtest-final-evaluation');

const TABLE = 'candidate_forward_validation';

const FORWARD_QUALITY_POLICY = Object.freeze({
  min_settled: 30,
  min_accuracy: 0.4375,
  min_balanced_accuracy: 1 / 3,
  min_draw_recall: 0.20,
  min_distinct_leagues: 8,
  min_actual_per_class: 3,
  auto_promotion: false
});

async function ensureForwardValidationTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      engine_version INTEGER NOT NULL,
      trained_through TIMESTAMPTZ NOT NULL,
      predicted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      target_reference_at TIMESTAMPTZ NOT NULL,
      prediction TEXT NOT NULL CHECK (prediction IN ('HOME','DRAW','AWAY')),
      actual TEXT NULL CHECK (actual IS NULL OR actual IN ('HOME','DRAW','AWAY')),
      settled_at TIMESTAMPTZ NULL,
      feature_count INTEGER NOT NULL,
      dynamic_left TEXT NOT NULL,
      dynamic_right TEXT NOT NULL,
      UNIQUE(event_id, model_name, trained_through)
    )
  `);
}

function buildCandidatePredictionSnapshot(trainingRows, targetRow, {
  engineVersion = 83,
  minOverallPresence = 0.95,
  minLeagueCoverage = 1.0,
  predictedAt = new Date().toISOString()
} = {}) {
  if (!Array.isArray(trainingRows) || !trainingRows.length) {
    throw new Error('Forward validation için training satırları gerekli.');
  }
  if (!targetRow?.event_id || !targetRow?.reference_at) {
    throw new Error('Geçerli target row gerekli.');
  }

  const targetMs = Date.parse(targetRow.reference_at);
  const strictTrain = trainingRows
    .filter(r => Number.isFinite(Date.parse(r.reference_at)))
    .filter(r => Date.parse(r.reference_at) < targetMs)
    .sort((a,b) =>
      Date.parse(a.reference_at) - Date.parse(b.reference_at) ||
      String(a.event_id).localeCompare(String(b.event_id))
    );

  if (!strictTrain.length) {
    throw new Error('Target öncesinde training satırı yok.');
  }

  const trainedThrough = strictTrain[strictTrain.length - 1].reference_at;
  const choice = selectTwoCorePlusDynamicThird(strictTrain, {
    minOverallPresence,
    minLeagueCoverage
  });

  if (choice.selected.length !== 3) {
    throw new Error('Aday model için 3 delta feature seçilemedi.');
  }

  const prepared = buildMlReadyRows([...strictTrain, targetRow]);
  const trainPrepared = prepared.rows.slice(0, strictTrain.length);
  const targetPrepared = prepared.rows.slice(strictTrain.length);

  const trainDelta = buildDeltaRows(trainPrepared, choice.selected);
  const targetDelta = buildDeltaRows(targetPrepared, choice.selected);
  const selectedNames = choice.selected.map(x => x.name);
  const model = trainNearestCentroid(trainDelta, selectedNames);
  const result = predictNearestCentroid(model, targetDelta[0]);

  return {
    event_id: targetRow.event_id,
    model_name: 'two_core_dynamic_delta',
    engine_version: engineVersion,
    trained_through: trainedThrough,
    predicted_at: predictedAt,
    target_reference_at: targetRow.reference_at,
    prediction: result.label,
    feature_count: selectedNames.length,
    dynamic_left: choice.dynamic.left,
    dynamic_right: choice.dynamic.right
  };
}

async function savePrediction(pool, snapshot) {
  const q = await pool.query(`
    INSERT INTO ${TABLE} (
      event_id, model_name, engine_version, trained_through,
      predicted_at, target_reference_at, prediction,
      feature_count, dynamic_left, dynamic_right
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (event_id, model_name, trained_through)
    DO UPDATE SET
      predicted_at = EXCLUDED.predicted_at,
      prediction = EXCLUDED.prediction,
      feature_count = EXCLUDED.feature_count,
      dynamic_left = EXCLUDED.dynamic_left,
      dynamic_right = EXCLUDED.dynamic_right
    RETURNING *
  `, [
    snapshot.event_id,
    snapshot.model_name,
    snapshot.engine_version,
    snapshot.trained_through,
    snapshot.predicted_at,
    snapshot.target_reference_at,
    snapshot.prediction,
    snapshot.feature_count,
    snapshot.dynamic_left,
    snapshot.dynamic_right
  ]);
  return q.rows[0];
}

async function settlePrediction(pool, {
  eventId,
  actual,
  modelName = 'two_core_dynamic_delta'
}) {
  if (!['HOME','DRAW','AWAY'].includes(actual)) {
    throw new Error('Geçerli actual label gerekli.');
  }

  const q = await pool.query(`
    UPDATE ${TABLE}
    SET actual = $1, settled_at = NOW()
    WHERE event_id = $2
      AND model_name = $3
      AND actual IS NULL
    RETURNING *
  `, [actual, eventId, modelName]);

  return q.rows;
}

function evaluateForwardProductionGate(predictions, {
  minSettled = FORWARD_QUALITY_POLICY.min_settled,
  minAccuracy = FORWARD_QUALITY_POLICY.min_accuracy,
  minBalancedAccuracy = FORWARD_QUALITY_POLICY.min_balanced_accuracy,
  minDrawRecall = FORWARD_QUALITY_POLICY.min_draw_recall,
  minDistinctLeagues = FORWARD_QUALITY_POLICY.min_distinct_leagues,
  minActualPerClass = FORWARD_QUALITY_POLICY.min_actual_per_class
} = {}) {
  const rows = Array.isArray(predictions)
    ? predictions.filter(row =>
      ['HOME','DRAW','AWAY'].includes(row?.actual) &&
      ['HOME','DRAW','AWAY'].includes(row?.predicted)
    )
    : [];

  const policy = {
    min_settled: minSettled,
    min_accuracy: minAccuracy,
    min_balanced_accuracy: minBalancedAccuracy,
    min_draw_recall: minDrawRecall,
    min_distinct_leagues: minDistinctLeagues,
    min_actual_per_class: minActualPerClass,
    auto_promotion: false
  };

  const leagueSet = new Set(
    rows.map(row => String(row.league || '').trim()).filter(Boolean)
  );
  const actualCounts = {
    HOME: rows.filter(row => row.actual === 'HOME').length,
    DRAW: rows.filter(row => row.actual === 'DRAW').length,
    AWAY: rows.filter(row => row.actual === 'AWAY').length
  };

  const diversity = {
    distinct_leagues: leagueSet.size,
    actual_class_counts: actualCounts
  };

  const reasons = [];
  if (rows.length < minSettled) {
    reasons.push('insufficient-settled-sample');
  }
  if (leagueSet.size < minDistinctLeagues) {
    reasons.push('insufficient-league-diversity');
  }
  if (Object.values(actualCounts).some(count => count < minActualPerClass)) {
    reasons.push('insufficient-actual-class-coverage');
  }

  if (rows.length < minSettled) {
    return {
      status: 'collecting',
      production_review_eligible: false,
      reasons,
      settled: rows.length,
      remaining_to_minimum: Math.max(0, minSettled - rows.length),
      policy,
      diversity,
      metrics: null
    };
  }

  const metrics = classificationMetrics(rows);

  if (metrics.accuracy < minAccuracy) {
    reasons.push('accuracy-below-minimum');
  }
  if (metrics.balanced_accuracy < minBalancedAccuracy) {
    reasons.push('balanced-accuracy-below-minimum');
  }
  if ((metrics?.per_class?.DRAW?.recall ?? 0) < minDrawRecall) {
    reasons.push('draw-recall-below-minimum');
  }

  return {
    status: reasons.length ? 'quality-gate-failed' : 'eligible-for-production-review',
    production_review_eligible: reasons.length === 0,
    reasons,
    settled: rows.length,
    remaining_to_minimum: 0,
    policy,
    diversity,
    metrics: {
      accuracy: metrics.accuracy,
      balanced_accuracy: metrics.balanced_accuracy,
      macro_f1: metrics.macro_f1,
      draw_recall: metrics.per_class.DRAW.recall,
      per_class: metrics.per_class,
      confusion: metrics.confusion
    }
  };
}

async function readForwardValidationSummary(pool, {
  modelName = 'two_core_dynamic_delta'
} = {}) {
  const q = await pool.query(`
    SELECT
      COUNT(*)::int AS total_predictions,
      COUNT(*) FILTER (WHERE actual IS NOT NULL)::int AS settled,
      COUNT(*) FILTER (WHERE actual IS NULL)::int AS pending,
      COUNT(*) FILTER (WHERE actual IS NOT NULL AND prediction = actual)::int AS correct
    FROM ${TABLE}
    WHERE model_name = $1
  `, [modelName]);

  const settledRows = await pool.query(`
    SELECT
      f.event_id,
      f.prediction AS predicted,
      f.actual,
      f.target_reference_at AS reference_at,
      m.league
    FROM ${TABLE} f
    JOIN matches m ON m.event_id = f.event_id
    WHERE f.model_name = $1
      AND f.actual IS NOT NULL
    ORDER BY f.settled_at,f.event_id
  `, [modelName]);

  const row = q.rows[0];
  return {
    ...row,
    settled_accuracy: row.settled > 0 ? row.correct / row.settled : null,
    quality_gate: evaluateForwardProductionGate(settledRows.rows)
  };
}

module.exports = {
  TABLE,
  ensureForwardValidationTable,
  buildCandidatePredictionSnapshot,
  savePrediction,
  settlePrediction,
  FORWARD_QUALITY_POLICY,
  evaluateForwardProductionGate,
  readForwardValidationSummary
};

