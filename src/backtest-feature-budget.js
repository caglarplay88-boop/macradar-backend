const { buildMlReadyRows, selectStableFeatureNames } = require('./backtest-features');
const { trainNearestCentroid, predictNearestCentroid } = require('./backtest-model');

const LABELS = ['HOME', 'DRAW', 'AWAY'];

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fisherScore(trainRows, featureName) {
  const observed = trainRows
    .map(row => row.features[featureName])
    .filter(v => typeof v === 'number' && Number.isFinite(v));

  if (observed.length < 2) return 0;

  const fill = median(observed);
  const all = trainRows.map(row => {
    const v = row.features[featureName];
    return typeof v === 'number' && Number.isFinite(v) ? v : fill;
  });

  const overall = all.reduce((a, b) => a + b, 0) / all.length;
  let between = 0;
  let within = 0;

  for (const label of LABELS) {
    const values = trainRows
      .map((row, i) => ({ label: row.label_1x2, value: all[i] }))
      .filter(x => x.label === label)
      .map(x => x.value);

    if (!values.length) continue;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    between += values.length * ((mean - overall) ** 2);
    within += values.reduce((a, v) => a + ((v - mean) ** 2), 0);
  }

  if (!Number.isFinite(between) || !Number.isFinite(within)) return 0;
  if (within === 0) return between > 0 ? Number.POSITIVE_INFINITY : 0;
  return between / within;
}

function rankFeatureNames(trainRows, featureNames) {
  return featureNames
    .map(name => ({ name, score: fisherScore(trainRows, name) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function evaluateWalkForwardFeatureBudgets(rows, {
  minTrainSize = 10,
  minPresenceRatio = 0.5,
  minUniqueValues = 2,
  budgets = [25, 50, 100, 250, 500]
} = {}) {
  if (!Array.isArray(rows) || rows.length <= minTrainSize) {
    throw new Error('Feature budget değerlendirmesi için yeterli satır gerekli.');
  }

  const safeBudgets = [...new Set(
    budgets.map(Number).filter(v => Number.isInteger(v) && v > 0)
  )].sort((a, b) => a - b);

  if (!safeBudgets.length) {
    throw new Error('En az bir geçerli feature budget gerekli.');
  }

  const sorted = rows.slice().sort((a, b) => {
    const ams = Date.parse(a?.reference_at);
    const bms = Date.parse(b?.reference_at);
    if (!Number.isFinite(ams) || !Number.isFinite(bms)) {
      throw new Error('Geçerli reference_at gerekli.');
    }
    return ams - bms || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });

  const predictionsByBudget = Object.fromEntries(
    safeBudgets.map(k => [k, []])
  );

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

    const stable = selectStableFeatureNames(
      { feature_names: prepared.feature_names, rows: trainPrepared },
      { minPresenceRatio, minUniqueValues }
    );

    const ranked = rankFeatureNames(trainPrepared, stable);

    for (const budget of safeBudgets) {
      const selected = ranked.slice(0, budget).map(x => x.name);
      if (!selected.length) continue;

      const model = trainNearestCentroid(trainPrepared, selected);

      for (let i = 0; i < testPrepared.length; i++) {
        const predicted = predictNearestCentroid(model, testPrepared[i]);
        predictionsByBudget[budget].push({
          event_id: rawTest[i].event_id,
          reference_at: rawTest[i].reference_at,
          actual: testPrepared[i].label_1x2,
          predicted: predicted.label,
          correct: predicted.label === testPrepared[i].label_1x2,
          train_size: rawTrain.length,
          stable_feature_count: stable.length,
          ranked_feature_count: ranked.length,
          feature_count: selected.length
        });
      }
    }

    index = end;
  }

  return {
    evaluator: 'walk-forward-fisher-ranked-nearest-centroid',
    results: safeBudgets.map(budget => {
      const predictions = predictionsByBudget[budget];
      const correct = predictions.filter(x => x.correct).length;
      const total = predictions.length;

      return {
        budget,
        total,
        correct,
        accuracy: total ? correct / total : null,
        predictions
      };
    })
  };
}

module.exports = {
  fisherScore,
  rankFeatureNames,
  evaluateWalkForwardFeatureBudgets
};

