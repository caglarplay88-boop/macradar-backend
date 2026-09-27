const { buildPerformancePackage } = require('./performance');
const { saveBacktestDataset } = require('./db');

function integerOrNull(value) {
  return Number.isInteger(value) ? value : null;
}

function finishedLabel(homeScore, awayScore, resultStatus) {
  if (String(resultStatus || '').toLowerCase() !== 'finished') return null;
  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore)) return null;
  if (homeScore > awayScore) return 'HOME';
  if (homeScore < awayScore) return 'AWAY';
  return 'DRAW';
}

function buildBacktestDatasetRow({
  eventId,
  referenceAt,
  match,
  performance
}) {
  if (!eventId || !referenceAt || !match || !performance) {
    throw new Error('eventId, referenceAt, match ve performance gerekli.');
  }

  const engineVersion = Number(performance?.meta?.engineVersion);
  if (!Number.isInteger(engineVersion) || engineVersion <= 0) {
    throw new Error('Geçerli performance engineVersion gerekli.');
  }

  const homeTeam = String(
    performance?.mac?.ev ||
    performance?.evTakimi?.takim ||
    performance?.evTakimi?.name ||
    ''
  ).trim();
  const awayTeam = String(
    performance?.mac?.deplasman ||
    performance?.deplasmanTakimi?.takim ||
    performance?.deplasmanTakimi?.name ||
    ''
  ).trim();

  if (!homeTeam || !awayTeam) {
    throw new Error('Backtest takım kimliği çözülemedi.');
  }

  const homeScore = integerOrNull(match.home_score);
  const awayScore = integerOrNull(match.away_score);
  const resultStatus = match.result_status || null;

  const features = {
    evTakimi: performance.evTakimi || null,
    deplasmanTakimi: performance.deplasmanTakimi || null,
    h2h: performance.h2h || null,
    source_supplements: performance.source_supplements || {},
    primary_data_confidence: performance.primary_data_confidence ?? null,
    data_confidence: performance.data_confidence ?? null
  };

  const coverage = performance.data_coverage || null;
  const provenance = {
    provider: performance?.meta?.provider || performance?.meta?.kaynak || null,
    kaynak: performance?.meta?.kaynak || null,
    providerAttempts: performance?.meta?.providerAttempts || [],
    fallbackUsed: performance?.meta?.fallbackUsed === true,
    supplementSources: performance?.meta?.supplementSources || [],
    supplementAttempts: performance?.meta?.supplementAttempts || [],
    sourceStrategy: performance?.meta?.sourceStrategy || null,
    engineVersion
  };

  return {
    event_id: String(eventId),
    reference_at: referenceAt,
    match_date: match.match_date,
    kickoff_time: match.kickoff_time || null,
    home_team: homeTeam,
    away_team: awayTeam,
    engine_version: engineVersion,
    provider: provenance.provider,
    features,
    coverage,
    provenance,
    home_score: homeScore,
    away_score: awayScore,
    result_status: resultStatus,
    label_1x2: finishedLabel(homeScore, awayScore, resultStatus)
  };
}

async function buildAndSaveBacktestDataset({
  eventId,
  referenceAt,
  match,
  names,
  buildPerformance = buildPerformancePackage,
  saveDataset = saveBacktestDataset
}) {
  if (!eventId || !referenceAt || !match || !names?.home || !names?.away) {
    throw new Error('Backtest üretimi için eventId, referenceAt, match ve takım adları gerekli.');
  }

  const referenceMs = Date.parse(referenceAt);
  if (!Number.isFinite(referenceMs)) {
    throw new Error('Geçerli historical referenceAt gerekli.');
  }

  const performance = await buildPerformance({
    home: { name: names.home },
    away: { name: names.away },
    matchUrl: match.url || null,
    matchDate: new Date(referenceMs).toISOString()
  });

  const row = buildBacktestDatasetRow({
    eventId,
    referenceAt: new Date(referenceMs).toISOString(),
    match,
    performance
  });

  const saved = await saveDataset(row);
  return { row, saved, performance };
}

module.exports = {
  buildBacktestDatasetRow,
  buildAndSaveBacktestDataset
};
