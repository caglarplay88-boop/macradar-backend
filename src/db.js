const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL tanımlı değil.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matches (
      event_id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      match_slug TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS display_name TEXT;
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS league TEXT;
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS match_date DATE;
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS kickoff_time TEXT;
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT 'tracking';
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS home_score INTEGER;
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS away_score INTEGER;
    ALTER TABLE matches ADD COLUMN IF NOT EXISTS result_status TEXT;

    CREATE TABLE IF NOT EXISTS performance_cache (
      event_id TEXT PRIMARY KEY,
      payload JSONB,
      status TEXT NOT NULL DEFAULT 'idle',
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_performance_cache_status
      ON performance_cache(status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS odds_1x2_snapshots (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES matches(event_id) ON DELETE CASCADE,
      bookmaker_id TEXT,
      bookmaker_key TEXT NOT NULL,
      bookmaker_name TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT '1X2' CHECK (market = '1X2'),
      home_odd NUMERIC(12,4) NOT NULL CHECK (home_odd > 1),
      draw_odd NUMERIC(12,4) NOT NULL CHECK (draw_odd > 1),
      away_odd NUMERIC(12,4) NOT NULL CHECK (away_odd > 1),
      captured_at TIMESTAMPTZ NOT NULL,
      capture_sequence BIGINT NOT NULL CHECK (capture_sequence > 0),
      capture_type TEXT NOT NULL CHECK (capture_type IN ('opening','current','periodic')),
      source_name TEXT NOT NULL,
      source_region TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_odds_1x2_time
      ON odds_1x2_snapshots(event_id, bookmaker_key, market, captured_at, capture_type);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_odds_1x2_sequence
      ON odds_1x2_snapshots(event_id, bookmaker_key, market, capture_sequence, capture_type);
    CREATE INDEX IF NOT EXISTS idx_odds_1x2_match_time
      ON odds_1x2_snapshots(event_id, captured_at DESC);
    CREATE INDEX IF NOT EXISTS idx_odds_1x2_bookmaker_history
      ON odds_1x2_snapshots(
        event_id, bookmaker_key, captured_at DESC, id DESC
      );

    CREATE TABLE IF NOT EXISTS odds_tracking_settings (
      event_id TEXT PRIMARY KEY REFERENCES matches(event_id) ON DELETE CASCADE,
      tracking_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      refresh_minutes INTEGER NOT NULL DEFAULT 60
        CHECK (refresh_minutes IN (5,15,30,60,120)),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_odds_tracking_enabled
      ON odds_tracking_settings(tracking_enabled, refresh_minutes);

    ALTER TABLE odds_tracking_settings
      ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
    ALTER TABLE odds_tracking_settings
      ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;
    ALTER TABLE odds_tracking_settings
      ADD COLUMN IF NOT EXISTS next_pull_at TIMESTAMPTZ;
    ALTER TABLE odds_tracking_settings
      ADD COLUMN IF NOT EXISTS last_error TEXT;
    CREATE INDEX IF NOT EXISTS idx_odds_tracking_due
      ON odds_tracking_settings(tracking_enabled, next_pull_at)
      WHERE tracking_enabled=TRUE;
  `);
}

async function upsertMatch({
  eventId,
  url,
  slug,
  active = true,
  displayName = null,
  league = null,
  matchDate = null,
  kickoffTime = null
}) {
  const now = new Date();
  await pool.query(`
    INSERT INTO matches(
      event_id,url,match_slug,active,created_at,updated_at,
      display_name,league,match_date,kickoff_time
    )
    VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9)
    ON CONFLICT(event_id) DO UPDATE SET
      url=EXCLUDED.url,
      match_slug=EXCLUDED.match_slug,
      active=EXCLUDED.active,
      display_name=COALESCE(EXCLUDED.display_name,matches.display_name),
      league=COALESCE(EXCLUDED.league,matches.league),
      match_date=COALESCE(EXCLUDED.match_date,matches.match_date),
      kickoff_time=COALESCE(EXCLUDED.kickoff_time,matches.kickoff_time),
      updated_at=EXCLUDED.updated_at
  `, [
    eventId, url, slug, active, now,
    displayName, league, matchDate, kickoffTime
  ]);
}

async function listMatches({ activeOnly = false } = {}) {
  const { rows } = await pool.query(
    `SELECT m.*,
            COALESCE((
              SELECT COUNT(DISTINCT s.capture_sequence)::int
              FROM odds_1x2_snapshots s
              WHERE s.event_id=m.event_id
            ), 0) AS odds_capture_count
     FROM matches m ${activeOnly ? 'WHERE m.active=TRUE' : ''}
     ORDER BY m.match_date ASC NULLS LAST,
              m.kickoff_time ASC NULLS LAST,
              m.display_name ASC NULLS LAST`
  );
  return rows;
}

async function setMatchLifecycle(eventId, {
  active = null,
  archived = null,
  lifecycle = null,
  homeScore = null,
  awayScore = null,
  resultStatus = null
} = {}) {
  const r = await pool.query(`
    UPDATE matches
    SET
      active=COALESCE($2, active),
      archived=COALESCE($3, archived),
      lifecycle=COALESCE($4, lifecycle),
      home_score=CASE WHEN $5::int IS NULL THEN home_score ELSE $5::int END,
      away_score=CASE WHEN $6::int IS NULL THEN away_score ELSE $6::int END,
      result_status=COALESCE($7, result_status),
      updated_at=NOW()
    WHERE event_id=$1
    RETURNING *
  `, [
    eventId,
    active,
    archived,
    lifecycle,
    homeScore,
    awayScore,
    resultStatus
  ]);
  return r.rows[0] || null;
}

async function archiveStartedMatch(eventId) {
  return setMatchLifecycle(eventId, {
    active: false,
    archived: true,
    lifecycle: 'started',
    resultStatus: 'started'
  });
}

async function finishMatch(eventId, homeScore, awayScore) {
  return setMatchLifecycle(eventId, {
    active: false,
    archived: true,
    lifecycle: 'finished',
    homeScore,
    awayScore,
    resultStatus: 'finished'
  });
}

async function setActive(eventId, active) {
  const r = await pool.query(
    `UPDATE matches
     SET active=$2,
         archived=FALSE,
         lifecycle=$3,
         result_status=CASE WHEN $2 THEN NULL ELSE result_status END,
         updated_at=NOW()
     WHERE event_id=$1
     RETURNING *`,
    [eventId, active, active ? 'tracking' : 'removed']
  );
  return r.rows[0] || null;
}

const ALLOWED_ODDS_REFRESH_MINUTES = new Set([5, 15, 30, 60, 120]);

async function getTrackingSettings(eventId) {
  const id = String(eventId || '').trim();
  if (!id) return null;

  await pool.query(`
    INSERT INTO odds_tracking_settings(event_id)
    SELECT event_id FROM matches WHERE event_id=$1
    ON CONFLICT(event_id) DO NOTHING
  `, [id]);

  const r = await pool.query(
    `SELECT event_id,tracking_enabled,refresh_minutes,
            last_attempt_at,last_success_at,next_pull_at,last_error,
            created_at,updated_at
     FROM odds_tracking_settings
     WHERE event_id=$1`,
    [id]
  );
  return r.rows[0] || null;
}

async function updateTrackingSettings(eventId, enabled, refreshMinutes) {
  const id = String(eventId || '').trim();
  const minutes = Number(refreshMinutes);

  if (!id || typeof enabled !== 'boolean') {
    throw new Error('Geçersiz oran takip ayarı.');
  }
  if (!ALLOWED_ODDS_REFRESH_MINUTES.has(minutes)) {
    throw new Error('Geçersiz oran çekim aralığı.');
  }

  const r = await pool.query(`
    INSERT INTO odds_tracking_settings(
      event_id,tracking_enabled,refresh_minutes,next_pull_at,last_error,
      created_at,updated_at
    )
    SELECT event_id,$2,$3::int,
           CASE WHEN $2 THEN NOW() + ($3::int * INTERVAL '1 minute') ELSE NULL END,
           NULL,NOW(),NOW()
    FROM matches
    WHERE event_id=$1
    ON CONFLICT(event_id) DO UPDATE SET
      tracking_enabled=EXCLUDED.tracking_enabled,
      refresh_minutes=EXCLUDED.refresh_minutes,
      next_pull_at=CASE
        WHEN EXCLUDED.tracking_enabled
          THEN NOW() + (EXCLUDED.refresh_minutes * INTERVAL '1 minute')
        ELSE NULL
      END,
      last_error=NULL,
      updated_at=NOW()
    RETURNING event_id,tracking_enabled,refresh_minutes,
              last_attempt_at,last_success_at,next_pull_at,last_error,
              created_at,updated_at
  `, [id, enabled, minutes]);

  return r.rows[0] || null;
}

async function listDueTrackingJobs(limit = 4) {
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 4));
  const r = await pool.query(`
    SELECT s.event_id,s.refresh_minutes,s.next_pull_at,
           m.url,m.active,m.archived,m.lifecycle
    FROM odds_tracking_settings s
    JOIN matches m ON m.event_id=s.event_id
    WHERE s.tracking_enabled=TRUE
      AND m.active=TRUE
      AND COALESCE(m.archived,FALSE)=FALSE
      AND COALESCE(m.lifecycle,'tracking') NOT IN ('started','finished','removed')
      AND (
        m.match_date IS NULL OR
        m.kickoff_time IS NULL OR
        m.kickoff_time !~ '^\d{1,2}:\d{2}$' OR
        ((m.match_date::text || ' ' || m.kickoff_time)::timestamp
          AT TIME ZONE 'Europe/Istanbul') > NOW()
      )
      AND COALESCE(s.next_pull_at,NOW()) <= NOW()
    ORDER BY COALESCE(s.next_pull_at,NOW()) ASC, s.event_id ASC
    LIMIT $1
  `, [safeLimit]);
  return r.rows;
}

async function markTrackingAttempt(eventId) {
  const r = await pool.query(`
    UPDATE odds_tracking_settings
    SET last_attempt_at=NOW(),
        next_pull_at=NOW() + INTERVAL '5 minutes',
        updated_at=NOW()
    WHERE event_id=$1 AND tracking_enabled=TRUE
      AND COALESCE(next_pull_at,NOW()) <= NOW()
    RETURNING *
  `, [String(eventId || '').trim()]);
  return r.rows[0] || null;
}

async function markTrackingSuccess(eventId) {
  const r = await pool.query(`
    UPDATE odds_tracking_settings
    SET last_success_at=NOW(),
        next_pull_at=NOW() + (refresh_minutes * INTERVAL '1 minute'),
        last_error=NULL,
        updated_at=NOW()
    WHERE event_id=$1 AND tracking_enabled=TRUE
    RETURNING *
  `, [String(eventId || '').trim()]);
  return r.rows[0] || null;
}

async function markTrackingFailure(eventId, error) {
  const message = String(error || 'Bilinmeyen periyodik oran hatası').slice(0, 1200);
  const r = await pool.query(`
    UPDATE odds_tracking_settings
    SET next_pull_at=NOW() + INTERVAL '5 minutes',
        last_error=$2,
        updated_at=NOW()
    WHERE event_id=$1 AND tracking_enabled=TRUE
    RETURNING *
  `, [String(eventId || '').trim(), message]);
  return r.rows[0] || null;
}

async function getLatestOdds1x2Batch(eventId, captureType) {
  const id = String(eventId || '').trim();
  const type = String(captureType || '').trim();

  if (!id || !['opening', 'current', 'periodic'].includes(type)) {
    throw new Error('Geçersiz 1X2 snapshot sorgusu.');
  }

  const latest = await pool.query(
    `SELECT capture_sequence
     FROM odds_1x2_snapshots
     WHERE event_id=$1 AND capture_type=$2
     ORDER BY capture_sequence DESC
     LIMIT 1`,
    [id, type]
  );

  if (!latest.rows[0]) return null;

  const sequence = latest.rows[0].capture_sequence;
  const rows = await pool.query(
    `SELECT bookmaker_id,bookmaker_name,home_odd,draw_odd,away_odd,
            captured_at,capture_sequence,capture_type,source_name,source_region
     FROM odds_1x2_snapshots
     WHERE event_id=$1 AND capture_type=$2 AND capture_sequence=$3
     ORDER BY bookmaker_name ASC`,
    [id, type, sequence]
  );

  if (!rows.rows.length) return null;

  const maxCapturedAt = rows.rows.reduce((max, row) => {
    const ms = new Date(row.captured_at).getTime();
    return Number.isFinite(ms) && ms > max ? ms : max;
  }, 0);

  return {
    capture_sequence: String(sequence),
    capture_type: type,
    captured_at: maxCapturedAt ? new Date(maxCapturedAt) : rows.rows[0].captured_at,
    source_name: rows.rows[0].source_name,
    source_region: rows.rows[0].source_region,
    rows: rows.rows
  };
}

async function listOdds1x2History({
  eventId,
  bookmaker = null,
  page = 1,
  pageSize = 50
}) {
  const id = String(eventId || '').trim();
  const safePage = Math.max(1, Math.min(100000, Number(page) || 1));
  const safePageSize = 50;
  const bookmakerKey = bookmaker
    ? normalizeBookmakerKey(bookmaker)
    : null;

  if (!id) throw new Error('Invalid match id.');
  if (bookmaker && !bookmakerKey) {
    throw new Error('Invalid bookmaker.');
  }

  const where = bookmakerKey
    ? 'event_id=$1 AND bookmaker_key=$2'
    : 'event_id=$1';
  const baseParams = bookmakerKey ? [id, bookmakerKey] : [id];

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM odds_1x2_snapshots
     WHERE ${where}`,
    baseParams
  );
  const totalRecords = Number(countResult.rows[0]?.total || 0);
  const totalPages = Math.ceil(totalRecords / safePageSize);
  const offset = (safePage - 1) * safePageSize;

  const limitParam = baseParams.length + 1;
  const offsetParam = baseParams.length + 2;
  const rowsResult = await pool.query(
    `SELECT id,event_id,bookmaker_id,bookmaker_key,bookmaker_name,market,
            home_odd,draw_odd,away_odd,captured_at,capture_sequence,
            capture_type,source_name,source_region
     FROM odds_1x2_snapshots
     WHERE ${where}
     ORDER BY
       CASE WHEN capture_type='opening' THEN 1 ELSE 0 END ASC,
       captured_at DESC, capture_sequence DESC, id DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    [...baseParams, safePageSize, offset]
  );

  return {
    bookmaker_key: bookmakerKey,
    page: safePage,
    page_size: safePageSize,
    total_records: totalRecords,
    total_pages: totalPages,
    has_previous: safePage > 1 && totalRecords > 0,
    has_next: safePage < totalPages,
    rows: rowsResult.rows
  };
}

function normalizeBookmakerKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function validateOdds1x2Snapshot(snapshot) {
  const allowedTypes = new Set(['opening', 'current', 'periodic']);
  const requiredText = [
    snapshot?.eventId,
    snapshot?.bookmakerName,
    snapshot?.sourceName
  ];
  if (requiredText.some(value => !String(value || '').trim())) {
    throw new Error('1X2 snapshot kimlik/kaynak alanları eksik.');
  }
  if (!allowedTypes.has(snapshot?.captureType)) {
    throw new Error('Geçersiz 1X2 captureType.');
  }
  const capturedAt = new Date(snapshot?.capturedAt);
  if (!Number.isFinite(capturedAt.getTime())) {
    throw new Error('Geçersiz 1X2 capturedAt.');
  }
  const sequence = Number(snapshot?.captureSequence);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new Error('Geçersiz 1X2 captureSequence.');
  }
  for (const value of [snapshot?.homeOdd, snapshot?.drawOdd, snapshot?.awayOdd]) {
    const odd = Number(value);
    if (!Number.isFinite(odd) || odd <= 1) {
      throw new Error('Geçersiz 1X2 oran değeri.');
    }
  }
}

async function saveOdds1x2Snapshot(snapshot) {
  validateOdds1x2Snapshot(snapshot);
  const bookmakerKey = normalizeBookmakerKey(snapshot.bookmakerId || snapshot.bookmakerName);
  if (!bookmakerKey) throw new Error('Bookmaker anahtarı üretilemedi.');

  const r = await pool.query(`
    INSERT INTO odds_1x2_snapshots(
      event_id,bookmaker_id,bookmaker_key,bookmaker_name,market,
      home_odd,draw_odd,away_odd,captured_at,capture_sequence,
      capture_type,source_name,source_region
    )
    VALUES($1,$2,$3,$4,'1X2',$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT DO NOTHING
    RETURNING *
  `, [
    String(snapshot.eventId).trim(),
    snapshot.bookmakerId ? String(snapshot.bookmakerId).trim() : null,
    bookmakerKey,
    String(snapshot.bookmakerName).trim(),
    Number(snapshot.homeOdd),
    Number(snapshot.drawOdd),
    Number(snapshot.awayOdd),
    new Date(snapshot.capturedAt),
    Number(snapshot.captureSequence),
    snapshot.captureType,
    String(snapshot.sourceName).trim(),
    snapshot.sourceRegion ? String(snapshot.sourceRegion).trim() : null
  ]);

  return r.rows[0] || null;
}

async function saveOdds1x2Batch({
  eventId,
  rows,
  captureType,
  sourceName,
  sourceRegion = null,
  captureSequence = Date.now()
}, externalClient = null) {
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('1X2 batch rows required.');
  }
  if (!Number.isSafeInteger(Number(captureSequence)) || Number(captureSequence) <= 0) {
    throw new Error('Invalid 1X2 batch sequence.');
  }

  const ownClient = !externalClient;
  const client = externalClient || await pool.connect();
  const saved = [];

  try {
    if (ownClient) await client.query('BEGIN');

    for (const row of rows) {
      const snapshot = {
        eventId,
        bookmakerId: row.bookmakerId,
        bookmakerName: row.bookmakerName,
        homeOdd: row.homeOdd,
        drawOdd: row.drawOdd,
        awayOdd: row.awayOdd,
        capturedAt: row.capturedAt,
        captureSequence: Number(captureSequence),
        captureType,
        sourceName,
        sourceRegion
      };
      validateOdds1x2Snapshot(snapshot);

      const bookmakerKey = normalizeBookmakerKey(
        snapshot.bookmakerId || snapshot.bookmakerName
      );
      const result = await client.query(`
        INSERT INTO odds_1x2_snapshots(
          event_id,bookmaker_id,bookmaker_key,bookmaker_name,market,
          home_odd,draw_odd,away_odd,captured_at,capture_sequence,
          capture_type,source_name,source_region
        )
        VALUES($1,$2,$3,$4,'1X2',$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT DO NOTHING
        RETURNING *
      `, [
        String(snapshot.eventId).trim(),
        snapshot.bookmakerId ? String(snapshot.bookmakerId).trim() : null,
        bookmakerKey,
        String(snapshot.bookmakerName).trim(),
        Number(snapshot.homeOdd),
        Number(snapshot.drawOdd),
        Number(snapshot.awayOdd),
        new Date(snapshot.capturedAt),
        Number(snapshot.captureSequence),
        snapshot.captureType,
        String(snapshot.sourceName).trim(),
        snapshot.sourceRegion ? String(snapshot.sourceRegion).trim() : null
      ]);

      if (result.rows[0]) saved.push(result.rows[0]);
    }

    if (ownClient) await client.query('COMMIT');
    return {
      captureSequence: Number(captureSequence),
      inserted: saved.length,
      rows: saved
    };
  } catch (error) {
    if (ownClient) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownClient) client.release();
  }
}

async function getPerformanceCache(eventId) {
  const r = await pool.query(
    `SELECT event_id,payload,status,error,created_at,updated_at
     FROM performance_cache
     WHERE event_id=$1`,
    [eventId]
  );
  return r.rows[0] || null;
}

async function markPerformancePreparing(eventId) {
  const r = await pool.query(`
    INSERT INTO performance_cache(event_id,status,error,created_at,updated_at)
    VALUES($1,'preparing',NULL,NOW(),NOW())
    ON CONFLICT(event_id) DO UPDATE SET
      status='preparing',
      error=NULL,
      updated_at=NOW()
    RETURNING event_id,payload,status,error,created_at,updated_at
  `, [eventId]);
  return r.rows[0];
}

async function savePerformanceCache(eventId, payload) {
  const r = await pool.query(`
    INSERT INTO performance_cache(event_id,payload,status,error,created_at,updated_at)
    VALUES($1,$2::jsonb,'ready',NULL,NOW(),NOW())
    ON CONFLICT(event_id) DO UPDATE SET
      payload=EXCLUDED.payload,
      status='ready',
      error=NULL,
      updated_at=NOW()
    RETURNING event_id,payload,status,error,created_at,updated_at
  `, [eventId, JSON.stringify(payload)]);
  return r.rows[0];
}

async function failPerformanceCache(eventId, error) {
  const r = await pool.query(`
    INSERT INTO performance_cache(event_id,status,error,created_at,updated_at)
    VALUES($1,'failed',$2,NOW(),NOW())
    ON CONFLICT(event_id) DO UPDATE SET
      status='failed',
      error=EXCLUDED.error,
      updated_at=NOW()
    RETURNING event_id,payload,status,error,created_at,updated_at
  `, [eventId, String(error || 'Bilinmeyen performans hatası').slice(0,2000)]);
  return r.rows[0];
}

module.exports = {
  pool, initDb, upsertMatch, listMatches, setActive,
  setMatchLifecycle, archiveStartedMatch, finishMatch,
  saveOdds1x2Snapshot, saveOdds1x2Batch,
  getTrackingSettings, updateTrackingSettings, getLatestOdds1x2Batch,
  listOdds1x2History,
  listDueTrackingJobs, markTrackingAttempt, markTrackingSuccess, markTrackingFailure,
  getPerformanceCache, markPerformancePreparing, savePerformanceCache, failPerformanceCache
};
