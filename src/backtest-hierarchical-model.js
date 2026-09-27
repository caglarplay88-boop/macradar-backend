const { buildMlReadyRows } = require('./backtest-features');
const { buildHistoricalStabilitySets } = require('./backtest-stable-model');

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function prepareStats(rows, featureNames) {
  const stats = {};
  for (const name of featureNames) {
    const values = rows
      .map(r => r.features[name])
      .filter(v => typeof v === 'number' && Number.isFinite(v));
    const med = median(values);
    const filled = rows.map(r => {
      const v = r.features[name];
      return typeof v === 'number' && Number.isFinite(v) ? v : med;
    });
    const mean = filled.reduce((a, b) => a + b, 0) / filled.length;
    const variance = filled.reduce((a, v) => a + ((v - mean) ** 2), 0) / filled.length;
    stats[name] = { median: med, mean, scale: Math.sqrt(variance) || 1 };
  }
  return stats;
}

function vectorize(row, featureNames, stats) {
  return featureNames.map(name => {
    const s = stats[name];
    const raw = row.features[name];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : s.median;
    return (value - s.mean) / s.scale;
  });
}

function centroid(rows, featureNames, stats) {
  if (!rows.length) return null;
  const sum = Array(featureNames.length).fill(0);
  for (const row of rows) {
    const v = vectorize(row, featureNames, stats);
    for (let i = 0; i < v.length; i++) sum[i] += v[i];
  }
  return sum.map(x => x / rows.length);
}

function distance(vector, center) {
  if (!center || !center.length) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const d = vector[i] - center[i];
    sum += d * d;
  }
  return sum / vector.length;
}

function trainHierarchicalCentroid(trainRows, featureNames) {
  const stats = prepareStats(trainRows, featureNames);

  const drawRows = trainRows.filter(r => r.label_1x2 === 'DRAW');
  const nonDrawRows = trainRows.filter(r => r.label_1x2 === 'HOME' || r.label_1x2 === 'AWAY');
  const homeRows = trainRows.filter(r => r.label_1x2 === 'HOME');
  const awayRows = trainRows.filter(r => r.label_1x2 === 'AWAY');

  if (!drawRows.length || !nonDrawRows.length || !homeRows.length || !awayRows.length) {
    throw new Error('Hierarchical centroid için tüm sınıflarda train örneği gerekli.');
  }

  return {
    featureNames,
    stats,
    drawCentroid: centroid(drawRows, featureNames, stats),
    nonDrawCentroid: centroid(nonDrawRows, featureNames, stats),
    homeCentroid: centroid(homeRows, featureNames, stats),
    awayCentroid: centroid(awayRows, featureNames, stats)
  };
}

function predictHierarchicalCentroid(model, row) {
  const v = vectorize(row, model.featureNames, model.stats);

  const drawDistance = distance(v, model.drawCentroid);
  const nonDrawDistance = distance(v, model.nonDrawCentroid);

  if (drawDistance < nonDrawDistance) {
    return {
      label: 'DRAW',
      drawDistance,
      nonDrawDistance,
      homeDistance: null,
      awayDistance: null
    };
  }

  const homeDistance = distance(v, model.homeCentroid);
  const awayDistance = distance(v, model.awayCentroid);

  return {
    label: homeDistance <= awayDistance ? 'HOME' : 'AWAY',
    drawDistance,
    nonDrawDistance,
    homeDistance,
    awayDistance
  };
}

function evaluateWalkForwardHierarchicalStable(rows, {
  minTrainSize = 15,
  topK = 50,
  checkpointCount = 3,
  minCheckpointTrain = 8,
  minPresenceRatio = 0.5,
  minUniqueValues = 2,
  majorityRatio = 0.6
} = {}) {
  if (!Array.isArray(rows) || rows.length <= minTrainSize) {
    throw new Error('Hierarchical walk-forward için yeterli satır gerekli.');
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
      .filter(r => Date.parse(r.reference_at) < testMs);

    if (rawTrain.length < minTrainSize) {
      index++;
      continue;
    }

    let end = index;
    while (
      end < sorted.length &&
      Date.parse(sorted[end].reference_at) === testMs
    ) end++;

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

    const model = trainHierarchicalCentroid(trainPrepared, selected);

    for (let i = 0; i < testPrepared.length; i++) {
      const result = predictHierarchicalCentroid(model, testPrepared[i]);
      predictions.push({
        event_id: rawTest[i].event_id,
        reference_at: rawTest[i].reference_at,
        actual: testPrepared[i].label_1x2,
        predicted: result.label,
        correct: result.label === testPrepared[i].label_1x2,
        train_size: rawTrain.length,
        feature_count: selected.length,
        draw_distance: result.drawDistance,
        non_draw_distance: result.nonDrawDistance,
        home_distance: result.homeDistance,
        away_distance: result.awayDistance
      });
    }

    index = end;
  }

  const correct = predictions.filter(x => x.correct).length;
  return {
    model: 'hierarchical-draw-vs-nondraw-nearest-centroid',
    total: predictions.length,
    correct,
    accuracy: predictions.length ? correct / predictions.length : null,
    predictions
  };
}

module.exports = {
  trainHierarchicalCentroid,
  predictHierarchicalCentroid,
  evaluateWalkForwardHierarchicalStable
};

