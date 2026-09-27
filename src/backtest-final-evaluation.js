function confusionMatrix(predictions, labels = ['HOME','DRAW','AWAY']) {
  const matrix = Object.fromEntries(
    labels.map(actual => [actual, Object.fromEntries(labels.map(pred => [pred, 0]))])
  );

  for (const row of predictions || []) {
    if (matrix[row.actual] && Object.prototype.hasOwnProperty.call(matrix[row.actual], row.predicted)) {
      matrix[row.actual][row.predicted]++;
    }
  }
  return matrix;
}

function classificationMetrics(predictions, labels = ['HOME','DRAW','AWAY']) {
  const rows = Array.isArray(predictions) ? predictions : [];
  const matrix = confusionMatrix(rows, labels);

  const perClass = {};
  for (const label of labels) {
    const tp = matrix[label][label];
    const fn = labels.reduce((sum, pred) => pred === label ? sum : sum + matrix[label][pred], 0);
    const fp = labels.reduce((sum, actual) => actual === label ? sum : sum + matrix[actual][label], 0);
    const support = tp + fn;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = support ? tp / support : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

    perClass[label] = { support, tp, fp, fn, precision, recall, f1 };
  }

  const correct = labels.reduce((sum, label) => sum + matrix[label][label], 0);
  const accuracy = rows.length ? correct / rows.length : null;
  const balancedAccuracy = labels.length
    ? labels.reduce((sum, label) => sum + perClass[label].recall, 0) / labels.length
    : null;
  const macroF1 = labels.length
    ? labels.reduce((sum, label) => sum + perClass[label].f1, 0) / labels.length
    : null;

  return {
    total: rows.length,
    correct,
    accuracy,
    balanced_accuracy: balancedAccuracy,
    macro_f1: macroF1,
    per_class: perClass,
    confusion: matrix
  };
}

function buildChronologicalWindows(predictions, windowCount = 3) {
  const rows = Array.isArray(predictions) ? predictions : [];
  if (!rows.length) throw new Error('Rolling final evaluation için prediction gerekli.');
  if (!Number.isInteger(windowCount) || windowCount < 2) {
    throw new Error('windowCount en az 2 olmalı.');
  }

  const times = [...new Set(
    rows.map(row => new Date(row.reference_at).toISOString())
  )].sort((a,b) => Date.parse(a) - Date.parse(b));

  if (times.length < windowCount) {
    throw new Error('Rolling final evaluation için yeterli zaman noktası yok.');
  }

  const windows = [];
  for (let i = 0; i < windowCount; i++) {
    const startIndex = Math.floor(i * times.length / windowCount);
    const endIndex = Math.floor((i + 1) * times.length / windowCount) - 1;
    windows.push({
      window: i + 1,
      start: times[startIndex],
      end: times[Math.max(startIndex, endIndex)]
    });
  }
  return windows;
}

function rollingClassificationMetrics(predictions, windowCount = 3, labels = ['HOME','DRAW','AWAY']) {
  const windows = buildChronologicalWindows(predictions, windowCount);

  return windows.map(window => {
    const start = Date.parse(window.start);
    const end = Date.parse(window.end);
    const rows = predictions.filter(row => {
      const ms = Date.parse(row.reference_at);
      return ms >= start && ms <= end;
    });

    return {
      ...window,
      metrics: classificationMetrics(rows, labels)
    };
  });
}

function compareModels(models, {
  windowCount = 3,
  labels = ['HOME','DRAW','AWAY']
} = {}) {
  const entries = Object.entries(models || {});
  if (!entries.length) throw new Error('Karşılaştırılacak model gerekli.');

  const referenceIds = entries[0][1].map(x => x.event_id).join(',');
  for (const [name, rows] of entries) {
    if (!Array.isArray(rows)) throw new Error(name + ' predictions dizi olmalı.');
    if (rows.map(x => x.event_id).join(',') !== referenceIds) {
      throw new Error('Prediction hizası eşleşmiyor: ' + name);
    }
  }

  return Object.fromEntries(entries.map(([name, rows]) => [
    name,
    {
      overall: classificationMetrics(rows, labels),
      rolling: rollingClassificationMetrics(rows, windowCount, labels)
    }
  ]));
}

module.exports = {
  confusionMatrix,
  classificationMetrics,
  buildChronologicalWindows,
  rollingClassificationMetrics,
  compareModels
};

