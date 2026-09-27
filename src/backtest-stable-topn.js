const { buildMlReadyRows, selectStableFeatureNames } = require('./backtest-features');
const { rankFeatureNames } = require('./backtest-feature-budget');
const { trainNearestCentroid, predictNearestCentroid } = require('./backtest-model');

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function selectTrainOnlyStableTopN(rawTrain, {
  topK = 50,
  maxFeatures = 11,
  checkpointCount = 3,
  minCheckpointTrain = 8,
  minPresenceRatio = 0.5,
  minUniqueValues = 2,
  majorityRatio = 0.6
} = {}) {
  if (!Array.isArray(rawTrain) || rawTrain.length <= minCheckpointTrain) {
    return { features: [], folds: 0 };
  }

  const sorted = rawTrain.slice().sort((a, b) => {
    const ams = Date.parse(a?.reference_at);
    const bms = Date.parse(b?.reference_at);
    return ams - bms || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });

  const checkpoints = [];
  for (let i = 0; i < checkpointCount; i++) {
    const target = Math.round(
      minCheckpointTrain +
      ((sorted.length - minCheckpointTrain) * i / Math.max(1, checkpointCount - 1))
    );
    if (target >= minCheckpointTrain && !checkpoints.includes(target)) {
      checkpoints.push(target);
    }
  }

  const stats = new Map();
  let folds = 0;

  for (const requested of checkpoints) {
    const subset = sorted.slice(0, requested);
    const prepared = buildMlReadyRows(subset);
    const stable = selectStableFeatureNames(prepared, {
      minPresenceRatio,
      minUniqueValues
    });
    const ranked = rankFeatureNames(prepared.rows, stable).slice(0, topK);
    if (!ranked.length) continue;

    folds++;

    ranked.forEach((item, index) => {
      const current = stats.get(item.name) || {
        name: item.name,
        appearances: 0,
        ranks: []
      };
      current.appearances++;
      current.ranks.push(index + 1);
      stats.set(item.name, current);
    });
  }

  if (!folds) return { features: [], folds: 0 };

  const features = [...stats.values()]
    .filter(x => x.appearances / folds >= majorityRatio)
    .map(x => ({
      name: x.name,
      appearances: x.appearances,
      appearance_ratio: x.appearances / folds,
      median_rank: median(x.ranks)
    }))
    .sort((a, b) =>
      b.appearances - a.appearances ||
      a.median_rank - b.median_rank ||
      a.name.localeCompare(b.name)
    )
    .slice(0, maxFeatures);

  return { features, folds };
}

function evaluateWalkForwardStableTopN(rows, {
  minTrainSize = 15,
  topK = 50,
  maxFeatures = 11,
  checkpointCount = 3,
  minCheckpointTrain = 8,
  minPresenceRatio = 0.5,
  minUniqueValues = 2,
  majorityRatio = 0.6
} = {}) {
  if (!Array.isArray(rows) || rows.length <= minTrainSize) {
    throw new Error('Stable top-N walk-forward için yeterli satır gerekli.');
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
    const selectedInfo = selectTrainOnlyStableTopN(rawTrain, {
      topK,
      maxFeatures,
      checkpointCount,
      minCheckpointTrain,
      minPresenceRatio,
      minUniqueValues,
      majorityRatio
    });

    const prepared = buildMlReadyRows([...rawTrain, ...rawTest]);
    const trainPrepared = prepared.rows.slice(0, rawTrain.length);
    const testPrepared = prepared.rows.slice(rawTrain.length);
    const selected = selectedInfo.features
      .map(x => x.name)
      .filter(name => prepared.feature_names.includes(name));

    if (!selected.length) {
      index = end;
      continue;
    }

    const model = trainNearestCentroid(trainPrepared, selected);

    for (let i = 0; i < testPrepared.length; i++) {
      const result = predictNearestCentroid(model, testPrepared[i]);
      predictions.push({
        event_id: rawTest[i].event_id,
        reference_at: rawTest[i].reference_at,
        actual: testPrepared[i].label_1x2,
        predicted: result.label,
        correct: result.label === testPrepared[i].label_1x2,
        train_size: rawTrain.length,
        feature_count: selected.length,
        stability_folds: selectedInfo.folds
      });
    }

    index = end;
  }

  const correct = predictions.filter(x => x.correct).length;
  return {
    model: 'train-only-stable-majority-topn-nearest-centroid',
    max_features: maxFeatures,
    total: predictions.length,
    correct,
    accuracy: predictions.length ? correct / predictions.length : null,
    min_feature_count: predictions.length
      ? Math.min(...predictions.map(x => x.feature_count))
      : null,
    max_feature_count: predictions.length
      ? Math.max(...predictions.map(x => x.feature_count))
      : null,
    predictions
  };
}

module.exports = {
  selectTrainOnlyStableTopN,
  evaluateWalkForwardStableTopN
};

