const { classificationMetrics } = require('./backtest-final-evaluation');

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const w = pos - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function seededRandom(seed = 1) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function leavePeriodOut(predictions, periodCount = 6) {
  const sorted = predictions.slice().sort((a, b) => {
    const ams = Date.parse(a.reference_at);
    const bms = Date.parse(b.reference_at);
    return ams - bms || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });

  const periods = [];
  for (let p = 0; p < periodCount; p++) {
    const start = Math.floor((sorted.length * p) / periodCount);
    const end = Math.floor((sorted.length * (p + 1)) / periodCount);
    const heldOut = sorted.slice(start, end);
    const kept = sorted.slice(0, start).concat(sorted.slice(end));
    const m = classificationMetrics(kept);
    periods.push({
      period: p + 1,
      held_out_count: heldOut.length,
      held_out_from: heldOut[0]?.reference_at || null,
      held_out_to: heldOut[heldOut.length - 1]?.reference_at || null,
      kept_count: kept.length,
      accuracy: m.accuracy,
      balanced_accuracy: m.balanced_accuracy,
      macro_f1: m.macro_f1,
      draw_recall: m.per_class.DRAW?.recall ?? null
    });
  }

  return periods;
}

function movingBlockBootstrap(predictions, {
  iterations = 500,
  blockLength = 6,
  seed = 325
} = {}) {
  const sorted = predictions.slice().sort((a, b) => {
    const ams = Date.parse(a.reference_at);
    const bms = Date.parse(b.reference_at);
    return ams - bms || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });

  if (!sorted.length) {
    throw new Error('Bootstrap için tahmin gerekli.');
  }

  const rand = seededRandom(seed);
  const samples = [];

  for (let iter = 0; iter < iterations; iter++) {
    const sample = [];
    while (sample.length < sorted.length) {
      const maxStart = Math.max(0, sorted.length - blockLength);
      const start = Math.floor(rand() * (maxStart + 1));
      const block = sorted.slice(start, start + blockLength);
      sample.push(...block);
    }
    sample.length = sorted.length;

    const m = classificationMetrics(sample);
    samples.push({
      accuracy: m.accuracy,
      balanced_accuracy: m.balanced_accuracy,
      macro_f1: m.macro_f1,
      draw_recall: m.per_class.DRAW?.recall ?? null
    });
  }

  const metricSummary = key => {
    const values = samples.map(x => x[key]).filter(Number.isFinite);
    return {
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      p05: quantile(values, 0.05),
      p25: quantile(values, 0.25),
      median: quantile(values, 0.5),
      p75: quantile(values, 0.75),
      p95: quantile(values, 0.95)
    };
  };

  return {
    iterations,
    block_length: blockLength,
    seed,
    accuracy: metricSummary('accuracy'),
    balanced_accuracy: metricSummary('balanced_accuracy'),
    macro_f1: metricSummary('macro_f1'),
    draw_recall: metricSummary('draw_recall')
  };
}

function evaluateTemporalRobustness(predictions, options = {}) {
  const base = classificationMetrics(predictions);
  return {
    base: {
      total: base.total,
      accuracy: base.accuracy,
      balanced_accuracy: base.balanced_accuracy,
      macro_f1: base.macro_f1,
      draw_recall: base.per_class.DRAW?.recall ?? null
    },
    leave_period_out: leavePeriodOut(predictions, options.periodCount || 6),
    moving_block_bootstrap: movingBlockBootstrap(predictions, {
      iterations: options.iterations || 500,
      blockLength: options.blockLength || 6,
      seed: options.seed || 325
    })
  };
}

module.exports = {
  leavePeriodOut,
  movingBlockBootstrap,
  evaluateTemporalRobustness
};

