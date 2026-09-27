const BLOCKED_KEYS = new Set([
  'id',
  'event_id',
  'engine_version',
  'engineVersion',
  'home_score',
  'away_score',
  'result_status',
  'label_1x2',
  'odds',
  'opening_odds',
  'openingOdds',
  'collected_at',
  'collectedAt',
  'generated_at',
  'generatedAt',
  'fetched_at',
  'fetchedAt',
  'version',
  'provenance',
  '_providerPolicy',
  'providerPolicy',
  'provider',
  'source',
  'url'
]);

function isBlockedKey(key) {
  const raw = String(key || '');
  if (BLOCKED_KEYS.has(raw)) return true;
  if (/(?:^|_)(?:id|odds?)$/i.test(raw)) return true;
  if (/Id$/.test(raw)) return true;
  return false;
}

function flattenStableScalars(value, prefix = '', out = {}) {
  if (Array.isArray(value)) return out;

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (isBlockedKey(key)) continue;
      const next = prefix ? prefix + '__' + key : key;
      flattenStableScalars(child, next, out);
    }
    return out;
  }

  if (!prefix) return out;

  if (typeof value === 'number' && Number.isFinite(value)) {
    out[prefix] = value;
  } else if (typeof value === 'boolean') {
    out[prefix] = value ? 1 : 0;
  } else if (value === null) {
    out[prefix] = null;
  }

  return out;
}

function extractBacktestFeatureMap(row) {
  if (!row || typeof row !== 'object') {
    throw new Error('Backtest row gerekli.');
  }

  return flattenStableScalars({
    features: row.features || {},
    coverage: row.coverage || {}
  });
}

function buildMlReadyRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error('Backtest rows dizisi gerekli.');
  }

  const extracted = rows.map(row => ({
    event_id: String(row.event_id || ''),
    engine_version: Number(row.engine_version),
    label_1x2: row.label_1x2 || null,
    featureMap: extractBacktestFeatureMap(row)
  }));

  const featureNames = [...new Set(
    extracted.flatMap(row => Object.keys(row.featureMap))
  )].sort();

  return {
    feature_names: featureNames,
    rows: extracted.map(row => ({
      event_id: row.event_id,
      engine_version: row.engine_version,
      label_1x2: row.label_1x2,
      features: Object.fromEntries(
        featureNames.map(name => [
          name,
          Object.prototype.hasOwnProperty.call(row.featureMap, name)
            ? row.featureMap[name]
            : null
        ])
      )
    }))
  };
}

module.exports = {
  flattenStableScalars,
  extractBacktestFeatureMap,
  buildMlReadyRows
};

