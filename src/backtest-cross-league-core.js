const { buildMlReadyRows } = require('./backtest-features');
const { trainNearestCentroid, predictNearestCentroid } = require('./backtest-model');

function isProviderSpecific(name) {
  return /source_supplements|scores365|fotmob|understat|mackolik|betexplorer|provider|provenance|source/i.test(name);
}

function isCoreGoalFeature(name) {
  if (isProviderSpecific(name)) return false;
  return /(?:attigi|yedigi|goals?|scored|conceded)/i.test(name) &&
    /(?:son5|son10)/i.test(name);
}

function isPresent(value) {
  return value !== null && value !== undefined &&
    !(typeof value === 'number' && !Number.isFinite(value));
}

function selectTrainOnlyCrossLeagueGoalFeatures(rawTrain, {
  minOverallPresence = 0.95,
  minLeagueCoverage = 1.0
} = {}) {
  const prepared = buildMlReadyRows(rawTrain);
  const leagues = [...new Set(rawTrain.map(r => r.league).filter(Boolean))];
  if (!leagues.length) return [];

  const selected = [];

  for (const name of prepared.feature_names) {
    if (!isCoreGoalFeature(name)) continue;

    const overallPresent = prepared.rows.filter(r => isPresent(r.features[name])).length;
    const overallPresence = prepared.rows.length ? overallPresent / prepared.rows.length : 0;
    if (overallPresence < minOverallPresence) continue;

    let leaguesWithPresence = 0;

    for (const league of leagues) {
      const idx = rawTrain
        .map((r, i) => r.league === league ? i : -1)
        .filter(i => i >= 0);
      if (!idx.length) continue;

      const anyPresent = idx.some(i => isPresent(prepared.rows[i]?.features?.[name]));
      if (anyPresent) leaguesWithPresence++;
    }

    const leagueCoverage = leaguesWithPresence / leagues.length;
    if (leagueCoverage < minLeagueCoverage) continue;

    selected.push({
      name,
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

function evaluateWalkForwardCrossLeagueGoals(rows, {
  minTrainSize = 15,
  minOverallPresence = 0.95,
  minLeagueCoverage = 1.0
} = {}) {
  if (!Array.isArray(rows) || rows.length <= minTrainSize) {
    throw new Error('Cross-league walk-forward için yeterli satır gerekli.');
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
    const selectedInfo = selectTrainOnlyCrossLeagueGoalFeatures(rawTrain, {
      minOverallPresence,
      minLeagueCoverage
    });

    const prepared = buildMlReadyRows([...rawTrain, ...rawTest]);
    const trainPrepared = prepared.rows.slice(0, rawTrain.length);
    const testPrepared = prepared.rows.slice(rawTrain.length);
    const selected = selectedInfo
      .map(x => x.name)
      .filter(name => prepared.feature_names.includes(name));

    if (!selected.length) {
      index = end;
      continue;
    }

    const model = trainNearestCentroid(trainPrepared, selected);

    for (let i = 0; i < testPrepared.length; i++) {
      const result = predictNearestCentroid(model, testPrepared[i]);
      predictions.push({
        event_id: rawTest[i].event_id,
        reference_at: rawTest[i].reference_at,
        actual: testPrepared[i].label_1x2,
        predicted: result.label,
        correct: result.label === testPrepared[i].label_1x2,
        train_size: rawTrain.length,
        league_count: new Set(rawTrain.map(r => r.league).filter(Boolean)).size,
        feature_count: selected.length
      });
    }

    index = end;
  }

  const correct = predictions.filter(x => x.correct).length;
  return {
    model: 'train-only-cross-league-goal-nearest-centroid',
    total: predictions.length,
    correct,
    accuracy: predictions.length ? correct / predictions.length : null,
    min_feature_count: predictions.length ? Math.min(...predictions.map(x => x.feature_count)) : null,
    max_feature_count: predictions.length ? Math.max(...predictions.map(x => x.feature_count)) : null,
    predictions
  };
}

module.exports = {
  isCoreGoalFeature,
  selectTrainOnlyCrossLeagueGoalFeatures,
  evaluateWalkForwardCrossLeagueGoals
};

