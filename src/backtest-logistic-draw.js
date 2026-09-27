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

function sigmoid(z) {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function trainBinaryDrawLogistic(trainRows, featureNames, {
  epochs = 250,
  learningRate = 0.05,
  l2 = 0.01
} = {}) {
  if (!trainRows.length || !featureNames.length) {
    throw new Error('Logistic DRAW modeli için train ve feature gerekli.');
  }

  const stats = prepareStats(trainRows, featureNames);
  const X = trainRows.map(r => vectorize(r, featureNames, stats));
  const y = trainRows.map(r => r.label_1x2 === 'DRAW' ? 1 : 0);

  const positive = y.filter(v => v === 1).length;
  const negative = y.length - positive;
  if (!positive || !negative) {
    throw new Error('Binary logistic için DRAW ve NON-DRAW örnekleri gerekli.');
  }

  const posWeight = y.length / (2 * positive);
  const negWeight = y.length / (2 * negative);

  let weights = Array(featureNames.length).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = Array(featureNames.length).fill(0);
    let gradB = 0;

    for (let i = 0; i < X.length; i++) {
      let z = bias;
      for (let j = 0; j < weights.length; j++) z += weights[j] * X[i][j];
      const p = sigmoid(z);
      const sampleWeight = y[i] === 1 ? posWeight : negWeight;
      const err = (p - y[i]) * sampleWeight;

      gradB += err;
      for (let j = 0; j < weights.length; j++) {
        gradW[j] += err * X[i][j];
      }
    }

    const n = X.length;
    bias -= learningRate * (gradB / n);
    for (let j = 0; j < weights.length; j++) {
      const reg = l2 * weights[j];
      weights[j] -= learningRate * ((gradW[j] / n) + reg);
    }
  }

  return { featureNames, stats, weights, bias };
}

function predictDrawProbability(model, row) {
  const x = vectorize(row, model.featureNames, model.stats);
  let z = model.bias;
  for (let i = 0; i < model.weights.length; i++) z += model.weights[i] * x[i];
  return sigmoid(z);
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
  let sum = 0;
  for (let i = 0; i < vector.length; i++) {
    const d = vector[i] - center[i];
    sum += d * d;
  }
  return sum / vector.length;
}

function evaluateWalkForwardLogisticDraw(rows, {
  minTrainSize = 15,
  topK = 50,
  checkpointCount = 3,
  minCheckpointTrain = 8,
  minPresenceRatio = 0.5,
  minUniqueValues = 2,
  majorityRatio = 0.6,
  drawThreshold = 0.5
} = {}) {
  if (!Array.isArray(rows) || rows.length <= minTrainSize) {
    throw new Error('Logistic DRAW walk-forward için yeterli satır gerekli.');
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
    const sets = buildHistoricalStabilitySets(rawTrain, {
      topK, checkpointCount, minCheckpointTrain,
      minPresenceRatio, minUniqueValues, majorityRatio
    });

    const prepared = buildMlReadyRows([...rawTrain, ...rawTest]);
    const trainPrepared = prepared.rows.slice(0, rawTrain.length);
    const testPrepared = prepared.rows.slice(rawTrain.length);
    const selected = sets.majority.filter(name => prepared.feature_names.includes(name));

    if (!selected.length) {
      index = end;
      continue;
    }

    const drawModel = trainBinaryDrawLogistic(trainPrepared, selected);
    const stats = drawModel.stats;
    const homeRows = trainPrepared.filter(r => r.label_1x2 === 'HOME');
    const awayRows = trainPrepared.filter(r => r.label_1x2 === 'AWAY');
    const homeCentroid = centroid(homeRows, selected, stats);
    const awayCentroid = centroid(awayRows, selected, stats);

    for (let i = 0; i < testPrepared.length; i++) {
      const drawProbability = predictDrawProbability(drawModel, testPrepared[i]);
      let predicted;

      if (drawProbability >= drawThreshold) {
        predicted = 'DRAW';
      } else {
        const v = vectorize(testPrepared[i], selected, stats);
        predicted = distance(v, homeCentroid) <= distance(v, awayCentroid) ? 'HOME' : 'AWAY';
      }

      predictions.push({
        event_id: rawTest[i].event_id,
        reference_at: rawTest[i].reference_at,
        actual: testPrepared[i].label_1x2,
        predicted,
        correct: predicted === testPrepared[i].label_1x2,
        draw_probability: drawProbability,
        train_size: rawTrain.length,
        feature_count: selected.length
      });
    }

    index = end;
  }

  const correct = predictions.filter(x => x.correct).length;
  return {
    model: 'balanced-logistic-draw-then-home-away-centroid',
    threshold: drawThreshold,
    total: predictions.length,
    correct,
    accuracy: predictions.length ? correct / predictions.length : null,
    predictions
  };
}

module.exports = {
  trainBinaryDrawLogistic,
  predictDrawProbability,
  evaluateWalkForwardLogisticDraw
};

