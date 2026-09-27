function finiteMetric(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function evaluateCandidateEligibility(name, metrics, baseline, {
  minDrawRecall = 0.20,
  requireBaselineAccuracy = true,
  requireBaselineBalancedAccuracy = true
} = {}) {
  if (!metrics || !baseline) {
    throw new Error('Aday ve baseline metrikleri gerekli.');
  }

  const drawRecall = metrics?.per_class?.DRAW?.recall;
  const accuracy = metrics?.accuracy;
  const balancedAccuracy = metrics?.balanced_accuracy;

  if (![drawRecall, accuracy, balancedAccuracy].every(finiteMetric)) {
    return {
      name,
      eligible: false,
      reasons: ['missing-required-metrics'],
      metrics: {
        draw_recall: drawRecall ?? null,
        accuracy: accuracy ?? null,
        balanced_accuracy: balancedAccuracy ?? null
      }
    };
  }

  const reasons = [];

  if (drawRecall < minDrawRecall) {
    reasons.push('draw-recall-below-minimum');
  }
  if (requireBaselineAccuracy && accuracy < baseline.accuracy) {
    reasons.push('accuracy-below-baseline');
  }
  if (
    requireBaselineBalancedAccuracy &&
    balancedAccuracy < baseline.balanced_accuracy
  ) {
    reasons.push('balanced-accuracy-below-baseline');
  }

  return {
    name,
    eligible: reasons.length === 0,
    reasons,
    metrics: {
      draw_recall: drawRecall,
      accuracy,
      balanced_accuracy: balancedAccuracy,
      macro_f1: metrics.macro_f1 ?? null
    }
  };
}

function selectBacktestCandidate({
  baseline,
  candidates,
  policy = {}
}) {
  if (!baseline || !finiteMetric(baseline.accuracy) ||
      !finiteMetric(baseline.balanced_accuracy)) {
    throw new Error('Geçerli baseline metrikleri gerekli.');
  }

  const entries = Object.entries(candidates || {});
  if (!entries.length) {
    throw new Error('En az bir model adayı gerekli.');
  }

  const evaluated = entries.map(([name, metrics]) =>
    evaluateCandidateEligibility(name, metrics, baseline, policy)
  );

  const eligible = evaluated.filter(x => x.eligible);

  eligible.sort((a, b) =>
    b.metrics.balanced_accuracy - a.metrics.balanced_accuracy ||
    (b.metrics.macro_f1 ?? -Infinity) - (a.metrics.macro_f1 ?? -Infinity) ||
    b.metrics.accuracy - a.metrics.accuracy ||
    a.name.localeCompare(b.name)
  );

  return {
    policy: {
      min_draw_recall: policy.minDrawRecall ?? 0.20,
      require_baseline_accuracy: policy.requireBaselineAccuracy ?? true,
      require_baseline_balanced_accuracy:
        policy.requireBaselineBalancedAccuracy ?? true,
      tie_break_order: [
        'balanced_accuracy',
        'macro_f1',
        'accuracy',
        'name'
      ]
    },
    baseline: {
      accuracy: baseline.accuracy,
      balanced_accuracy: baseline.balanced_accuracy,
      macro_f1: baseline.macro_f1 ?? null,
      draw_recall: baseline?.per_class?.DRAW?.recall ?? null
    },
    candidates: evaluated,
    selected: eligible[0] || null,
    eligible_count: eligible.length
  };
}

module.exports = {
  evaluateCandidateEligibility,
  selectBacktestCandidate
};

