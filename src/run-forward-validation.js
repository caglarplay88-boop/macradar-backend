const {
  pool,
  getPerformanceCache,
  savePerformanceCache,
  failPerformanceCache
} = require('./db');
const { buildPerformancePackage } = require('./performance');
const { buildBacktestDatasetRow } = require('./backtest');
const {
  ensureForwardValidationTable,
  buildCandidatePredictionSnapshot,
  savePrediction,
  settlePrediction,
  readForwardValidationSummary
} = require('./backtest-forward-validation');

const MODEL_NAME = 'two_core_dynamic_delta';
const ENGINE_VERSION = 83;
const DEFAULT_LIMIT = 10;
const DEFAULT_FEED_LIMIT = 1;
const PREPARING_FRESH_MS = 15 * 60 * 1000;

function kickoffAtMs(match) {
  if (!match?.match_date || !match?.kickoff_time) return null;

  const rawDate = match.match_date;
  const date =
    rawDate instanceof Date && Number.isFinite(rawDate.getTime())
      ? rawDate.toISOString().slice(0, 10)
      : (String(rawDate).match(/\d{4}-\d{2}-\d{2}/)?.[0] || '');

  const m = String(match.kickoff_time).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !m) return null;

  const hh = String(Number(m[1])).padStart(2, '0');
  const mm = String(Number(m[2])).padStart(2, '0');
  const ms = new Date(`${date}T${hh}:${mm}:00+03:00`).getTime();

  return Number.isFinite(ms) ? ms : null;
}

function finishedLabel(match) {
  if (String(match?.result_status || '').toLowerCase() !== 'finished') {
    return null;
  }

  const home = Number(match?.home_score);
  const away = Number(match?.away_score);

  if (!Number.isInteger(home) || !Number.isInteger(away)) {
    return null;
  }

  if (home > away) return 'HOME';
  if (home < away) return 'AWAY';
  return 'DRAW';
}

function teamNamesFromMatch(match) {
  const display = String(match?.display_name || '').trim();

  for (const sep of [' - ', ' – ', ' — ', ' vs ', ' VS ']) {
    const p = display.indexOf(sep);
    if (p > 0) {
      const home = display.slice(0, p).trim();
      const away = display.slice(p + sep.length).trim();
      if (home && away) return { home, away };
    }
  }

  throw new Error('Maç takım adları bulunamadı.');
}

async function loadTrainingRows(db = pool) {
  const q = await db.query(`
    SELECT event_id,reference_at,label_1x2,engine_version,features,coverage
    FROM backtest_dataset
    WHERE engine_version = $1
      AND label_1x2 IN ('HOME','DRAW','AWAY')
    ORDER BY reference_at,event_id
  `, [ENGINE_VERSION]);

  return q.rows;
}

async function settleFinishedPredictions(db = pool) {
  const q = await db.query(`
    SELECT
      f.event_id,
      m.home_score,
      m.away_score,
      m.result_status
    FROM candidate_forward_validation f
    JOIN matches m ON m.event_id = f.event_id
    WHERE f.model_name = $1
      AND f.actual IS NULL
      AND LOWER(COALESCE(m.result_status,'')) = 'finished'
      AND m.home_score IS NOT NULL
      AND m.away_score IS NOT NULL
    ORDER BY f.predicted_at,f.event_id
  `, [MODEL_NAME]);

  let settled = 0;

  for (const row of q.rows) {
    const actual = finishedLabel(row);
    if (!actual) continue;

    const updated = await settlePrediction(db, {
      eventId: row.event_id,
      actual,
      modelName: MODEL_NAME
    });

    settled += updated.length;
  }

  return settled;
}

async function listV83FeedCandidates(db = pool, {
  limit = DEFAULT_FEED_LIMIT,
  now = new Date()
} = {}) {
  const q = await db.query(`
    SELECT
      m.*,
      pc.status AS cache_status,
      pc.updated_at AS cache_updated_at,
      pc.payload->'meta'->>'engineVersion' AS cache_engine_version
    FROM matches m
    LEFT JOIN performance_cache pc ON pc.event_id = m.event_id
    WHERE m.active = TRUE
      AND LOWER(COALESCE(m.result_status,'')) <> 'finished'
    ORDER BY m.match_date,m.kickoff_time,m.event_id
  `);

  const nowMs = now.getTime();
  const candidates = [];

  for (const row of q.rows) {
    const kickoff = kickoffAtMs(row);
    if (!Number.isFinite(kickoff) || nowMs >= kickoff) continue;

    const cacheVersion = Number(row.cache_engine_version || 0);
    if (row.cache_status === 'ready' && cacheVersion >= ENGINE_VERSION) {
      continue;
    }

    const cacheUpdatedMs = row.cache_updated_at
      ? new Date(row.cache_updated_at).getTime()
      : null;
    if (
      row.cache_status === 'preparing' &&
      Number.isFinite(cacheUpdatedMs) &&
      nowMs - cacheUpdatedMs < PREPARING_FRESH_MS
    ) {
      continue;
    }

    candidates.push(row);
    if (candidates.length >= Number(limit)) break;
  }

  return candidates;
}

