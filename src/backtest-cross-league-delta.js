const { buildMlReadyRows } = require('./backtest-features');
const { trainNearestCentroid, predictNearestCentroid } = require('./backtest-model');

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isProviderSpecific(name) {
  return /source_supplements|scores365|fotmob|understat|mackolik|betexplorer|provider|provenance|source/i.test(name);
}

function isCoreGoalFeature(name) {
  if (isProviderSpecific(name)) return false;
  return /(?:attigi|yedigi|goals?|scored|conceded)/i.test(name) &&
    /(?:son5|son10)/i.test(name);
}

function pairedName(name) {
  if (name.includes('__evTakimi__')) {
    return name.replace('__evTakimi__', '__deplasmanTakimi__');
  }
  if (name.includes('__deplasmanTakimi__')) {
    return name.replace('__deplasmanTakimi__', '__evTakimi__');
  }
  return null;
}

function canonicalPair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function buildGoalDeltaDefinitions(featureNames) {
  const set = new Set(featureNames);
  const seen = new Set();
  const defs = [];

  for (const name of featureNames) {
    if (!isCoreGoalFeature(name)) continue;
    const mate = pairedName(name);
    if (!mate || !set.has(mate)) continue;

    const [left, right] = canonicalPair(name, mate);
    const key = left + '||' + right;
    if (seen.has(key)) continue;
    seen.add(key);

    defs.push({
      name: 'delta__' + defs.length,
      left,
      right
    });
  }

  return defs;
}

function isPresent(v) {
  return v !== null && v !== undefined &&
    !(typeof v === 'number' && !Number.isFinite(v));
}

function selectTrainOnlyDeltaDefinitions(rawTrain, {
  minOverallPresence = 0.95,
  minLeagueCoverage = 1.0
} = {}) {
  const prepared = buildMlReadyRows(rawTrain);
  const leagues = [...new Set(rawTrain.map(r => r.league).filter(Boolean))];
  if (!leagues.length) return [];

  const defs = buildGoalDeltaDefinitions(prepared.feature_names);
  const selected = [];

  for (const def of defs) {
    let present = 0;
    for (const row of prepared.rows) {
      if (isPresent(row.features[def.left]) && isPresent(row.features[def.right])) present++;
    }
    const overallPresence = prepared.rows.length ? present / prepared.rows.length : 0;
    if (overallPresence < minOverallPresence) continue;

    let leaguesWithPresence = 0;
    for (const league of leagues) {
      const indices = rawTrain
        .map((r, i) => r.league === league ? i : -1)
        .filter(i => i >= 0);

      const any = indices.some(i =>
        isPresent(prepared.rows[i]?.features?.[def.left]) &&
        isPresent(prepared.rows[i]?.features?.[def.right])
      );
      if (any) leaguesWithPresence++;
    }

    const leagueCoverage = leaguesWithPresence / leagues.length;
    if (leagueCoverage < minLeagueCoverage) continue;

    selected.push({
      ...def,
      overall_presence: overallPresence,
      league_coverage: leagueCoverage
    });
  }

  return selected.sort((a, b) =>
    b.league_coverage - a.league_coverage ||
    b.overall_presence - a.overall_presence ||
    a.name.localeCompare(b.name)
  );
}

function buildDeltaRows(preparedRows, defs) {
  return preparedRows.map(row => {
    const features = {};
    for (const def of defs) {
      const left = row.features[def.left];
      const right = row.features[def.right];
      features[def.name] = finite(left) && finite(right) ? left - right : null;
    }
    return {
      event_id: row.event_id,
      engine_version: row.engine_version,
      label_1x2: row.label_1x2,
      features
    };
  });
}

function evaluateWalkForwardCrossLeagueGoalDelta(rows, {
  minTrainSize = 15,
  minOverallPresence = 0.95,
  minLeagueCoverage = 1.0
} = {}) {
  if (!Array.isArray(rows) || rows.length <= minTrainSize) {
    throw new Error('Cross-league delta walk-forward için yeterli satır gerekli.');
  }

  const sorted = rows.slice().sort((a, b) => {
    const ams = Date.parse(a?.reference_at);
    const bms = Date.parse(b?.reference_at);
    if (!Number.isFinite(ams) || !Number.isFinite(bms)) {
      throw new Error('Geçerli reference_at gerekli.');
    }
    return ams - bms || String(a.event_id || '').localeCompare(String(b.event_id || ''));
  });

  const predictions = [];
  let index = Number(minTrainSize);

  while (index < sorted.length) {
    const testMs = Date.parse(sorted[index].reference_at);
    let groupStart = index;

    while (
      groupStart > 0 &&
      Date.parse(sorted[groupStart - 1].reference_at) === testMs
    ) groupStart--;

    const rawTrain = sorted.slice(0, groupStart)
      .filter(r => Date.parse(r.reference_at) < testMs);

    if (rawTrain.length < minTrainSize) {
      index++;
      continue;
    }

    let end = index;
    while (
      end < sorted.length &&
      Date.parse(sorted[end].reference_at) === testMs
    ) end++;

    const rawTest = sorted.slice(index, end);
    const defs = selectTrainOnlyDeltaDefinitions(rawTrain, {
      minOverallPresence,
      minLeagueCoverage
    });

    const prepared = buildMlReadyRows([...rawTrain, ...rawTest]);
    const trainPrepared = prepared.rows.slice(0, rawTrain.length);
    const testPrepared = prepared.rows.slice(rawTrain.length);

    if (!defs.length) {
      index = end;
      continue;
    }

    const trainDelta = buildDeltaRows(trainPrepared, defs);
    const testDelta = buildDeltaRows(testPrepared, defs);
    const selected = defs.map(x => x.name);

    const model = trainNearestCentroid(trainDelta, selected);

    for (let i = 0; i < testDelta.length; i++) {
      const result = predictNearestCentroid(model, testDelta[i]);
      predictions.push({
        event_id: rawTest[i].event_id,
        reference_at: rawTest[i].reference_at,
        actual: testDelta[i].label_1x2,
        predicted: result.label,
        correct: result.label === testDelta[i].label_1x2,
        train_size: rawTrain.length,
        league_count: new Set(rawTrain.map(r => r.league).filter(Boolean)).size,
        feature_count: selected.length
      });
    }

    index = end;
  }

  const correct = predictions.filter(x => x.correct).length;
  return {
    model: 'train-only-cross-league-goal-delta-nearest-centroid',
    total: predictions.length,
    correct,
    accuracy: predictions.length ? correct / predictions.length : null,
    min_feature_count: predictions.length ? Math.min(...predictions.map(x => x.feature_count)) : null,
    max_feature_count: predictions.length ? Math.max(...predictions.map(x => x.feature_count)) : null,
    predictions
  };
}

module.exports = {
  buildGoalDeltaDefinitions,
  selectTrainOnlyDeltaDefinitions,
  buildDeltaRows,
  evaluateWalkForwardCrossLeagueGoalDelta
};

