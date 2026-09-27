const { pool } = require('./db');
const {
  TABLE,
  readForwardValidationSummary
} = require('./backtest-forward-validation');
const { classificationMetrics } = require('./backtest-final-evaluation');

const MODEL_NAME = 'two_core_dynamic_delta';

function kickoffBucket(kickoffTime) {
  const m = String(kickoffTime || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return 'unknown';
  const hour = Number(m[1]);
  const start = Math.floor(hour / 3) * 3;
  return String(start).padStart(2, '0') + '-' +
    String(start + 2).padStart(2, '0');
}

function countValues(values) {
  const counts = {};
  for (const value of values) {
    const key = String(value ?? 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
}

async function buildForwardValidationStatus(db = pool, {
  modelName = MODEL_NAME,
  recentLimit = 8
} = {}) {
  const summary = await readForwardValidationSummary(db, { modelName });

  const recent = await db.query(`
    SELECT
      f.event_id,
      f.prediction,
      f.actual,
      f.predicted_at,
      f.settled_at,
      m.display_name,
      m.league,
      m.match_date,
      m.kickoff_time
    FROM ${TABLE} f
    JOIN matches m ON m.event_id = f.event_id
    WHERE f.model_name = $1
    ORDER BY f.predicted_at DESC, f.event_id
    LIMIT $2
  `, [modelName, Number(recentLimit)]);

  const settled = await db.query(`
    SELECT
      event_id,
      prediction AS predicted,
      actual,
      target_reference_at AS reference_at
    FROM ${TABLE}
    WHERE model_name = $1
      AND actual IS NOT NULL
    ORDER BY settled_at,event_id
  `, [modelName]);

  const settledMetrics = settled.rowCount
    ? classificationMetrics(settled.rows)
    : null;

  const sample = await db.query(`
    SELECT
      f.prediction,
      m.league,
      m.kickoff_time
    FROM ${TABLE} f
    JOIN matches m ON m.event_id = f.event_id
    WHERE f.model_name = $1
    ORDER BY f.predicted_at,f.event_id
  `, [modelName]);

  const leagueCounts = countValues(
    sample.rows.map(row => row.league || 'unknown')
  );
  const kickoffBucketCounts = countValues(
    sample.rows.map(row => kickoffBucket(row.kickoff_time))
  );
  const predictionCounts = countValues(
    sample.rows.map(row => row.prediction || 'unknown')
  );

  return {
    model: modelName,
    total: summary.total_predictions,
    pending: summary.pending,
    settled: summary.settled,
    correct: summary.correct,
    accuracy: summary.settled_accuracy,
    settled_metrics: settledMetrics,
    diversity: {
      league_count: Object.keys(leagueCounts).length,
      league_distribution: leagueCounts,
      kickoff_bucket_count: Object.keys(kickoffBucketCounts).length,
      kickoff_bucket_distribution: kickoffBucketCounts,
      prediction_distribution: predictionCounts
    },
    quality_gate: summary.quality_gate,
    recent: recent.rows
  };
}

function formatPercent(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? (value * 100).toFixed(1) + '%'
    : '-';
}

function formatForwardValidationStatus(status) {
  const gate = status.quality_gate || {};
  const lines = [
    'FORWARD VALIDATION STATUS',
    'Model: ' + status.model,
    'Total: ' + status.total +
      ' | Pending: ' + status.pending +
      ' | Settled: ' + status.settled +
      ' | Correct: ' + status.correct,
    'Accuracy: ' + formatPercent(status.accuracy),
    'Gate: ' + (gate.status || 'unknown') +
      ' | Review eligible: ' + String(gate.production_review_eligible === true)
  ];

  if (Number.isInteger(gate.remaining_to_minimum) && gate.remaining_to_minimum > 0) {
    lines.push('Minimum settled remaining: ' + gate.remaining_to_minimum);
  }

  const classMetrics = status.settled_metrics;
  if (classMetrics) {
    lines.push(
      'Balanced accuracy: ' + formatPercent(classMetrics.balanced_accuracy) +
      ' | Macro-F1: ' + formatPercent(classMetrics.macro_f1)
    );

    for (const label of ['HOME','DRAW','AWAY']) {
      const m = classMetrics.per_class[label];
      lines.push(
        label + ': support=' + m.support +
        ' | precision=' + formatPercent(m.precision) +
        ' | recall=' + formatPercent(m.recall) +
        ' | F1=' + formatPercent(m.f1)
      );
    }

    lines.push(
      'Confusion: ' +
      'HOME[' +
        classMetrics.confusion.HOME.HOME + ',' +
        classMetrics.confusion.HOME.DRAW + ',' +
        classMetrics.confusion.HOME.AWAY + '] ' +
      'DRAW[' +
        classMetrics.confusion.DRAW.HOME + ',' +
        classMetrics.confusion.DRAW.DRAW + ',' +
        classMetrics.confusion.DRAW.AWAY + '] ' +
      'AWAY[' +
        classMetrics.confusion.AWAY.HOME + ',' +
        classMetrics.confusion.AWAY.DRAW + ',' +
        classMetrics.confusion.AWAY.AWAY + ']'
    );
  } else {
    lines.push('Class metrics: waiting for settled predictions');
  }

  const diversity = status.diversity || {};
  const formatCounts = counts => Object.entries(counts || {})
    .map(([key,value]) => key + '=' + value)
    .join(', ');

  lines.push(
    'Diversity: leagues=' + (diversity.league_count ?? 0) +
    ' | kickoff buckets=' + (diversity.kickoff_bucket_count ?? 0)
  );
  lines.push(
    'Predictions: ' + (formatCounts(diversity.prediction_distribution) || '-')
  );
  lines.push(
    'Kickoff buckets: ' + (formatCounts(diversity.kickoff_bucket_distribution) || '-')
  );
  lines.push(
    'Leagues: ' + (formatCounts(diversity.league_distribution) || '-')
  );

  if (Array.isArray(gate.reasons) && gate.reasons.length) {
    lines.push('Gate reasons: ' + gate.reasons.join(', '));
  }

  lines.push('Recent:');
  if (!status.recent.length) {
    lines.push('  - no predictions');
  } else {
    for (const row of status.recent) {
      const result = row.actual
        ? row.prediction + ' -> ' + row.actual
        : row.prediction + ' -> pending';
      lines.push(
        '  - ' + (row.display_name || row.event_id) +
        ' | ' + (row.league || '-') +
        ' | ' + String(row.kickoff_time || '-') +
        ' | ' + result
      );
    }
  }

  return lines.join('\n');
}

if (require.main === module) {
  buildForwardValidationStatus()
    .then(status => {
      console.log(formatForwardValidationStatus(status));
    })
    .catch(error => {
      console.error(error?.stack || error?.message || error);
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await pool.end();
      } catch {}
    });
}

module.exports = {
  kickoffBucket,
  countValues,
  buildForwardValidationStatus,
  formatForwardValidationStatus
};

