function summarizeLabelCounts(rows) {
  const counts = { HOME: 0, DRAW: 0, AWAY: 0, OTHER: 0 };
  for (const row of rows || []) {
    const label = row?.label_1x2;
    if (label === 'HOME' || label === 'DRAW' || label === 'AWAY') counts[label]++;
    else counts.OTHER++;
  }
  return counts;
}

function majorityLabel(rows) {
  const counts = summarizeLabelCounts(rows);
  const ranked = ['HOME', 'DRAW', 'AWAY']
    .map(label => ({ label, count: counts[label] }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  if (!ranked[0] || ranked[0].count === 0) {
    throw new Error('Baseline için etiketli train satırı gerekli.');
  }

  return ranked[0].label;
}

function evaluateMajorityBaseline(split) {
  if (!split || !Array.isArray(split.train) || !Array.isArray(split.test)) {
    throw new Error('Geçerli temporal split gerekli.');
  }
  if (split.train.length === 0 || split.test.length === 0) {
    throw new Error('Train ve test satırları gerekli.');
  }

  const prediction = majorityLabel(split.train);
  let correct = 0;

  const predictions = split.test.map(row => {
    const actual = row.label_1x2;
    const isCorrect = actual === prediction;
    if (isCorrect) correct++;

    return {
      event_id: row.event_id,
      actual,
      predicted: prediction,
      correct: isCorrect
    };
  });

  const total = predictions.length;

  return {
    baseline: 'train-majority-class',
    predicted_label: prediction,
    train_label_counts: summarizeLabelCounts(split.train),
    test_label_counts: summarizeLabelCounts(split.test),
    total,
    correct,
    accuracy: total ? correct / total : null,
    predictions
  };
}

function evaluateWalkForwardMajority(rows, {
  minTrainSize = 10
} = {}) {
  if (!Array.isArray(rows)) {
    throw new Error('Walk-forward rows dizisi gerekli.');
  }

  const safeMinTrain = Number(minTrainSize);
  if (!Number.isInteger(safeMinTrain) || safeMinTrain < 1) {
    throw new Error('minTrainSize pozitif tam sayı olmalı.');
  }
  if (rows.length <= safeMinTrain) {
    throw new Error('Walk-forward baseline için yeterli satır gerekli.');
  }

  const sorted = rows.slice().sort((a, b) => {
    const ams = Date.parse(a?.reference_at);
    const bms = Date.parse(b?.reference_at);
    if (!Number.isFinite(ams) || !Number.isFinite(bms)) {
      throw new Error('Walk-forward için geçerli reference_at gerekli.');
    }
    return ams - bms || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });

  const predictions = [];
  let index = safeMinTrain;

  while (index < sorted.length) {
    const testMs = Date.parse(sorted[index].reference_at);

    let groupStart = index;
    while (
      groupStart > 0 &&
      Date.parse(sorted[groupStart - 1].reference_at) === testMs
    ) {
      groupStart--;
    }

    const train = sorted.filter((row, i) =>
      i < groupStart && Date.parse(row.reference_at) < testMs
    );

    if (!train.length) {
      index++;
      continue;
    }

    const prediction = majorityLabel(train);
    let end = index;
    while (
      end < sorted.length &&
      Date.parse(sorted[end].reference_at) === testMs
    ) {
      const row = sorted[end];
      predictions.push({
        event_id: row.event_id,
        reference_at: row.reference_at,
        actual: row.label_1x2,
        predicted: prediction,
        correct: row.label_1x2 === prediction,
        train_size: train.length
      });
      end++;
    }

    index = end;
  }

  const correct = predictions.filter(x => x.correct).length;
  const total = predictions.length;

  return {
    baseline: 'walk-forward-train-majority-class',
    min_train_size: safeMinTrain,
    total,
    correct,
    accuracy: total ? correct / total : null,
    predictions
  };
}

module.exports = {
  summarizeLabelCounts,
  majorityLabel,
  evaluateMajorityBaseline,
  evaluateWalkForwardMajority
};

