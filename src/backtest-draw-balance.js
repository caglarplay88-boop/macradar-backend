const { buildMlReadyRows } = require('./backtest-features');
const { buildHistoricalStabilitySets } = require('./backtest-stable-model');
const { trainBinaryDrawLogistic, predictDrawProbability } = require('./backtest-logistic-draw');
const { trainNearestCentroid, predictNearestCentroid } = require('./backtest-model');

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function pairedName(name) {
  if (name.includes('__evTakimi__')) {
    return name.replace('__evTakimi__', '__deplasmanTakimi__');
  }
  if (name.includes('__deplasmanTakimi__')) {
    return name.replace('__deplasmanTakimi__', '__evTakimi__');
  }
  if (name.includes('__home__')) {
    return name.replace('__home__', '__away__');
  }
  if (name.includes('__away__')) {
    return name.replace('__away__', '__home__');
  }
  return null;
}

function canonicalPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function buildBalancePairDefinitions(featureNames) {
  const names = new Set(featureNames);
  const seen = new Set();
  const out = [];

  for (const name of featureNames) {
    if (/xg|xga|understat|expected.?goal/i.test(name)) continue;
    if (!/(goal|score|form|shot|possession|attack|strength|rating|point|win|draw|loss|conced|scored)/i.test(name)) {
      continue;
    }

    const mate = pairedName(name);
    if (!mate || !names.has(mate)) continue;
    const [left, right] = canonicalPair(name, mate);
    const key = left + '||' + right;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      name: 'balance__' + out.length,
      left,
      right
    });
  }

  return out;
}

function buildBalanceRows(rows, definitions) {
  return rows.map(row => {
    const features = {};
    for (const def of definitions) {
      const a = row.features[def.left];
      const b = row.features[def.right];
      features[def.name] = finite(a) && finite(b) ? Math.abs(a - b) : null;
    }
    return {
      event_id: row.event_id,
      engine_version: row.engine_version,
      label_1x2: row.label_1x2,
      features
    };
  });
}

function binarySeparationScore(rows, featureName) {
  const groups = { DRAW: [], NON_DRAW: [] };

  for (const row of rows) {
    const v = row.features[featureName];
    if (!finite(v)) continue;
    groups[row.label_1x2 === 'DRAW' ? 'DRAW' : 'NON_DRAW'].push(v);
  }

  if (!groups.DRAW.length || !groups.NON_DRAW.length) return 0;

  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const drawMean = mean(groups.DRAW);
  const nonDrawMean = mean(groups.NON_DRAW);
  const all = groups.DRAW.concat(groups.NON_DRAW);
  const overall = mean(all);
  const variance = all.reduce((a, v) => a + ((v - overall) ** 2), 0) / all.length;
  const scale = Math.sqrt(variance);

  if (!scale) return 0;
  return Math.abs(drawMean - nonDrawMean) / scale;
}

function selectBalanceFeatures(trainRows, definitions, {
  minPresenceRatio = 0.5,
  topK = 20
} = {}) {
  const ranked = [];

  for (const def of definitions) {
    const present = trainRows.filter(r => finite(r.features[def.name])).length;
    if (present / trainRows.length < minPresenceRatio) continue;

    const score = binarySeparationScore(trainRows, def.name);
    if (!(score > 0)) continue;
    ranked.push({ ...def, score });
  }

  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return ranked.slice(0, topK);
}

function trainHomeAwayCentroid(trainRows, featureNames) {
  const filtered = trainRows.filter(r => r.label_1x2 === 'HOME' || r.label_1x2 === 'AWAY');
  const relabeled = filtered.map(r => ({ ...r }));
  return trainNearestCentroid(relabeled, featureNames);
}

function predictHomeAway(model, row) {
  const result = predictNearestCentroid(model, row);
  const home = result.distances.HOME ?? Number.POSITIVE_INFINITY;
  const away = result.distances.AWAY ?? Number.POSITIVE_INFINITY;
  return home <= away ? 'HOME' : 'AWAY';
}

