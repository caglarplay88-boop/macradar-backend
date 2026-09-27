function accuracySummary(predictions) {
  const rows = Array.isArray(predictions) ? predictions : [];
  const correct = rows.filter(x => x.correct).length;
  return {
    total: rows.length,
    correct,
    accuracy: rows.length ? correct / rows.length : null
  };
}

function buildTimeWindows(predictions, windowCount = 3) {
  const rows = Array.isArray(predictions) ? predictions : [];
  const safeCount = Number(windowCount);

  if (!Number.isInteger(safeCount) || safeCount < 2) {
    throw new Error('windowCount en az 2 olmalı.');
  }
  if (!rows.length) {
    throw new Error('Rolling değerlendirme için prediction gerekli.');
  }

  const timestamps = [...new Set(
    rows
      .map(x => new Date(x.reference_at).toISOString())
      .sort((a, b) => Date.parse(a) - Date.parse(b))
  )];

  if (timestamps.length < safeCount) {
    throw new Error('Rolling değerlendirme için yeterli farklı zaman noktası yok.');
  }

  const windows = [];
  for (let i = 0; i < safeCount; i++) {
    const startIndex = Math.floor(i * timestamps.length / safeCount);
    const endIndex = Math.floor((i + 1) * timestamps.length / safeCount) - 1;
    windows.push({
      index: i + 1,
      start: timestamps[startIndex],
      end: timestamps[Math.max(startIndex, endIndex)]
    });
  }

  return windows;
}

function evaluateRollingWindows({
  baseline,
  fullModel,
  budgetResults,
  windowCount = 3
}) {
  if (!baseline || !Array.isArray(baseline.predictions)) {
    throw new Error('Geçerli baseline predictions gerekli.');
  }
  if (!fullModel || !Array.isArray(fullModel.predictions)) {
    throw new Error('Geçerli full model predictions gerekli.');
  }
  if (!Array.isArray(budgetResults) || !budgetResults.length) {
    throw new Error('Feature budget sonuçları gerekli.');
  }

  const baselineIds = baseline.predictions.map(x => x.event_id).join(',');
  const fullIds = fullModel.predictions.map(x => x.event_id).join(',');
  if (baselineIds !== fullIds) {
    throw new Error('Baseline ve full model prediction sırası eşleşmiyor.');
  }

  for (const result of budgetResults) {
    const ids = (result.predictions || []).map(x => x.event_id).join(',');
    if (ids !== baselineIds) {
      throw new Error('Budget prediction sırası baseline ile eşleşmiyor: ' + result.budget);
    }
  }

  const windows = buildTimeWindows(baseline.predictions, windowCount);

  const inWindow = (row, window) => {
    const ms = Date.parse(row.reference_at);
    return ms >= Date.parse(window.start) && ms <= Date.parse(window.end);
  };

  return windows.map(window => ({
    window: window.index,
    start: window.start,
    end: window.end,
    baseline: accuracySummary(
      baseline.predictions.filter(row => inWindow(row, window))
    ),
    full_model: accuracySummary(
      fullModel.predictions.filter(row => inWindow(row, window))
    ),
    budgets: Object.fromEntries(
      budgetResults.map(result => [
        String(result.budget),
        accuracySummary(
          result.predictions.filter(row => inWindow(row, window))
        )
      ])
    )
  }));
}

module.exports = {
  accuracySummary,
  buildTimeWindows,
  evaluateRollingWindows
};