async function buildMissingV83Performance(db = pool, {
  limit = DEFAULT_FEED_LIMIT,
  now = new Date(),
  buildPerformance = buildPerformancePackage,
  saveCache = savePerformanceCache,
  failCache = failPerformanceCache
} = {}) {
  const candidates = await listV83FeedCandidates(db, { limit, now });
  let built = 0;
  let failed = 0;
  let expired = 0;
  const results = [];

  for (const match of candidates) {
    try {
      const names = teamNamesFromMatch(match);
      const performance = await buildPerformance({
        home: { name: names.home },
        away: { name: names.away },
        matchUrl: match.url || null,
        matchDate: match.match_date || null
      });

      const engineVersion = Number(performance?.meta?.engineVersion || 0);
      if (engineVersion !== ENGINE_VERSION) {
        throw new Error(
          `Beklenen engineVersion ${ENGINE_VERSION}, gelen ${engineVersion || 'yok'}`
        );
      }

      const kickoff = kickoffAtMs(match);
      if (!Number.isFinite(kickoff) || Date.now() >= kickoff) {
        expired++;
        results.push({
          event_id: match.event_id,
          status: 'expired-before-save'
        });
        continue;
      }

      const payload = {
        event_id: match.event_id,
        display_name: match.display_name,
        ...performance
      };

      await saveCache(match.event_id, payload);
      built++;

      results.push({
        event_id: match.event_id,
        status: 'ready',
        engine_version: engineVersion
      });
    } catch (error) {
      failed++;
      await failCache(
        match.event_id,
        error?.message || String(error)
      ).catch(() => {});

      results.push({
        event_id: match.event_id,
        status: 'failed',
        error: error?.message || String(error)
      });

      console.error(
        '[forward-validation] v83 performance build failed:',
        match.event_id,
        error?.message || error
      );
    }
  }

  return {
    candidates: candidates.length,
    built,
    failed,
    expired,
    results
  };
}

async function listPredictionCandidates(db = pool, {
  limit = DEFAULT_LIMIT,
  now = new Date()
} = {}) {
  const q = await db.query(`
    SELECT
      m.*,
      pc.payload AS performance_payload,
      pc.updated_at AS performance_updated_at
    FROM performance_cache pc
    JOIN matches m ON m.event_id = pc.event_id
    LEFT JOIN candidate_forward_validation f
      ON f.event_id = m.event_id
     AND f.model_name = $1
    WHERE pc.status = 'ready'
      AND pc.payload IS NOT NULL
      AND pc.payload->'meta'->>'engineVersion' = $2
      AND LOWER(COALESCE(m.result_status,'')) <> 'finished'
      AND f.id IS NULL
    ORDER BY pc.updated_at,m.event_id
    LIMIT $3
  `, [MODEL_NAME, String(ENGINE_VERSION), Number(limit)]);

  const nowMs = now.getTime();

  return q.rows.filter(row => {
    const kickoff = kickoffAtMs(row);
    const cacheMs = new Date(row.performance_updated_at).getTime();

    if (!Number.isFinite(kickoff) || !Number.isFinite(cacheMs)) return false;
    if (cacheMs >= kickoff) return false;
    if (nowMs >= kickoff) return false;

    return true;
  });
}

async function createPendingPredictions(db = pool, {
  limit = DEFAULT_LIMIT,
  now = new Date()
} = {}) {
  const trainingRows = await loadTrainingRows(db);
  const candidates = await listPredictionCandidates(db, { limit, now });

  let predicted = 0;
  let skipped = 0;
  const results = [];

  for (const match of candidates) {
    try {
      const referenceAt = new Date(match.performance_updated_at).toISOString();
      const targetRow = buildBacktestDatasetRow({
        eventId: match.event_id,
        referenceAt,
        match,
        performance: match.performance_payload
      });

      targetRow.league = match.league || null;

      const snapshot = buildCandidatePredictionSnapshot(
        trainingRows,
        targetRow,
        {
          engineVersion: ENGINE_VERSION,
          predictedAt: now.toISOString()
        }
      );

      const saved = await savePrediction(db, snapshot);
      predicted++;

      results.push({
        event_id: saved.event_id,
        prediction: saved.prediction,
        trained_through: saved.trained_through,
        target_reference_at: saved.target_reference_at
      });
    } catch (error) {
      skipped++;
      console.error(
        '[forward-validation] prediction skipped:',
        match.event_id,
        error?.message || error
      );
    }
  }

  return {
    training_rows: trainingRows.length,
    candidates: candidates.length,
    predicted,
    skipped,
    results
  };
}

async function runForwardValidationOnce({
  db = pool,
  limit = DEFAULT_LIMIT,
  feedLimit = DEFAULT_FEED_LIMIT,
  now = new Date()
} = {}) {
  await ensureForwardValidationTable(db);

  const settled = await settleFinishedPredictions(db);
  const performanceFeed = await buildMissingV83Performance(db, {
    limit: feedLimit,
    now
  });
  const predictionRun = await createPendingPredictions(db, {
    limit,
    now: new Date()
  });
  const summary = await readForwardValidationSummary(db, {
    modelName: MODEL_NAME
  });

  return {
    model: MODEL_NAME,
    engine_version: ENGINE_VERSION,
    settled_now: settled,
    performance_feed: performanceFeed,
    ...predictionRun,
    summary
  };
}

if (require.main === module) {
  const limit = Number(process.env.FORWARD_VALIDATION_LIMIT || DEFAULT_LIMIT);
  const feedLimit = Number(
    process.env.FORWARD_VALIDATION_FEED_LIMIT || DEFAULT_FEED_LIMIT
  );

  runForwardValidationOnce({ limit, feedLimit })
    .then(result => {
      console.log('[forward-validation]', JSON.stringify(result));
    })
    .catch(error => {
      console.error(
        '[forward-validation] worker failed:',
        error?.stack || error?.message || error
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        await pool.end();
      } catch {}
    });
}

module.exports = {
  MODEL_NAME,
  ENGINE_VERSION,
  kickoffAtMs,
  finishedLabel,
  teamNamesFromMatch,
  loadTrainingRows,
  settleFinishedPredictions,
  listV83FeedCandidates,
  buildMissingV83Performance,
  listPredictionCandidates,
  createPendingPredictions,
  runForwardValidationOnce
};

