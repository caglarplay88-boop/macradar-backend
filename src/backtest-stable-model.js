const { buildMlReadyRows, selectStableFeatureNames } = require('./backtest-features');
const { rankFeatureNames } = require('./backtest-feature-budget');
const { trainNearestCentroid, predictNearestCentroid } = require('./backtest-model');

function buildHistoricalStabilitySets(rawTrain, {
  topK = 50,
  checkpointCount = 3,
  minCheckpointTrain = 8,
  minPresenceRatio = 0.5,
  minUniqueValues = 2,
  majorityRatio = 0.6
} = {}) {
  if (!Array.isArray(rawTrain) || rawTrain.length <= minCheckpointTrain) {
    return { all: [], majority: [], folds: 0 };
  }

  const sorted = rawTrain.slice().sort((a, b) => {
    const ams = Date.parse(a?.reference_at);
    const bms = Date.parse(b?.reference_at);
    return ams - bms || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });

  const maxTrain = sorted.length;
  const checkpoints = [];
  for (let i = 0; i < checkpointCount; i++) {
    const target = Math.round(
      minCheckpointTrain +
      ((maxTrain - minCheckpointTrain) * i / Math.max(1, checkpointCount - 1))
    );
    if (target >= minCheckpointTrain && !checkpoints.includes(target)) {
      checkpoints.push(target);
    }
  }

  const appearances = new Map();
  let folds = 0;

  for (const requested of checkpoints) {
    const subset = sorted.slice(0, requested);
    if (subset.length < minCheckpointTrain) continue;

    const prepared = buildMlReadyRows(subset);
    const stable = selectStableFeatureNames(prepared, {
      minPresenceRatio,
      minUniqueValues
    });
    const ranked = rankFeatureNames(prepared.rows, stable)
      .slice(0, topK)
      .map(x => x.name);

    if (!ranked.length) continue;
    folds++;

    for (const name of ranked) {
      appearances.set(name, (appearances.get(name) || 0) + 1);
    }
  }

  if (!folds) return { all: [], majority: [], folds: 0 };

  const all = [...appearances.entries()]
    .filter(([, count]) => count === folds)
    .map(([name]) => name)
    .sort();

  const majority = [...appearances.entries()]
    .filter(([, count]) => count / folds >= majorityRatio)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name]) => name);

  return { all, majority, folds };
}

function evaluateWalkForwardStableFeatureSets(rows, {
  minTrainSize = 15,
  topK = 50,
  checkpointCount = 3,
  minCheckpointTrain = 8,
  minPresenceRatio = 0.5,
  minUniqueValues = 2,
  majorityRatio = 0.6
} = {}) {
  if (!Array.isArray(rows) || rows.length <= minTrainSize) {
    throw new Error('Stability walk-forward için yeterli satır gerekli.');
  }

  const sorted = rows.slice().sort((a, b) => {
    const ams = Date.parse(a?.reference_at);
    const bms = Date.parse(b?.reference_at);
    if (!Number.isFinite(ams) || !Number.isFinite(bms)) {
      throw new Error('Geçerli reference_at gerekli.');
    }
    return ams - bms || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });

  const predictions = { all: [], majority: [] };
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

    for (const key of ['all', 'majority']) {
      const selected = sets[key].filter(name =>
        prepared.feature_names.includes(name)
      );

      if (!selected.length) continue;
      const model = trainNearestCentroid(trainPrepared, selected);

      for (let i = 0; i < testPrepared.length; i++) {
        const result = predictNearestCentroid(model, testPrepared[i]);
        predictions[key].push({
          event_id: rawTest[i].event_id,
          reference_at: rawTest[i].reference_at,
          actual: testPrepared[i].label_1x2,
          predicted: result.label,
          correct: result.label === testPrepared[i].label_1x2,
          train_size: rawTrain.length,
          feature_count: selected.length,
          stability_folds: sets.folds
        });
      }
    }

    index = end;
  }

  const summarize = list => ({
    total: list.length,
    correct: list.filter(x => x.correct).length,
    accuracy: list.length
      ? list.filter(x => x.correct).length / list.length
      : null,
    min_feature_count: list.length
      ? Math.min(...list.map(x => x.feature_count))
      : null,
    max_feature_count: list.length
      ? Math.max(...list.map(x => x.feature_count))
      : null,
    predictions: list
  });

  return {
    evaluator: 'walk-forward-historical-stability-nearest-centroid',
    all_folds_stable: summarize(predictions.all),
    majority_stable: summarize(predictions.majority)
  };
}

module.exports = {
  buildHistoricalStabilitySets,
  evaluateWalkForwardStableFeatureSets
};

