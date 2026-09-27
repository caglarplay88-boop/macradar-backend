const { pool } = require('./db');
const { buildAndSaveBacktestDataset } = require('./backtest');

function teamNamesFromHistoricalMatch(match) {
  const display = String(match?.display_name || '').trim();

  for (const sep of [' - ', ' – ', ' — ', ' vs ', ' VS ']) {
    const p = display.indexOf(sep);
    if (p > 0) {
      const home = display.slice(0, p).trim();
      const away = display.slice(p + sep.length).trim();
      if (home && away) return { home, away };
    }
  }

  throw new Error('Historical maç takım adları çözülemedi.');
}

function historicalReferenceAt(match) {
  const rawDate = match?.match_date;
  const date = rawDate instanceof Date && Number.isFinite(rawDate.getTime())
    ? rawDate.toISOString().slice(0, 10)
    : String(rawDate || '').match(/\d{4}-\d{2}-\d{2}/)?.[0];
  if (!date) throw new Error('Historical match_date gerekli.');

  const time = String(match?.kickoff_time || '').match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)?.[0];
  const iso = time
    ? date + 'T' + time + ':00+03:00'
    : date + 'T00:00:00+03:00';

  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error('Historical reference zamanı çözülemedi.');
  return new Date(ms).toISOString();
}

async function listHistoricalBacktestCandidates({
  limit = 25,
  db = pool
} = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 500);
  const r = await db.query(`
    SELECT
      event_id, url, display_name, match_slug,
      match_date, kickoff_time,
      home_score, away_score, result_status, lifecycle
    FROM matches
    WHERE lifecycle='finished'
      AND result_status='finished'
      AND home_score IS NOT NULL
      AND away_score IS NOT NULL
      AND match_date IS NOT NULL
      AND display_name IS NOT NULL
    ORDER BY match_date ASC, kickoff_time ASC NULLS LAST, event_id ASC
    LIMIT $1
  `, [safeLimit]);
  return r.rows;
}

async function runHistoricalBacktest({
  limit = 25,
  dryRun = false,
  db = pool,
  buildAndSave = buildAndSaveBacktestDataset
} = {}) {
  const matches = await listHistoricalBacktestCandidates({ limit, db });
  const results = [];

  for (const match of matches) {
    try {
      const names = teamNamesFromHistoricalMatch(match);
      const referenceAt = historicalReferenceAt(match);

      if (dryRun) {
        results.push({
          event_id: match.event_id,
          status: 'ready',
          reference_at: referenceAt,
          home: names.home,
          away: names.away
        });
        continue;
      }

      const built = await buildAndSave({
        eventId: match.event_id,
        referenceAt,
        match,
        names
      });

      results.push({
        event_id: match.event_id,
        status: 'saved',
        reference_at: referenceAt,
        engine_version: built?.row?.engine_version ?? null,
        label_1x2: built?.row?.label_1x2 ?? null
      });
    } catch (error) {
      results.push({
        event_id: match?.event_id || null,
        status: 'failed',
        error: String(error?.message || error).slice(0, 500)
      });
    }
  }

  return {
    requested: Math.min(Math.max(Number(limit) || 25, 1), 500),
    found: matches.length,
    saved: results.filter(r => r.status === 'saved').length,
    ready: results.filter(r => r.status === 'ready').length,
    failed: results.filter(r => r.status === 'failed').length,
    results
  };
}

module.exports = {
  teamNamesFromHistoricalMatch,
  historicalReferenceAt,
  listHistoricalBacktestCandidates,
  runHistoricalBacktest
};
