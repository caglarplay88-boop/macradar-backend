const { listBacktestDataset } = require('./db');
const { buildMlReadyRows } = require('./backtest-features');

function summarizeLabels(rows) {
  const counts = { HOME: 0, DRAW: 0, AWAY: 0, OTHER: 0 };
  for (const row of rows) {
    const label = row?.label_1x2;
    if (label === 'HOME' || label === 'DRAW' || label === 'AWAY') {
      counts[label]++;
    } else {
      counts.OTHER++;
    }
  }
  return counts;
}

async function loadMlReadyBacktestDataset({
  engineVersion = 83,
  limit = 1000,
  db
} = {}) {
  const safeEngineVersion = Number(engineVersion);
  if (!Number.isInteger(safeEngineVersion) || safeEngineVersion <= 0) {
    throw new Error('Geçerli engineVersion gerekli.');
  }

  const rows = await listBacktestDataset(
    { engineVersion: safeEngineVersion, limit },
    db
  );

  const labeled = rows.filter(row =>
    row?.label_1x2 === 'HOME' ||
    row?.label_1x2 === 'DRAW' ||
    row?.label_1x2 === 'AWAY'
  );

  const dataset = buildMlReadyRows(labeled);

  return {
    meta: {
      engine_version: safeEngineVersion,
      row_count: dataset.rows.length,
      feature_count: dataset.feature_names.length,
      label_counts: summarizeLabels(dataset.rows)
    },
    feature_names: dataset.feature_names,
    rows: dataset.rows
  };
}

module.exports = {
  summarizeLabels,
  loadMlReadyBacktestDataset
};

