const { buildMlReadyRows, selectStableFeatureNames } = require('./backtest-features');

const LABELS = ['HOME', 'DRAW', 'AWAY'];

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function prepareFeatureStats(trainRows, featureNames) {
  const stats = {};

  for (const name of featureNames) {
    const values = trainRows
      .map(row => row.features[name])
      .filter(v => typeof v === 'number' && Number.isFinite(v));

    const med = median(values);
    const filled = trainRows.map(row => {
      const v = row.features[name];
      return typeof v === 'number' && Number.isFinite(v) ? v : med;
    });

    const mean = filled.reduce((a, b) => a + b, 0) / filled.length;
    const variance = filled.reduce((a, v) => a + ((v - mean) ** 2), 0) / filled.length;
    const scale = Math.sqrt(variance) || 1;

    stats[name] = { median: med, mean, scale };
  }

  return stats;
}

function vectorize(row, featureNames, stats) {
  return featureNames.map(name => {
    const raw = row.features[name];
    const s = stats[name];
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : s.median;
    return (value - s.mean) / s.scale;
  });
}

function trainNearestCentroid(trainRows, featureNames) {
  if (!trainRows.length || !featureNames.length) {
    throw new Error('Model eğitimi için train satırı ve feature gerekli.');
  }

  const stats = prepareFeatureStats(trainRows, featureNames);
  const sums = Object.fromEntries(LABELS.map(label => [label, Array(featureNames.length).fill(0)]));
  const counts = Object.fromEntries(LABELS.map(label => [label, 0]));

  for (const row of trainRows) {
    if (!LABELS.includes(row.label_1x2)) continue;
    const vector = vectorize(row, featureNames, stats);
    counts[row.label_1x2]++;
    for (let i = 0; i < vector.length; i++) {
      sums[row.label_1x2][i] += vector[i];
    }
  }

  const centroids = {};
  for (const label of LABELS) {
    if (!counts[label]) continue;
    centroids[label] = sums[label].map(v => v / counts[label]);
  }

  return { featureNames, stats, centroids, counts };
}

function predictNearestCentroid(model, row) {
  const vector = vectorize(row, model.featureNames, model.stats);
  const distances = {};

  for (const [label, centroid] of Object.entries(model.centroids)) {
    let sum = 0;
    for (let i = 0; i < vector.length; i++) {
      const d = vector[i] - centroid[i];
      sum += d * d;
    }
    distances[label] = sum / vector.length;
  }

  const ranked = Object.entries(distances)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));

  return {
    label: ranked[0]?.[0] || null,
    distances
  };
}

function evaluateWalkForwardFeatureModel(rows, {
  minTrainSize = 10,
  minPresenceRatio = 0.5,
  minUniqueValues = 2
} = {}) {
  if (!Array.isArray(rows) || rows.length <= minTrainSize) {
    throw new Error('Feature walk-forward için yeterli satır gerekli.');
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
    const prepared = buildMlReadyRows([...rawTrain, ...rawTest]);
    const trainPrepared = prepared.rows.slice(0, rawTrain.length);
    const testPrepared = prepared.rows.slice(rawTrain.length);

    const featureNames = selectStableFeatureNames(
      { feature_names: prepared.feature_names, rows: trainPrepared },
      { minPresenceRatio, minUniqueValues }
    );

    const model = trainNearestCentroid(trainPrepared, featureNames);

    for (let i = 0; i < testPrepared.length; i++) {
      const predicted = predictNearestCentroid(model, testPrepared[i]);
      predictions.push({
        event_id: rawTest[i].event_id,
        reference_at: rawTest[i].reference_at,
        actual: testPrepared[i].label_1x2,
        predicted: predicted.label,
        correct: predicted.label === testPrepared[i].label_1x2,
        train_size: rawTrain.length,
        feature_count: featureNames.length
      });
    }

    index = end;
  }

  const correct = predictions.filter(x => x.correct).length;
  const total = predictions.length;

  return {
    model: 'standardized-nearest-centroid',
    total,
    correct,
    accuracy: total ? correct / total : null,
    predictions
  };
}

module.exports = {
  trainNearestCentroid,
  predictNearestCentroid,
  evaluateWalkForwardFeatureModel
};

