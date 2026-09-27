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

module.exports = {
  summarizeLabelCounts,
  majorityLabel,
  evaluateMajorityBaseline
};

