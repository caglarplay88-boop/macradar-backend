const { buildMlReadyRows } = require('./backtest-features');
const { trainNearestCentroid, predictNearestCentroid } = require('./backtest-model');
const { buildHistoricalStabilitySets } = require('./backtest-stable-model');

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function classMean(rows, featureName, label) {
  const values = rows
    .filter(row => row.label_1x2 === label)
    .map(row => row.features[featureName])
    .filter(finiteNumber);
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pooledStd(rows, featureName) {
  const values = rows
    .map(row => row.features[featureName])
    .filter(finiteNumber);
  if (values.length < 2) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, v) => a + ((v - mean) ** 2), 0) / values.length;
  const std = Math.sqrt(variance);
  return std > 0 ? std : null;
}

function drawSeparationScores(trainRows, featureNames) {
  return featureNames
    .map(name => {
      const draw = classMean(trainRows, name, 'DRAW');
      const home = classMean(trainRows, name, 'HOME');
      const away = classMean(trainRows, name, 'AWAY');
      const scale = pooledStd(trainRows, name);

      if (![draw, home, away, scale].every(v => v !== null && Number.isFinite(v))) {
        return null;
      }

      const nonDrawMean = (home + away) / 2;
      const score = Math.abs(draw - nonDrawMean) / scale;

      return {
        name,
        score,
        draw_mean: draw,
        home_mean: home,
        away_mean: away
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function evaluateDrawDiagnostics(rows, {
  minTrainSize = 15,
  topK = 50,
  checkpointCount = 3,
  minCheckpointTrain = 8,
  minPresenceRatio = 0.5,
  minUniqueValues = 2,
  majorityRatio = 0.6,
  separationTopK = 20
} = {}) {
  if (!Array.isArray(rows) || rows.length <= minTrainSize) {
    throw new Error('DRAW diagnostic için yeterli satır gerekli.');
  }

  const sorted = rows.slice().sort((a, b) => {
    const ams = Date.parse(a?.reference_at);
    const bms = Date.parse(b?.reference_at);
    if (!Number.isFinite(ams) || !Number.isFinite(bms)) {
      throw new Error('Geçerli reference_at gerekli.');
    }
    return ams - bms || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });

  const predictions = [];
  const featureAppearances = new Map();
  let index = Number(minTrainSize);

  while (index < sorted.length) {
    const testMs = Date.parse(sorted[index].reference_at);
    let groupStart = index;
    while (
      groupStart > 0 &&
      Date.parse(sorted[groupStart - 1].reference_at) === testMs
    ) {
      groupStart--;
    }

    const rawTrain = sorted.slice(0, groupStart)
      .filter(row => Date.parse(row.reference_at) < testMs);

    if (rawTrain.length < minTrainSize) {
      index++;
      continue;
    }

    let end = index;
    while (
      end < sorted.length &&
      Date.parse(sorted[end].reference_at) === testMs
    ) {
      end++;
    }

    const rawTest = sorted.slice(index, end);
    const sets = buildHistoricalStabilitySets(rawTrain, {
      topK,
      checkpointCount,
      minCheckpointTrain,
      minPresenceRatio,
      minUniqueValues,
      majorityRatio
    });

    const prepared = buildMlReadyRows([...rawTrain, ...rawTest]);
    const trainPrepared = prepared.rows.slice(0, rawTrain.length);
    const testPrepared = prepared.rows.slice(rawTrain.length);
    const selected = sets.majority.filter(name => prepared.feature_names.includes(name));

    if (!selected.length) {
      index = end;
      continue;
    }

    const model = trainNearestCentroid(trainPrepared, selected);
    const separation = drawSeparationScores(trainPrepared, selected).slice(0, separationTopK);

    for (const item of separation) {
      const current = featureAppearances.get(item.name) || { count: 0, scores: [] };
      current.count++;
      current.scores.push(item.score);
      featureAppearances.set(item.name, current);
    }

    for (let i = 0; i < testPrepared.length; i++) {
      const result = predictNearestCentroid(model, testPrepared[i]);
      const ordered = Object.entries(result.distances)
        .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
      const drawDistance = result.distances.DRAW ?? null;
      const bestNonDraw = Math.min(
        result.distances.HOME ?? Number.POSITIVE_INFINITY,
        result.distances.AWAY ?? Number.POSITIVE_INFINITY
      );

      predictions.push({
        event_id: rawTest[i].event_id,
        reference_at: rawTest[i].reference_at,
        actual: testPrepared[i].label_1x2,
        predicted: result.label,
        train_size: rawTrain.length,
        feature_count: selected.length,
        draw_rank: ordered.findIndex(x => x[0] === 'DRAW') + 1,
        draw_distance: drawDistance,
        best_non_draw_distance: bestNonDraw,
        draw_margin_vs_best_non_draw:
          finiteNumber(drawDistance) && finiteNumber(bestNonDraw)
            ? drawDistance - bestNonDraw
            : null
      });
    }

    index = end;
  }

  const drawActual = predictions.filter(x => x.actual === 'DRAW');
  const nonDrawActual = predictions.filter(x => x.actual !== 'DRAW');

  const avg = (items, key) => {
    const values = items.map(x => x[key]).filter(finiteNumber);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };

  const stableDrawFeatures = [...featureAppearances.entries()]
    .map(([name, value]) => ({
      name,
      appearances: value.count,
      median_score: value.scores.slice().sort((a, b) => a - b)[Math.floor(value.scores.length / 2)]
    }))
    .sort((a, b) => b.appearances - a.appearances || b.median_score - a.median_score || a.name.localeCompare(b.name));

  return {
    meta: {
      row_count: sorted.length,
      prediction_count: predictions.length,
      draw_actual_count: drawActual.length
    },
    draw_actual: {
      predicted_draw: drawActual.filter(x => x.predicted === 'DRAW').length,
      avg_draw_rank: avg(drawActual, 'draw_rank'),
      avg_draw_margin_vs_best_non_draw: avg(drawActual, 'draw_margin_vs_best_non_draw')
    },
    non_draw_actual: {
      predicted_draw: nonDrawActual.filter(x => x.predicted === 'DRAW').length,
      avg_draw_rank: avg(nonDrawActual, 'draw_rank'),
      avg_draw_margin_vs_best_non_draw: avg(nonDrawActual, 'draw_margin_vs_best_non_draw')
    },
    stable_draw_separation_features: stableDrawFeatures,
    predictions
  };
}

module.exports = {
  drawSeparationScores,
  evaluateDrawDiagnostics
};

