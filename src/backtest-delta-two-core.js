const { buildMlReadyRows } = require('./backtest-features');
const { trainNearestCentroid, predictNearestCentroid } = require('./backtest-model');
const { rankFeatureNames } = require('./backtest-feature-budget');
const {
  selectTrainOnlyDeltaDefinitions,
  buildDeltaRows
} = require('./backtest-cross-league-delta');

const FIXED_CORE_PAIRS = [
  [
    'features__deplasmanTakimi__son10__sonuc__deplasman__attigi',
    'features__evTakimi__son10__sonuc__deplasman__attigi'
  ],
  [
    'features__deplasmanTakimi__son10__sonuc__attigiGol',
    'features__evTakimi__son10__sonuc__attigiGol'
  ]
];

function pairKey(a, b) {
  return [a, b].sort().join('||');
}

function selectTwoCorePlusDynamicThird(rawTrain, {
  minOverallPresence = 0.95,
  minLeagueCoverage = 1.0
} = {}) {
  const defs = selectTrainOnlyDeltaDefinitions(rawTrain, {
    minOverallPresence,
    minLeagueCoverage
  });

  const prepared = buildMlReadyRows(rawTrain);
  const deltaRows = buildDeltaRows(prepared.rows, defs);
  const ranked = rankFeatureNames(deltaRows, defs.map(x => x.name));
  const defByName = Object.fromEntries(defs.map(d => [d.name, d]));

  const coreKeys = new Set(FIXED_CORE_PAIRS.map(([a,b]) => pairKey(a,b)));
  const fixed = defs.filter(d => coreKeys.has(pairKey(d.left, d.right)));

  if (fixed.length !== 2) {
    return {
      selected: [],
      fixed_found: fixed.length,
      dynamic: null,
      ranked
    };
  }

  const fixedNames = new Set(fixed.map(x => x.name));
  const dynamicRanked = ranked.find(item => !fixedNames.has(item.name));
  if (!dynamicRanked) {
    return {
      selected: [],
      fixed_found: fixed.length,
      dynamic: null,
      ranked
    };
  }

  const dynamic = defByName[dynamicRanked.name];
  const selected = [...fixed, dynamic];

  return {
    selected,
    fixed_found: fixed.length,
    dynamic,
    dynamic_rank: ranked.findIndex(x => x.name === dynamic.name) + 1,
    ranked
  };
}

function evaluateWalkForwardTwoCorePlusThird(rows, {
  minTrainSize = 15,
  minOverallPresence = 0.95,
  minLeagueCoverage = 1.0
} = {}) {
  if (!Array.isArray(rows) || rows.length <= minTrainSize) {
    throw new Error('Two-core delta walk-forward için yeterli satır gerekli.');
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
  const dynamicUsage = new Map();
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
    const choice = selectTwoCorePlusDynamicThird(rawTrain, {
      minOverallPresence,
      minLeagueCoverage
    });

    if (choice.selected.length !== 3) {
      index = end;
      continue;
    }

    const prepared = buildMlReadyRows([...rawTrain, ...rawTest]);
    const trainPrepared = prepared.rows.slice(0, rawTrain.length);
    const testPrepared = prepared.rows.slice(rawTrain.length);
    const trainDelta = buildDeltaRows(trainPrepared, choice.selected);
    const testDelta = buildDeltaRows(testPrepared, choice.selected);
    const selectedNames = choice.selected.map(x => x.name);
    const model = trainNearestCentroid(trainDelta, selectedNames);

    const dKey = pairKey(choice.dynamic.left, choice.dynamic.right);
    const usage = dynamicUsage.get(dKey) || {
      left: choice.dynamic.left,
      right: choice.dynamic.right,
      folds: 0,
      test_rows: 0
    };
    usage.folds++;
    usage.test_rows += testDelta.length;
    dynamicUsage.set(dKey, usage);

    for (let i = 0; i < testDelta.length; i++) {
      const result = predictNearestCentroid(model, testDelta[i]);
      predictions.push({
        event_id: rawTest[i].event_id,
        reference_at: rawTest[i].reference_at,
        actual: testDelta[i].label_1x2,
        predicted: result.label,
        correct: result.label === testDelta[i].label_1x2,
        train_size: rawTrain.length,
        feature_count: selectedNames.length,
        dynamic_left: choice.dynamic.left,
        dynamic_right: choice.dynamic.right,
        dynamic_rank: choice.dynamic_rank
      });
    }

    index = end;
  }

  const correct = predictions.filter(x => x.correct).length;
  return {
    model: 'two-fixed-core-plus-train-only-dynamic-third-delta',
    fixed_pairs: FIXED_CORE_PAIRS,
    total: predictions.length,
    correct,
    accuracy: predictions.length ? correct / predictions.length : null,
    dynamic_usage: [...dynamicUsage.values()]
      .sort((a,b) => b.folds - a.folds || b.test_rows - a.test_rows || a.left.localeCompare(b.left)),
    predictions
  };
}

module.exports = {
  FIXED_CORE_PAIRS,
  selectTwoCorePlusDynamicThird,
  evaluateWalkForwardTwoCorePlusThird
};

