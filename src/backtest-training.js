const { listBacktestDataset } = require('./db');
const { buildMlReadyRows, selectStableFeatureNames } = require('./backtest-features');

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

function projectFeatureNames(rows, featureNames) {
  return rows.map(row => ({
    event_id: row.event_id,
    engine_version: row.engine_version,
    label_1x2: row.label_1x2,
    features: Object.fromEntries(
      featureNames.map(name => [name, row.features[name] ?? null])
    )
  }));
}

function buildTemporalBacktestSplit(rows, {
  trainRatio = 0.8,
  minPresenceRatio = 0.5,
  minUniqueValues = 2
} = {}) {
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error('Temporal split için en az 2 backtest satırı gerekli.');
  }

  const ratio = Number(trainRatio);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    throw new Error('trainRatio 0 ile 1 arasında olmalı.');
  }

  const sorted = rows.slice().sort((a, b) => {
    const ams = Date.parse(a?.reference_at);
    const bms = Date.parse(b?.reference_at);
    if (!Number.isFinite(ams) || !Number.isFinite(bms)) {
      throw new Error('Temporal split için geçerli reference_at gerekli.');
    }
    return ams - bms || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });

  let splitIndex = Math.min(
    sorted.length - 1,
    Math.max(1, Math.floor(sorted.length * ratio))
  );

  const boundaryMs = Date.parse(sorted[splitIndex - 1].reference_at);
  while (
    splitIndex < sorted.length - 1 &&
    Date.parse(sorted[splitIndex].reference_at) === boundaryMs
  ) {
    splitIndex++;
  }

  if (Date.parse(sorted[splitIndex].reference_at) === boundaryMs) {
    while (
      splitIndex > 1 &&
      Date.parse(sorted[splitIndex - 1].reference_at) === boundaryMs
    ) {
      splitIndex--;
    }
  }

  const fullDataset = buildMlReadyRows(sorted);
  const trainRows = fullDataset.rows.slice(0, splitIndex);
  const testRows = fullDataset.rows.slice(splitIndex);

  const selectedFeatureNames = selectStableFeatureNames(
    {
      feature_names: fullDataset.feature_names,
      rows: trainRows
    },
    { minPresenceRatio, minUniqueValues }
  );

  return {
    meta: {
      row_count: sorted.length,
      train_count: trainRows.length,
      test_count: testRows.length,
      train_ratio: ratio,
      feature_count: selectedFeatureNames.length,
      train_end_reference_at: new Date(sorted[splitIndex - 1].reference_at).toISOString(),
      test_start_reference_at: new Date(sorted[splitIndex].reference_at).toISOString()
    },
    feature_names: selectedFeatureNames,
    train: projectFeatureNames(trainRows, selectedFeatureNames),
    test: projectFeatureNames(testRows, selectedFeatureNames)
  };
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
  buildTemporalBacktestSplit,
  loadMlReadyBacktestDataset
};