function evaluateWalkForwardDrawBalance(rows, {
  minTrainSize = 15,
  stableTopK = 50,
  checkpointCount = 3,
  minCheckpointTrain = 8,
  minPresenceRatio = 0.5,
  minUniqueValues = 2,
  majorityRatio = 0.6,
  balanceTopK = 20,
  drawThreshold = 0.5
} = {}) {
  if (!Array.isArray(rows) || rows.length <= minTrainSize) {
    throw new Error('DRAW balance walk-forward için yeterli satır gerekli.');
  }

  const sorted = rows.slice().sort((a, b) => {
    const ams = Date.parse(a?.reference_at);
    const bms = Date.parse(b?.reference_at);
    if (!Number.isFinite(ams) || !Number.isFinite(bms)) throw new Error('Geçerli reference_at gerekli.');
    return ams - bms || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });

  const predictions = [];
  let index = minTrainSize;

  while (index < sorted.length) {
    const testMs = Date.parse(sorted[index].reference_at);
    let groupStart = index;
    while (groupStart > 0 && Date.parse(sorted[groupStart - 1].reference_at) === testMs) groupStart--;

    const rawTrain = sorted.slice(0, groupStart).filter(r => Date.parse(r.reference_at) < testMs);
    if (rawTrain.length < minTrainSize) {
      index++;
      continue;
    }

    let end = index;
    while (end < sorted.length && Date.parse(sorted[end].reference_at) === testMs) end++;
    const rawTest = sorted.slice(index, end);

    const trainDataset = buildMlReadyRows(rawTrain);
    const testDataset = buildMlReadyRows(rawTest);

    const definitions = buildBalancePairDefinitions(trainDataset.feature_names);
    const trainBalance = buildBalanceRows(trainDataset.rows, definitions);
    const testBalance = buildBalanceRows(testDataset.rows, definitions);
    const selectedBalanceDefs = selectBalanceFeatures(trainBalance, definitions, {
      minPresenceRatio,
      topK: balanceTopK
    });
    const balanceNames = selectedBalanceDefs.map(x => x.name);

    const stableSets = buildHistoricalStabilitySets(rawTrain, {
      topK: stableTopK,
      checkpointCount,
      minCheckpointTrain,
      minPresenceRatio,
      minUniqueValues,
      majorityRatio
    });
    const homeAwayNames = stableSets.majority.filter(name => trainDataset.feature_names.includes(name));

    if (!balanceNames.length || !homeAwayNames.length) {
      index = end;
      continue;
    }

    const drawModel = trainBinaryDrawLogistic(trainBalance, balanceNames);
    const homeAwayModel = trainHomeAwayCentroid(trainDataset.rows, homeAwayNames);

    for (let i = 0; i < rawTest.length; i++) {
      const drawProbability = predictDrawProbability(drawModel, testBalance[i]);
      const predicted = drawProbability >= drawThreshold
        ? 'DRAW'
        : predictHomeAway(homeAwayModel, testDataset.rows[i]);

      predictions.push({
        event_id: rawTest[i].event_id,
        reference_at: rawTest[i].reference_at,
        actual: testDataset.rows[i].label_1x2,
        predicted,
        correct: predicted === testDataset.rows[i].label_1x2,
        draw_probability: drawProbability,
        balance_feature_count: balanceNames.length,
        home_away_feature_count: homeAwayNames.length
      });
    }

    index = end;
  }

  const correct = predictions.filter(x => x.correct).length;
  return {
    model: 'draw-balance-logistic-then-stable-home-away-centroid',
    total: predictions.length,
    correct,
    accuracy: predictions.length ? correct / predictions.length : null,
    predictions
  };
}

module.exports = {
  buildBalancePairDefinitions,
  buildBalanceRows,
  binarySeparationScore,
  selectBalanceFeatures,
  evaluateWalkForwardDrawBalance
};

