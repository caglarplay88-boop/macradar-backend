const { buildMlReadyRows } = require('./backtest-features');
const { trainNearestCentroid, predictNearestCentroid } = require('./backtest-model');
const { rankFeatureNames } = require('./backtest-feature-budget');
const {
  selectTrainOnlyDeltaDefinitions,
  buildDeltaRows
} = require('./backtest-cross-league-delta');

function evaluateWalkForwardDeltaBudgets(rows, {
  minTrainSize = 15,
  minOverallPresence = 0.95,
  minLeagueCoverage = 1.0,
  budgets = [3, 6, 9, 12]
} = {}) {
  if (!Array.isArray(rows) || rows.length <= minTrainSize) {
    throw new Error('Delta budget walk-forward için yeterli satır gerekli.');
  }

  const normalizedBudgets = [...new Set(
    budgets.map(Number).filter(v => Number.isInteger(v) && v > 0)
  )].sort((a, b) => a - b);

  if (!normalizedBudgets.length) {
    throw new Error('En az bir geçerli delta budget gerekli.');
  }

  const sorted = rows.slice().sort((a, b) => {
    const ams = Date.parse(a?.reference_at);
    const bms = Date.parse(b?.reference_at);
    if (!Number.isFinite(ams) || !Number.isFinite(bms)) {
      throw new Error('Geçerli reference_at gerekli.');
    }
    return ams - bms || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });

  const predictions = Object.fromEntries(normalizedBudgets.map(b => [b, []]));
  const featureStats = new Map();
  let index = Number(minTrainSize);

  while (index < sorted.length) {
    const testMs = Date.parse(sorted[index].reference_at);
    let groupStart = index;

    while (
      groupStart > 0 &&
      Date.parse(sorted[groupStart - 1].reference_at) === testMs
    ) groupStart--;

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
    const defs = selectTrainOnlyDeltaDefinitions(rawTrain, {
      minOverallPresence,
      minLeagueCoverage
    });

    if (!defs.length) {
      index = end;
      continue;
    }

    const prepared = buildMlReadyRows([...rawTrain, ...rawTest]);
    const trainPrepared = prepared.rows.slice(0, rawTrain.length);
    const testPrepared = prepared.rows.slice(rawTrain.length);
    const trainDelta = buildDeltaRows(trainPrepared, defs);
    const testDelta = buildDeltaRows(testPrepared, defs);

    const ranked = rankFeatureNames(trainDelta, defs.map(x => x.name));

    ranked.forEach((item, rank) => {
      const stat = featureStats.get(item.name) || {
        name: item.name,
        appearances: 0,
        ranks: [],
        scores: []
      };
      stat.appearances++;
      stat.ranks.push(rank + 1);
      stat.scores.push(item.score);
      featureStats.set(item.name, stat);
    });

    for (const budget of normalizedBudgets) {
      const selected = ranked.slice(0, Math.min(budget, ranked.length)).map(x => x.name);
      if (!selected.length) continue;

      const model = trainNearestCentroid(trainDelta, selected);

      for (let i = 0; i < testDelta.length; i++) {
        const result = predictNearestCentroid(model, testDelta[i]);
        predictions[budget].push({
          event_id: rawTest[i].event_id,
          reference_at: rawTest[i].reference_at,
          actual: testDelta[i].label_1x2,
          predicted: result.label,
          correct: result.label === testDelta[i].label_1x2,
          train_size: rawTrain.length,
          feature_count: selected.length
        });
      }
    }

    index = end;
  }

  const summarize = list => {
    const correct = list.filter(x => x.correct).length;
    return {
      total: list.length,
      correct,
      accuracy: list.length ? correct / list.length : null,
      predictions: list
    };
  };

  const median = values => {
    if (!values.length) return null;
    const sortedValues = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sortedValues.length / 2);
    return sortedValues.length % 2
      ? sortedValues[mid]
      : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
  };

  const featureRanking = [...featureStats.values()]
    .map(x => ({
      name: x.name,
      appearances: x.appearances,
      median_rank: median(x.ranks),
      best_rank: Math.min(...x.ranks),
      worst_rank: Math.max(...x.ranks),
      median_score: median(x.scores)
    }))
    .sort((a, b) =>
      a.median_rank - b.median_rank ||
      b.appearances - a.appearances ||
      a.name.localeCompare(b.name)
    );

  return {
    model: 'train-only-cross-league-delta-budget-ablation',
    budgets: Object.fromEntries(
      normalizedBudgets.map(b => [b, summarize(predictions[b])])
    ),
    feature_ranking: featureRanking
  };
}

module.exports = {
  evaluateWalkForwardDeltaBudgets
};

