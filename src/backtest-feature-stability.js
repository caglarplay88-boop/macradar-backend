const { buildMlReadyRows, selectStableFeatureNames } = require('./backtest-features');
const { rankFeatureNames } = require('./backtest-feature-budget');

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function analyzeFeatureRankingStability(rows, {
  minTrainSize = 15,
  topK = 50,
  checkpointCount = 5,
  minPresenceRatio = 0.5,
  minUniqueValues = 2
} = {}) {
  if (!Array.isArray(rows) || rows.length <= minTrainSize) {
    throw new Error('Feature stability için yeterli satır gerekli.');
  }

  const sorted = rows.slice().sort((a, b) => {
    const ams = Date.parse(a?.reference_at);
    const bms = Date.parse(b?.reference_at);
    if (!Number.isFinite(ams) || !Number.isFinite(bms)) {
      throw new Error('Geçerli reference_at gerekli.');
    }
    return ams - bms || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });

  const maxTrain = sorted.length - 1;
  const checkpoints = [];
  for (let i = 0; i < checkpointCount; i++) {
    const target = Math.round(
      minTrainSize + ((maxTrain - minTrainSize) * i / Math.max(1, checkpointCount - 1))
    );
    if (!checkpoints.includes(target)) checkpoints.push(target);
  }

  const featureStats = new Map();
  const folds = [];

  for (const requestedTrainSize of checkpoints) {
    const boundaryMs = Date.parse(sorted[requestedTrainSize]?.reference_at);
    if (!Number.isFinite(boundaryMs)) continue;

    const trainRaw = sorted.filter(row => Date.parse(row.reference_at) < boundaryMs);
    if (trainRaw.length < minTrainSize) continue;

    const prepared = buildMlReadyRows(trainRaw);
    const stable = selectStableFeatureNames(prepared, {
      minPresenceRatio,
      minUniqueValues
    });
    const ranked = rankFeatureNames(prepared.rows, stable);
    const selected = ranked.slice(0, topK);

    folds.push({
      requested_train_size: requestedTrainSize,
      train_size: trainRaw.length,
      boundary_reference_at: new Date(boundaryMs).toISOString(),
      stable_feature_count: stable.length,
      ranked_feature_count: ranked.length,
      top_count: selected.length
    });

    selected.forEach((item, index) => {
      const current = featureStats.get(item.name) || {
        name: item.name,
        appearances: 0,
        ranks: [],
        scores: []
      };
      current.appearances++;
      current.ranks.push(index + 1);
      current.scores.push(item.score);
      featureStats.set(item.name, current);
    });
  }

  const totalFolds = folds.length;
  const features = [...featureStats.values()]
    .map(item => ({
      name: item.name,
      appearances: item.appearances,
      appearance_ratio: totalFolds ? item.appearances / totalFolds : 0,
      median_rank: median(item.ranks),
      best_rank: Math.min(...item.ranks),
      worst_rank: Math.max(...item.ranks),
      median_score: median(item.scores)
    }))
    .sort((a, b) =>
      b.appearances - a.appearances ||
      a.median_rank - b.median_rank ||
      a.name.localeCompare(b.name)
    );

  return {
    meta: {
      row_count: sorted.length,
      fold_count: totalFolds,
      top_k: topK,
      min_train_size: minTrainSize
    },
    folds,
    stable_all_folds: features.filter(x => x.appearances === totalFolds),
    stable_majority: features.filter(x => x.appearance_ratio >= 0.6),
    features
  };
}

module.exports = {
  analyzeFeatureRankingStability
};

