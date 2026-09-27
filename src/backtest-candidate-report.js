const { evaluateWalkForwardMajority } = require('./backtest-evaluation');
const { evaluateWalkForwardStableFeatureSets } = require('./backtest-stable-model');
const { evaluateWalkForwardHierarchicalStable } = require('./backtest-hierarchical-model');
const { evaluateWalkForwardDrawBalance } = require('./backtest-draw-balance');
const { evaluateWalkForwardTwoCorePlusThird, FIXED_CORE_PAIRS } = require('./backtest-delta-two-core');
const { classificationMetrics, rollingClassificationMetrics } = require('./backtest-final-evaluation');
const { selectBacktestCandidate } = require('./backtest-model-selection');
const { evaluateTemporalRobustness } = require('./backtest-temporal-robustness');

function compactMetrics(metrics) {
  return {
    total: metrics.total,
    accuracy: metrics.accuracy,
    balanced_accuracy: metrics.balanced_accuracy,
    macro_f1: metrics.macro_f1,
    draw_recall: metrics?.per_class?.DRAW?.recall ?? null,
    per_class: metrics.per_class
  };
}

function buildCandidateEvaluationReport(rows, {
  minTrainSize = 15
} = {}) {
  const baseline = evaluateWalkForwardMajority(rows, { minTrainSize });

  const stable = evaluateWalkForwardStableFeatureSets(rows, {
    minTrainSize,
    topK: 50,
    checkpointCount: 3,
    minCheckpointTrain: 8,
    minPresenceRatio: 0.5,
    minUniqueValues: 2,
    majorityRatio: 0.6
  }).majority_stable;

  const hierarchical = evaluateWalkForwardHierarchicalStable(rows, {
    minTrainSize,
    topK: 50,
    checkpointCount: 3,
    minCheckpointTrain: 8,
    minPresenceRatio: 0.5,
    minUniqueValues: 2,
    majorityRatio: 0.6
  });

  const calibratedBalance = evaluateWalkForwardDrawBalance(rows, {
    minTrainSize,
    stableTopK: 50,
    checkpointCount: 3,
    minCheckpointTrain: 8,
    minPresenceRatio: 0.5,
    minUniqueValues: 2,
    majorityRatio: 0.6,
    balanceTopK: 20,
    calibrateThreshold: true
  });

  const twoCoreDynamicDelta = evaluateWalkForwardTwoCorePlusThird(rows, {
    minTrainSize,
    minOverallPresence: 0.95,
    minLeagueCoverage: 1.0
  });

  const metrics = {
    baseline: classificationMetrics(baseline.predictions),
    stable3class: classificationMetrics(stable.predictions),
    hierarchical: classificationMetrics(hierarchical.predictions),
    calibrated_balance: classificationMetrics(calibratedBalance.predictions),
    two_core_dynamic_delta: classificationMetrics(twoCoreDynamicDelta.predictions)
  };

  const selection = selectBacktestCandidate({
    baseline: metrics.baseline,
    candidates: {
      stable3class: metrics.stable3class,
      hierarchical: metrics.hierarchical,
      calibrated_balance: metrics.calibrated_balance,
      two_core_dynamic_delta: metrics.two_core_dynamic_delta
    },
    policy: {
      minDrawRecall: 0.20,
      requireBaselineAccuracy: true,
      requireBaselineBalancedAccuracy: true
    }
  });

  const robustness = evaluateTemporalRobustness(twoCoreDynamicDelta.predictions, {
    periodCount: 6,
    iterations: 500,
    blockLength: 6,
    seed: 325
  });

  return {
    report_type: 'candidate-model-evaluation',
    status: selection.selected?.name === 'two_core_dynamic_delta'
      ? 'candidate-experimental-selected'
      : 'candidate-experimental-not-selected',
    production_enabled: false,
    selected_model: selection.selected?.name || null,
    model_definition: {
      name: 'two_core_dynamic_delta',
      description: 'Two fixed train-history goal-delta signals plus one train-only dynamically ranked third goal-delta signal.',
      fixed_core_pairs: FIXED_CORE_PAIRS,
      dynamic_third: {
        selection_scope: 'past-training-only',
        selector: 'fisher-feature-ranking',
        provider_specific_features_allowed: false,
        league_coverage_required: 1.0,
        overall_presence_required: 0.95
      }
    },
    dataset: {
      rows: rows.length,
      evaluated_predictions: baseline.predictions.length,
      min_train_size: minTrainSize
    },
    metrics: Object.fromEntries(
      Object.entries(metrics).map(([name, value]) => [name, compactMetrics(value)])
    ),
    rolling_selected_model: rollingClassificationMetrics(
      twoCoreDynamicDelta.predictions,
      3
    ).map(w => ({
      window: w.window,
      total: w.metrics.total,
      accuracy: w.metrics.accuracy,
      balanced_accuracy: w.metrics.balanced_accuracy,
      macro_f1: w.metrics.macro_f1
    })),
    robustness: {
      leave_period_out: robustness.leave_period_out,
      moving_block_bootstrap: robustness.moving_block_bootstrap
    },
    selection
  };
}

module.exports = {
  buildCandidateEvaluationReport
};

