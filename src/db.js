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
      home_closed BOOLEAN NOT NULL DEFAULT FALSE,
      draw_closed BOOLEAN NOT NULL DEFAULT FALSE,
      away_closed BOOLEAN NOT NULL DEFAULT FALSE,
      captured_at TIMESTAMPTZ NOT NULL,
      capture_sequence BIGINT NOT NULL CHECK (capture_sequence > 0),
      capture_type TEXT NOT NULL CHECK (capture_type IN ('opening','current','periodic')),
      source_name TEXT NOT NULL,
      source_region TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE odds_1x2_snapshots
      ADD COLUMN IF NOT EXISTS home_closed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE odds_1x2_snapshots
      ADD COLUMN IF NOT EXISTS draw_closed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE odds_1x2_snapshots
      ADD COLUMN IF NOT EXISTS away_closed BOOLEAN NOT NULL DEFAULT FALSE;

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

    CREATE TABLE IF NOT EXISTS odds_over_under_snapshots (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES matches(event_id) ON DELETE CASCADE,
      bookmaker_id TEXT,
      bookmaker_key TEXT NOT NULL,
      bookmaker_name TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'OVER_UNDER'
        CHECK (market = 'OVER_UNDER'),
      total_line NUMERIC(3,1) NOT NULL
        CHECK (total_line IN (1.5, 2.5)),
      under_odd NUMERIC(12,4) NOT NULL CHECK (under_odd > 1),
      over_odd NUMERIC(12,4) NOT NULL CHECK (over_odd > 1),
      under_closed BOOLEAN NOT NULL DEFAULT FALSE,
      over_closed BOOLEAN NOT NULL DEFAULT FALSE,
      captured_at TIMESTAMPTZ NOT NULL,
      capture_sequence BIGINT NOT NULL CHECK (capture_sequence > 0),
      capture_type TEXT NOT NULL
        CHECK (capture_type IN ('opening','current','periodic')),
      source_name TEXT NOT NULL,
      source_region TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_odds_over_under_time
      ON odds_over_under_snapshots(
        event_id, bookmaker_key, total_line, captured_at, capture_type
      );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_odds_over_under_sequence
      ON odds_over_under_snapshots(
        event_id, bookmaker_key, total_line, capture_sequence, capture_type
      );

    CREATE INDEX IF NOT EXISTS idx_odds_over_under_match_time
      ON odds_over_under_snapshots(
        event_id, total_line, captured_at DESC
      );

    CREATE INDEX IF NOT EXISTS idx_odds_over_under_bookmaker_history
      ON odds_over_under_snapshots(
        event_id, bookmaker_key, total_line, captured_at DESC, id DESC
      );


    CREATE TABLE IF NOT EXISTS odds_asian_snapshots (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES matches(event_id) ON DELETE CASCADE,
      bookmaker_id TEXT,
      bookmaker_key TEXT NOT NULL,
      bookmaker_name TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'ASIAN_HANDICAP'
        CHECK (market = 'ASIAN_HANDICAP'),
      handicap_line NUMERIC(6,2) NOT NULL,
      home_odd NUMERIC(12,4) NOT NULL CHECK (home_odd > 1),
      away_odd NUMERIC(12,4) NOT NULL CHECK (away_odd > 1),
      home_closed BOOLEAN NOT NULL DEFAULT FALSE,
      away_closed BOOLEAN NOT NULL DEFAULT FALSE,
      captured_at TIMESTAMPTZ NOT NULL,
      capture_sequence BIGINT NOT NULL CHECK (capture_sequence > 0),
      capture_type TEXT NOT NULL
        CHECK (capture_type IN ('opening','current','periodic')),
      source_name TEXT NOT NULL,
      source_region TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_odds_asian_time
      ON odds_asian_snapshots(
        event_id,
        bookmaker_key,
        handicap_line,
        captured_at,
        capture_type
      );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_odds_asian_sequence
      ON odds_asian_snapshots(
        event_id,
        bookmaker_key,
        handicap_line,
        capture_sequence,
        capture_type
      );

    CREATE INDEX IF NOT EXISTS idx_odds_asian_match_time
      ON odds_asian_snapshots(
        event_id,
        handicap_line,
        captured_at DESC
      );

    CREATE INDEX IF NOT EXISTS idx_odds_asian_bookmaker_history
      ON odds_asian_snapshots(
        event_id,
        bookmaker_key,
        handicap_line,
        captured_at DESC,
        id DESC
      );

    CREATE TABLE IF NOT EXISTS odds_kg_snapshots (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES matches(event_id) ON DELETE CASCADE,
      bookmaker_id TEXT,
      bookmaker_key TEXT NOT NULL,
      bookmaker_name TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'BTTS'
        CHECK (market = 'BTTS'),
      yes_odd NUMERIC(12,4) NOT NULL CHECK (yes_odd > 1),
      no_odd NUMERIC(12,4) NOT NULL CHECK (no_odd > 1),
      yes_closed BOOLEAN NOT NULL DEFAULT FALSE,
      no_closed BOOLEAN NOT NULL DEFAULT FALSE,
      captured_at TIMESTAMPTZ NOT NULL,
      capture_sequence BIGINT NOT NULL CHECK (capture_sequence > 0),
      capture_type TEXT NOT NULL
        CHECK (capture_type IN ('opening','current','periodic')),
      source_name TEXT NOT NULL,
      source_region TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_odds_kg_time
      ON odds_kg_snapshots(
        event_id,
        bookmaker_key,
        captured_at,
        capture_type
      );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_odds_kg_sequence
      ON odds_kg_snapshots(
        event_id,
        bookmaker_key,
        capture_sequence,
        capture_type
      );

    CREATE INDEX IF NOT EXISTS idx_odds_kg_match_time
      ON odds_kg_snapshots(
        event_id,
        captured_at DESC
      );

    CREATE INDEX IF NOT EXISTS idx_odds_kg_bookmaker_history
      ON odds_kg_snapshots(
        event_id,
        bookmaker_key,
        captured_at DESC,
        id DESC
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
      ADD COLUMN IF NOT EXISTS last_success_sequence BIGINT;
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
    `SELECT * FROM matches ${activeOnly ? 'WHERE active=TRUE' : ''}
     ORDER BY match_date ASC NULLS LAST, kickoff_time ASC NULLS LAST, display_name ASC NULLS LAST`
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
    WITH updated AS (
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
    ),
    tracking_disabled AS (
      UPDATE odds_tracking_settings s
      SET tracking_enabled=FALSE,
          next_pull_at=NULL,
          updated_at=NOW()
      FROM updated u
      WHERE s.event_id=u.event_id
        AND (
          u.active=FALSE OR
          COALESCE(u.archived,FALSE)=TRUE OR
          COALESCE(u.lifecycle,'tracking') IN ('started','finished','removed')
        )
      RETURNING s.event_id
    )
    SELECT * FROM updated
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

async function removeTrackedMatch(eventId) {
  const id = String(eventId || '').trim();
  if (!id) return null;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(`
      UPDATE matches
      SET active=FALSE,
          archived=FALSE,
          lifecycle='removed',
          updated_at=NOW()
      WHERE event_id=$1
      RETURNING *
    `, [id]);

    const match = result.rows[0] || null;

    if (!match) {
      await client.query('ROLLBACK');
      return null;
    }

    await client.query(
      `DELETE FROM odds_tracking_settings WHERE event_id=$1`,
      [id]
    );

    await client.query(
      `DELETE FROM odds_1x2_snapshots WHERE event_id=$1`,
      [id]
    );

    await client.query(
      `DELETE FROM performance_cache WHERE event_id=$1`,
      [id]
    );

    await client.query('COMMIT');
    return match;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
            last_attempt_at,last_success_at,last_success_sequence,next_pull_at,last_error,
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
           CASE WHEN $2 THEN NOW() ELSE NULL END,
           NULL,NOW(),NOW()
    FROM matches
    WHERE event_id=$1
    ON CONFLICT(event_id) DO UPDATE SET
      tracking_enabled=EXCLUDED.tracking_enabled,
      refresh_minutes=EXCLUDED.refresh_minutes,
      next_pull_at=CASE
        WHEN NOT EXCLUDED.tracking_enabled THEN NULL
        WHEN odds_tracking_settings.tracking_enabled=TRUE
          AND odds_tracking_settings.refresh_minutes=EXCLUDED.refresh_minutes
          THEN COALESCE(odds_tracking_settings.next_pull_at,NOW())
        ELSE NOW()
      END,
      last_error=CASE
        WHEN EXCLUDED.tracking_enabled=TRUE
          AND odds_tracking_settings.tracking_enabled=TRUE
          AND odds_tracking_settings.refresh_minutes=EXCLUDED.refresh_minutes
          THEN odds_tracking_settings.last_error
        ELSE NULL
      END,
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

async function markTrackingSuccess(eventId, captureSequence = null) {
  const r = await pool.query(`
    UPDATE odds_tracking_settings
    SET last_success_at=NOW(),
        last_success_sequence=$2,
        next_pull_at=NOW() + (refresh_minutes * INTERVAL '1 minute'),
        last_error=NULL,
        updated_at=NOW()
    WHERE event_id=$1 AND tracking_enabled=TRUE
    RETURNING *
  `, [String(eventId || '').trim(), captureSequence]);
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
  // CONTRACT_RAW_READER: use the single raw store for revised tracking.
  const contractRead = require('./oddsContract/quoteReader').readRuntimeBatch(
    eventId, '1X2', {captureType,latestOnly:true}
  );
  if (contractRead.handled) return contractRead.batch;

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
            home_closed,draw_closed,away_closed,
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

async function getLatestLiveOdds1x2State(eventId) {
  // CONTRACT_RAW_READER: use the single raw store for revised tracking.
  const contractRead = require('./oddsContract/quoteReader').readRuntimeBatch(
    eventId, '1X2', {captureType:'current',latestOnly:false}
  );
  if (contractRead.handled) return contractRead.batch;

  const id = String(eventId || '').trim();
  if (!id) throw new Error('Invalid match id.');

  const result = await pool.query(
    `SELECT DISTINCT ON (bookmaker_key)
            bookmaker_id,bookmaker_key,bookmaker_name,
            home_odd,draw_odd,away_odd,
            home_closed,draw_closed,away_closed,
            captured_at,capture_sequence,capture_type,
            source_name,source_region
     FROM odds_1x2_snapshots
     WHERE event_id=$1
       AND capture_type IN ('current','periodic')
     ORDER BY bookmaker_key,captured_at DESC,capture_sequence DESC,id DESC`,
    [id]
  );

  if (!result.rows.length) return null;

  const rows = result.rows.sort((a, b) =>
    String(a.bookmaker_name || '').localeCompare(String(b.bookmaker_name || ''))
  );

  const newest = rows.reduce((latest, row) => {
    if (!latest) return row;
    const rowMs = new Date(row.captured_at).getTime();
    const latestMs = new Date(latest.captured_at).getTime();
    if (rowMs > latestMs) return row;
    if (rowMs < latestMs) return latest;
    return BigInt(String(row.capture_sequence || '0')) >
      BigInt(String(latest.capture_sequence || '0'))
      ? row
      : latest;
  }, null);

  return {
    capture_sequence: String(newest.capture_sequence),
    capture_type: newest.capture_type,
    captured_at: newest.captured_at,
    source_name: newest.source_name,
    source_region: newest.source_region,
    rows
  };
}

async function listOdds1x2History({
  eventId,
  bookmaker = null,
  sourceContextId = undefined,
  period = undefined,
  priceType = undefined,
  page = 1,
  pageSize = 50
}) {
  const contractHistory = require('./oddsContract/quoteReader').readRuntimeHistory(
    eventId, '1X2', {bookmaker,page,pageSize,sourceContextId,period,priceType}
  );
  if (contractHistory.handled) return contractHistory.history;

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
            home_odd,draw_odd,away_odd,home_closed,draw_closed,away_closed,
            captured_at,capture_sequence,capture_type,source_name,source_region
     FROM odds_1x2_snapshots
     WHERE ${where}
     ORDER BY captured_at DESC, capture_sequence DESC, id DESC
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
      home_odd,draw_odd,away_odd,home_closed,draw_closed,away_closed,
      captured_at,capture_sequence,capture_type,source_name,source_region
    )
    VALUES($1,$2,$3,$4,'1X2',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
    snapshot.homeClosed === true,
    snapshot.drawClosed === true,
    snapshot.awayClosed === true,
    new Date(snapshot.capturedAt),
    Number(snapshot.captureSequence),
    snapshot.captureType,
    String(snapshot.sourceName).trim(),
    snapshot.sourceRegion ? String(snapshot.sourceRegion).trim() : null
  ]);

  
  return r.rows[0] || null;
}


function validateOddsOverUnderSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Over/Under snapshot required.');
  }

  if (!String(snapshot.eventId || '').trim()) {
    throw new Error('Over/Under eventId required.');
  }

  if (!String(snapshot.bookmakerName || '').trim()) {
    throw new Error('Over/Under bookmakerName required.');
  }

  const totalLine = Number(snapshot.totalLine);
  if (totalLine !== 1.5 && totalLine !== 2.5) {
    throw new Error('Over/Under totalLine must be 1.5 or 2.5.');
  }

  const underOdd = Number(snapshot.underOdd);
  const overOdd = Number(snapshot.overOdd);

  if (!Number.isFinite(underOdd) || underOdd <= 1) {
    throw new Error('Over/Under underOdd must be greater than 1.');
  }

  if (!Number.isFinite(overOdd) || overOdd <= 1) {
    throw new Error('Over/Under overOdd must be greater than 1.');
  }

  const capturedAt = new Date(snapshot.capturedAt);
  if (Number.isNaN(capturedAt.getTime())) {
    throw new Error('Over/Under capturedAt is invalid.');
  }

  const captureSequence = Number(snapshot.captureSequence);
  if (!Number.isFinite(captureSequence) || captureSequence <= 0) {
    throw new Error('Over/Under captureSequence must be positive.');
  }

  if (!['opening', 'current', 'periodic'].includes(snapshot.captureType)) {
    throw new Error('Over/Under captureType is invalid.');
  }

  if (!String(snapshot.sourceName || '').trim()) {
    throw new Error('Over/Under sourceName required.');
  }
}

async function saveOddsOverUnderSnapshot(snapshot) {
  validateOddsOverUnderSnapshot(snapshot);

  const result = await saveOddsOverUnderBatch({
    eventId: snapshot.eventId,
    rows: [snapshot],
    captureType: snapshot.captureType,
    sourceName: snapshot.sourceName,
    sourceRegion: snapshot.sourceRegion || null,
    captureSequence: Number(snapshot.captureSequence)
  });

  return result.rows[0] || null;
}

async function saveOddsOverUnderBatch({
  eventId,
  rows,
  captureType,
  sourceName,
  sourceRegion = null,
  captureSequence = Date.now()
}) {
  if (!String(eventId || '').trim()) {
    throw new Error('Over/Under batch eventId required.');
  }

  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('Over/Under batch rows required.');
  }

  if (!['opening', 'current', 'periodic'].includes(captureType)) {
    throw new Error('Over/Under batch captureType is invalid.');
  }

  if (!String(sourceName || '').trim()) {
    throw new Error('Over/Under batch sourceName required.');
  }

  const client = await pool.connect();
  const previousByMarket = new Map();
  const saved = [];

  try {
    await client.query('BEGIN');

    if (captureType === 'periodic') {
      const previous = await client.query(
        `SELECT DISTINCT ON (bookmaker_key,total_line)
           bookmaker_key,total_line,
           under_odd,over_odd,under_closed,over_closed
         FROM odds_over_under_snapshots
         WHERE event_id=$1
           AND capture_type IN ('current','periodic')
         ORDER BY bookmaker_key,total_line,
                  captured_at DESC,capture_sequence DESC,id DESC`,
        [String(eventId).trim()]
      );

      for (const row of previous.rows) {
        const previousKey =
          row.bookmaker_key + '|' + Number(row.total_line).toFixed(1);
        previousByMarket.set(previousKey, row);
      }
    }

    for (const row of rows) {
      const snapshot = {
        eventId,
        bookmakerId: row.bookmakerId || null,
        bookmakerName: row.bookmakerName,
        totalLine: Number(row.totalLine),
        underOdd: row.underOdd,
        overOdd: row.overOdd,
        underClosed: row.underClosed === true,
        overClosed: row.overClosed === true,
        capturedAt: row.capturedAt,
        captureSequence: Number(captureSequence),
        captureType,
        sourceName,
        sourceRegion
      };

      validateOddsOverUnderSnapshot(snapshot);

      const bookmakerKey = normalizeBookmakerKey(
        snapshot.bookmakerId || snapshot.bookmakerName
      );

      const marketKey =
        bookmakerKey + '|' + Number(snapshot.totalLine).toFixed(1);

    // Her gerçek çekim, fiyat aynı olsa da yeni zamanıyla kaydedilir.

      const result = await client.query(
        `INSERT INTO odds_over_under_snapshots(
           event_id,bookmaker_id,bookmaker_key,bookmaker_name,market,
           total_line,under_odd,over_odd,under_closed,over_closed,
           captured_at,capture_sequence,capture_type,source_name,source_region
         )
         VALUES(
           $1,$2,$3,$4,'OVER_UNDER',
           $5,$6,$7,$8,$9,
           $10,$11,$12,$13,$14
         )
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          String(snapshot.eventId).trim(),
          snapshot.bookmakerId
            ? String(snapshot.bookmakerId).trim()
            : null,
          bookmakerKey,
          String(snapshot.bookmakerName).trim(),
          Number(snapshot.totalLine),
          Number(snapshot.underOdd),
          Number(snapshot.overOdd),
          snapshot.underClosed === true,
          snapshot.overClosed === true,
          new Date(snapshot.capturedAt),
          Number(snapshot.captureSequence),
          snapshot.captureType,
          String(snapshot.sourceName).trim(),
          snapshot.sourceRegion
            ? String(snapshot.sourceRegion).trim()
            : null
        ]
      );

      if (result.rows[0]) {
        saved.push(result.rows[0]);
      }
    }

    await client.query('COMMIT');

    return {
      captureSequence: Number(captureSequence),
      inserted: saved.length,
      rows: saved
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
        homeClosed: row.homeClosed === true,
        drawClosed: row.drawClosed === true,
        awayClosed: row.awayClosed === true,
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

      // Each fetched observation keeps its own capture time, even when odds are unchanged.
      const result = await client.query(`
        INSERT INTO odds_1x2_snapshots(
          event_id,bookmaker_id,bookmaker_key,bookmaker_name,market,
          home_odd,draw_odd,away_odd,home_closed,draw_closed,away_closed,
          captured_at,capture_sequence,capture_type,source_name,source_region
        )
        VALUES($1,$2,$3,$4,'1X2',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
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
        snapshot.homeClosed === true,
        snapshot.drawClosed === true,
        snapshot.awayClosed === true,
        new Date(snapshot.capturedAt),
        Number(snapshot.captureSequence),
        snapshot.captureType,
        String(snapshot.sourceName).trim(),
        snapshot.sourceRegion ? String(snapshot.sourceRegion).trim() : null
      ]);

      if (result.rows[0]) {
        saved.push(result.rows[0]);
      }
    }

    if (ownClient) {
      await client.query('COMMIT');
      
    }
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


async function getLatestOddsOverUnderBatch(
  eventId,
  captureType,
  totalLine = null
) {
  // CONTRACT_RAW_READER: use the single raw store for revised tracking.
  const contractRead = require('./oddsContract/quoteReader').readRuntimeBatch(
    eventId, 'OU', {captureType,latestOnly:true,line:totalLine}
  );
  if (contractRead.handled) return contractRead.batch;

  const id = String(eventId || '').trim();
  const type = String(captureType || '').trim();

  if (
    !id ||
    !['opening', 'current', 'periodic'].includes(type)
  ) {
    throw new Error('Geçersiz Alt/Üst snapshot sorgusu.');
  }

  const line =
    totalLine === null || totalLine === undefined
      ? null
      : Number(totalLine);

  if (
    line !== null &&
    line !== 1.5 &&
    line !== 2.5
  ) {
    throw new Error('Alt/Üst çizgisi yalnız 1.5 veya 2.5 olabilir.');
  }

  const latestParams = [id, type];
  let latestWhere =
    'event_id=$1 AND capture_type=$2';

  if (line !== null) {
    latestParams.push(line);
    latestWhere += ' AND total_line=$3';
  }

  const latest = await pool.query(
    `SELECT capture_sequence
     FROM odds_over_under_snapshots
     WHERE ${latestWhere}
     ORDER BY capture_sequence DESC
     LIMIT 1`,
    latestParams
  );

  if (!latest.rows[0]) return null;

  const sequence = latest.rows[0].capture_sequence;

  const rowParams = [id, type, sequence];
  let rowWhere =
    'event_id=$1 AND capture_type=$2 AND capture_sequence=$3';

  if (line !== null) {
    rowParams.push(line);
    rowWhere += ' AND total_line=$4';
  }

  const rows = await pool.query(
    `SELECT
       bookmaker_id,
       bookmaker_key,
       bookmaker_name,
       total_line,
       under_odd,
       over_odd,
       under_closed,
       over_closed,
       captured_at,
       capture_sequence,
       capture_type,
       source_name,
       source_region
     FROM odds_over_under_snapshots
     WHERE ${rowWhere}
     ORDER BY total_line ASC, bookmaker_name ASC`,
    rowParams
  );

  if (!rows.rows.length) return null;

  const maxCapturedAt = rows.rows.reduce(
    (max, row) => {
      const ms = new Date(row.captured_at).getTime();
      return Number.isFinite(ms) && ms > max ? ms : max;
    },
    0
  );

  return {
    capture_sequence: String(sequence),
    capture_type: type,
    captured_at:
      maxCapturedAt
        ? new Date(maxCapturedAt)
        : rows.rows[0].captured_at,
    source_name: rows.rows[0].source_name,
    source_region: rows.rows[0].source_region,
    total_line: line,
    rows: rows.rows
  };
}

async function getLatestLiveOddsOverUnderState(
  eventId,
  totalLine = null
) {
  // CONTRACT_RAW_READER: use the single raw store for revised tracking.
  const contractRead = require('./oddsContract/quoteReader').readRuntimeBatch(
    eventId, 'OU', {captureType:'current',latestOnly:false,line:totalLine}
  );
  if (contractRead.handled) return contractRead.batch;

  const id = String(eventId || '').trim();

  if (!id) {
    throw new Error('Invalid match id.');
  }

  const line =
    totalLine === null || totalLine === undefined
      ? null
      : Number(totalLine);

  if (
    line !== null &&
    line !== 1.5 &&
    line !== 2.5
  ) {
    throw new Error('Alt/Üst çizgisi yalnız 1.5 veya 2.5 olabilir.');
  }

  const params = [id];
  let where =
    "event_id=$1 AND capture_type IN ('current','periodic')";

  if (line !== null) {
    params.push(line);
    where += ' AND total_line=$2';
  }

  const result = await pool.query(
    `SELECT DISTINCT ON (bookmaker_key,total_line)
       bookmaker_id,
       bookmaker_key,
       bookmaker_name,
       total_line,
       under_odd,
       over_odd,
       under_closed,
       over_closed,
       captured_at,
       capture_sequence,
       capture_type,
       source_name,
       source_region
     FROM odds_over_under_snapshots
     WHERE ${where}
     ORDER BY
       bookmaker_key,
       total_line,
       captured_at DESC,
       capture_sequence DESC,
       id DESC`,
    params
  );

  if (!result.rows.length) return null;

  const rows = result.rows.sort((a, b) => {
    const la = Number(a.total_line);
    const lb = Number(b.total_line);

    if (la !== lb) return la - lb;

    return String(a.bookmaker_name || '')
      .localeCompare(String(b.bookmaker_name || ''));
  });

  const newest = rows.reduce((latest, row) => {
    if (!latest) return row;

    const rowMs =
      new Date(row.captured_at).getTime();

    const latestMs =
      new Date(latest.captured_at).getTime();

    if (rowMs > latestMs) return row;
    if (rowMs < latestMs) return latest;

    return BigInt(
      String(row.capture_sequence || '0')
    ) >
    BigInt(
      String(latest.capture_sequence || '0')
    )
      ? row
      : latest;
  }, null);

  return {
    capture_sequence:
      String(newest.capture_sequence),
    capture_type:
      newest.capture_type,
    captured_at:
      newest.captured_at,
    source_name:
      newest.source_name,
    source_region:
      newest.source_region,
    total_line:
      line,
    rows
  };
}

async function listOddsOverUnderHistory({
  eventId,
  bookmaker = null,
  totalLine = null,
  sourceContextId = undefined,
  period = undefined,
  priceType = undefined,
  page = 1,
  pageSize = 50
}) {
  const contractHistory = require('./oddsContract/quoteReader').readRuntimeHistory(
    eventId, 'OU', {bookmaker,page,pageSize,sourceContextId,period,priceType,line:totalLine}
  );
  if (contractHistory.handled) return contractHistory.history;

  const id = String(eventId || '').trim();

  if (!id) {
    throw new Error('Invalid match id.');
  }

  const safePage =
    Math.max(
      1,
      Math.min(100000, Number(page) || 1)
    );

  const safePageSize = 50;

  const bookmakerKey =
    bookmaker
      ? normalizeBookmakerKey(bookmaker)
      : null;

  if (bookmaker && !bookmakerKey) {
    throw new Error('Invalid bookmaker.');
  }

  const line =
    totalLine === null || totalLine === undefined
      ? null
      : Number(totalLine);

  if (
    line !== null && (!Number.isFinite(line) || line < 0)
  ) {
    throw new Error('Geçersiz Alt/Üst çizgisi.');
  }

  const clauses = ['event_id=$1'];
  const params = [id];

  if (bookmakerKey) {
    params.push(bookmakerKey);
    clauses.push(
      `bookmaker_key=$${params.length}`
    );
  }

  if (line !== null) {
    params.push(line);
    clauses.push(
      `total_line=$${params.length}`
    );
  }

  const where = clauses.join(' AND ');

  const countResult = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM odds_over_under_snapshots
     WHERE ${where}`,
    params
  );

  const totalRecords =
    Number(countResult.rows[0]?.total || 0);

  const totalPages =
    Math.ceil(totalRecords / safePageSize);

  const offset =
    (safePage - 1) * safePageSize;

  const limitParam =
    params.length + 1;

  const offsetParam =
    params.length + 2;

  const rowsResult = await pool.query(
    `SELECT
       id,
       event_id,
       bookmaker_id,
       bookmaker_key,
       bookmaker_name,
       market,
       total_line,
       under_odd,
       over_odd,
       under_closed,
       over_closed,
       captured_at,
       capture_sequence,
       capture_type,
       source_name,
       source_region
     FROM odds_over_under_snapshots
     WHERE ${where}
     ORDER BY
       captured_at DESC,
       capture_sequence DESC,
       id DESC
     LIMIT $${limitParam}
     OFFSET $${offsetParam}`,
    [
      ...params,
      safePageSize,
      offset
    ]
  );

  return {
    bookmaker_key: bookmakerKey,
    total_line: line,
    page: safePage,
    page_size: safePageSize,
    total_records: totalRecords,
    total_pages: totalPages,
    has_previous:
      safePage > 1 && totalRecords > 0,
    has_next:
      safePage < totalPages,
    rows: rowsResult.rows
  };
}


async function saveOddsAsianBatch({
  eventId,
  rows,
  capturedAt = new Date(),
  captureType = 'current',
  sourceName,
  sourceRegion = null,
  captureSequence = Date.now()
}) {
  if (!eventId) {
    throw new Error('eventId is required');
  }

  if (!Array.isArray(rows)) {
    throw new Error('rows must be an array');
  }

  if (
    !['opening', 'current', 'periodic']
      .includes(captureType)
  ) {
    throw new Error(
      'Invalid Asian captureType'
    );
  }

  if (!sourceName) {
    throw new Error(
      'Asian sourceName is required'
    );
  }

  const normalized = new Map();

  for (const row of rows) {
    const bookmakerKey = String(
      row.bookmakerKey ??
      row.bookmaker_key ??
      ''
    ).trim().toLowerCase();

    const bookmakerName = String(
      row.bookmakerName ??
      row.bookmaker_name ??
      ''
    ).trim();

    const handicapLine = Number(
      row.handicapLine ??
      row.handicap_line
    );

    const homeOdd = Number(
      row.homeOdd ??
      row.home_odd
    );

    const awayOdd = Number(
      row.awayOdd ??
      row.away_odd
    );

    if (
      !bookmakerKey ||
      !bookmakerName ||
      !Number.isFinite(handicapLine) ||
      !(homeOdd > 1) ||
      !(awayOdd > 1)
    ) {
      continue;
    }

    normalized.set(
      bookmakerKey +
        '|' +
        handicapLine.toFixed(2),
      {
        bookmakerId: String(
          row.bookmakerId ??
          row.bookmaker_id ??
          ''
        ),
        bookmakerKey,
        bookmakerName,
        handicapLine,
        homeOdd,
        awayOdd,
        homeClosed: Boolean(
          row.homeClosed ??
          row.home_closed ??
          false
        ),
        awayClosed: Boolean(
          row.awayClosed ??
          row.away_closed ??
          false
        ),
        capturedAt:
          row.capturedAt ??
          row.captured_at ??
          capturedAt
      }
    );
  }

  const saved = [];
  const previousByMarket = new Map();

  if (captureType === 'periodic') {
    const previous = await pool.query(
      `SELECT DISTINCT ON (bookmaker_key,handicap_line)
         bookmaker_key,handicap_line,
         home_odd,away_odd,home_closed,away_closed
       FROM odds_asian_snapshots
       WHERE event_id=$1
         AND capture_type IN ('current','periodic')
       ORDER BY bookmaker_key,handicap_line,
                captured_at DESC,capture_sequence DESC,id DESC`,
      [String(eventId).trim()]
    );

    for (const previousRow of previous.rows) {
      const previousKey =
        previousRow.bookmaker_key + '|' +
        Number(previousRow.handicap_line).toFixed(2);
      previousByMarket.set(previousKey, previousRow);
    }
  }

  for (const row of normalized.values()) {
    // Her gerçek çekim, fiyat aynı olsa da yeni zamanıyla kaydedilir.

    const result = await pool.query(
      `INSERT INTO odds_asian_snapshots(
        event_id,
        bookmaker_id,
        bookmaker_key,
        bookmaker_name,
        market,
        handicap_line,
        home_odd,
        away_odd,
        home_closed,
        away_closed,
        captured_at,
        capture_sequence,
        capture_type,
        source_name,
        source_region
      )
      VALUES(
        $1,$2,$3,$4,
        'ASIAN_HANDICAP',
        $5,$6,$7,$8,$9,
        $10,$11,$12,$13,$14
      )
      ON CONFLICT DO NOTHING
      RETURNING *`,
      [
        eventId,
        row.bookmakerId || null,
        row.bookmakerKey,
        row.bookmakerName,
        row.handicapLine,
        row.homeOdd,
        row.awayOdd,
        row.homeClosed,
        row.awayClosed,
        row.capturedAt,
        captureSequence,
        captureType,
        sourceName,
        sourceRegion
      ]
    );

    if (result.rows[0]) {
      saved.push(result.rows[0]);
    }
  }

  return {
    requested: rows.length,
    normalized: normalized.size,
    inserted: saved.length,
    rows: saved
  };
}

async function saveOddsAsianSnapshot(snapshot) {
  const {
    eventId,
    rows,
    ...rest
  } = snapshot;

  return saveOddsAsianBatch({
    eventId,
    rows,
    ...rest
  });
}

async function saveOddsKgBatch({
  eventId,
  rows,
  capturedAt = new Date(),
  captureType = 'current',
  sourceName,
  sourceRegion = null,
  captureSequence = Date.now()
}) {
  if (!eventId) {
    throw new Error('eventId is required');
  }

  if (!Array.isArray(rows)) {
    throw new Error('rows must be an array');
  }

  if (
    !['opening', 'current', 'periodic']
      .includes(captureType)
  ) {
    throw new Error(
      'Invalid KG captureType'
    );
  }

  if (!sourceName) {
    throw new Error(
      'KG sourceName is required'
    );
  }

  const normalized = new Map();

  for (const row of rows) {
    const bookmakerKey = String(
      row.bookmakerKey ??
      row.bookmaker_key ??
      ''
    ).trim().toLowerCase();

    const bookmakerName = String(
      row.bookmakerName ??
      row.bookmaker_name ??
      ''
    ).trim();

    const yesOdd = Number(
      row.yesOdd ??
      row.yes_odd
    );

    const noOdd = Number(
      row.noOdd ??
      row.no_odd
    );

    if (
      !bookmakerKey ||
      !bookmakerName ||
      !(yesOdd > 1) ||
      !(noOdd > 1)
    ) {
      continue;
    }

    normalized.set(
      bookmakerKey,
      {
        bookmakerId: String(
          row.bookmakerId ??
          row.bookmaker_id ??
          ''
        ),
        bookmakerKey,
        bookmakerName,
        yesOdd,
        noOdd,
        yesClosed: Boolean(
          row.yesClosed ??
          row.yes_closed ??
          false
        ),
        noClosed: Boolean(
          row.noClosed ??
          row.no_closed ??
          false
        ),
        capturedAt:
          row.capturedAt ??
          row.captured_at ??
          capturedAt
      }
    );
  }

  const saved = [];
  const previousByBookmaker = new Map();

  if (captureType === 'periodic') {
    const previous = await pool.query(
      `SELECT DISTINCT ON (bookmaker_key)
         bookmaker_key,yes_odd,no_odd,yes_closed,no_closed
       FROM odds_kg_snapshots
       WHERE event_id=$1
         AND capture_type IN ('current','periodic')
       ORDER BY bookmaker_key,
                captured_at DESC,capture_sequence DESC,id DESC`,
      [String(eventId).trim()]
    );

    for (const previousRow of previous.rows) {
      previousByBookmaker.set(previousRow.bookmaker_key, previousRow);
    }
  }

  for (const row of normalized.values()) {
    // Her gerçek çekim, fiyat aynı olsa da yeni zamanıyla kaydedilir.

    const result = await pool.query(
      `INSERT INTO odds_kg_snapshots(
        event_id,
        bookmaker_id,
        bookmaker_key,
        bookmaker_name,
        market,
        yes_odd,
        no_odd,
        yes_closed,
        no_closed,
        captured_at,
        capture_sequence,
        capture_type,
        source_name,
        source_region
      )
      VALUES(
        $1,$2,$3,$4,
        'BTTS',
        $5,$6,$7,$8,
        $9,$10,$11,$12,$13
      )
      ON CONFLICT DO NOTHING
      RETURNING *`,
      [
        eventId,
        row.bookmakerId || null,
        row.bookmakerKey,
        row.bookmakerName,
        row.yesOdd,
        row.noOdd,
        row.yesClosed,
        row.noClosed,
        row.capturedAt,
        captureSequence,
        captureType,
        sourceName,
        sourceRegion
      ]
    );

    if (result.rows[0]) {
      saved.push(result.rows[0]);
    }
  }

  return {
    requested: rows.length,
    normalized: normalized.size,
    inserted: saved.length,
    rows: saved
  };
}

async function saveOddsKgSnapshot(snapshot) {
  const {
    eventId,
    rows,
    ...rest
  } = snapshot;

  return saveOddsKgBatch({
    eventId,
    rows,
    ...rest
  });
}


async function getLatestOddsAsianBatch(
  eventId,
  captureType,
  handicapLine = null
) {
  // CONTRACT_RAW_READER: use the single raw store for revised tracking.
  const contractRead = require('./oddsContract/quoteReader').readRuntimeBatch(
    eventId, 'ASIAN', {captureType,latestOnly:true,line:handicapLine}
  );
  if (contractRead.handled) return contractRead.batch;

  const id = String(eventId || '').trim();
  const type = String(captureType || '').trim();

  if (
    !id ||
    !['opening', 'current', 'periodic'].includes(type)
  ) {
    throw new Error(
      'Geçersiz Asian snapshot sorgusu.'
    );
  }

  const line =
    handicapLine === null ||
    handicapLine === undefined
      ? null
      : Number(handicapLine);

  if (
    line !== null &&
    !Number.isFinite(line)
  ) {
    throw new Error(
      'Geçersiz Asian handicap çizgisi.'
    );
  }

  const latestParams = [id, type];

  let latestWhere =
    'event_id=$1 AND capture_type=$2';

  if (line !== null) {
    latestParams.push(line);
    latestWhere += ' AND handicap_line=$3';
  }

  const latest = await pool.query(
    `SELECT capture_sequence
     FROM odds_asian_snapshots
     WHERE ${latestWhere}
     ORDER BY capture_sequence DESC
     LIMIT 1`,
    latestParams
  );

  if (!latest.rows[0]) {
    return null;
  }

  const sequence =
    latest.rows[0].capture_sequence;

  const rowParams = [
    id,
    type,
    sequence
  ];

  let rowWhere =
    'event_id=$1 AND capture_type=$2 AND capture_sequence=$3';

  if (line !== null) {
    rowParams.push(line);
    rowWhere += ' AND handicap_line=$4';
  }

  const rows = await pool.query(
    `SELECT
       bookmaker_id,
       bookmaker_key,
       bookmaker_name,
       handicap_line,
       home_odd,
       away_odd,
       home_closed,
       away_closed,
       captured_at,
       capture_sequence,
       capture_type,
       source_name,
       source_region
     FROM odds_asian_snapshots
     WHERE ${rowWhere}
     ORDER BY
       handicap_line ASC,
       bookmaker_name ASC`,
    rowParams
  );

  if (!rows.rows.length) {
    return null;
  }

  const maxCapturedAt =
    rows.rows.reduce(
      (max, row) => {
        const ms =
          new Date(
            row.captured_at
          ).getTime();

        return (
          Number.isFinite(ms) &&
          ms > max
        )
          ? ms
          : max;
      },
      0
    );

  return {
    capture_sequence:
      String(sequence),
    capture_type: type,
    captured_at:
      maxCapturedAt
        ? new Date(maxCapturedAt)
        : rows.rows[0].captured_at,
    source_name:
      rows.rows[0].source_name,
    source_region:
      rows.rows[0].source_region,
    handicap_line: line,
    rows: rows.rows
  };
}

async function getLatestLiveOddsAsianState(
  eventId,
  handicapLine = null
) {
  // CONTRACT_RAW_READER: use the single raw store for revised tracking.
  const contractRead = require('./oddsContract/quoteReader').readRuntimeBatch(
    eventId, 'ASIAN', {captureType:'current',latestOnly:false,line:handicapLine}
  );
  if (contractRead.handled) return contractRead.batch;

  const id =
    String(eventId || '').trim();

  if (!id) {
    throw new Error(
      'Invalid match id.'
    );
  }

  const line =
    handicapLine === null ||
    handicapLine === undefined
      ? null
      : Number(handicapLine);

  if (
    line !== null &&
    !Number.isFinite(line)
  ) {
    throw new Error(
      'Geçersiz Asian handicap çizgisi.'
    );
  }

  const params = [id];

  let where =
    "event_id=$1 AND capture_type IN ('current','periodic')";

  if (line !== null) {
    params.push(line);
    where += ' AND handicap_line=$2';
  }

  const result = await pool.query(
    `SELECT DISTINCT ON (
       bookmaker_key,
       handicap_line
     )
       bookmaker_id,
       bookmaker_key,
       bookmaker_name,
       handicap_line,
       home_odd,
       away_odd,
       home_closed,
       away_closed,
       captured_at,
       capture_sequence,
       capture_type,
       source_name,
       source_region
     FROM odds_asian_snapshots
     WHERE ${where}
     ORDER BY
       bookmaker_key,
       handicap_line,
       captured_at DESC,
       capture_sequence DESC,
       id DESC`,
    params
  );

  if (!result.rows.length) {
    return null;
  }

  const rows =
    result.rows.sort(
      (a, b) => {
        const la =
          Number(a.handicap_line);

        const lb =
          Number(b.handicap_line);

        if (la !== lb) {
          return la - lb;
        }

        return String(
          a.bookmaker_name || ''
        ).localeCompare(
          String(
            b.bookmaker_name || ''
          )
        );
      }
    );

  const newest =
    rows.reduce(
      (latest, row) => {
        if (!latest) {
          return row;
        }

        const rowMs =
          new Date(
            row.captured_at
          ).getTime();

        const latestMs =
          new Date(
            latest.captured_at
          ).getTime();

        if (rowMs > latestMs) {
          return row;
        }

        if (rowMs < latestMs) {
          return latest;
        }

        return (
          BigInt(
            String(
              row.capture_sequence ||
              '0'
            )
          ) >
          BigInt(
            String(
              latest.capture_sequence ||
              '0'
            )
          )
        )
          ? row
          : latest;
      },
      null
    );

  return {
    capture_sequence:
      String(
        newest.capture_sequence
      ),
    capture_type:
      newest.capture_type,
    captured_at:
      newest.captured_at,
    source_name:
      newest.source_name,
    source_region:
      newest.source_region,
    handicap_line: line,
    rows
  };
}

async function listOddsAsianHistory({
  eventId,
  bookmaker = null,
  handicapLine = null,
  sourceContextId = undefined,
  period = undefined,
  priceType = undefined,
  sourceLine = null,
  page = 1,
  pageSize = 50
}) {
  const contractHistory = require('./oddsContract/quoteReader').readRuntimeHistory(
    eventId, 'ASIAN', {bookmaker,page,pageSize,sourceContextId,period,priceType,line:handicapLine,sourceLine}
  );
  if (contractHistory.handled) return contractHistory.history;

  const id =
    String(eventId || '').trim();

  if (!id) {
    throw new Error(
      'Invalid match id.'
    );
  }

  const safePage =
    Math.max(
      1,
      Math.min(
        100000,
        Number(page) || 1
      )
    );

  const requestedPageSize =
    Number(pageSize) || 50;

  const safePageSize =
    Math.max(
      1,
      Math.min(
        500,
        requestedPageSize
      )
    );

  const bookmakerKey =
    bookmaker
      ? normalizeBookmakerKey(
          bookmaker
        )
      : null;

  if (
    bookmaker &&
    !bookmakerKey
  ) {
    throw new Error(
      'Invalid bookmaker.'
    );
  }

  const line =
    handicapLine === null ||
    handicapLine === undefined
      ? null
      : Number(handicapLine);

  if (
    line !== null &&
    !Number.isFinite(line)
  ) {
    throw new Error(
      'Geçersiz Asian handicap çizgisi.'
    );
  }

  const clauses = [
    'event_id=$1'
  ];

  const params = [id];

  if (bookmakerKey) {
    params.push(bookmakerKey);

    clauses.push(
      `bookmaker_key=$${params.length}`
    );
  }

  if (line !== null) {
    params.push(line);

    clauses.push(
      `handicap_line=$${params.length}`
    );
  }

  const where =
    clauses.join(' AND ');

  const countResult =
    await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM odds_asian_snapshots
       WHERE ${where}`,
      params
    );

  const totalRecords =
    Number(
      countResult.rows[0]?.total ||
      0
    );

  const totalPages =
    Math.ceil(
      totalRecords /
      safePageSize
    );

  const offset =
    (safePage - 1) *
    safePageSize;

  const limitParam =
    params.length + 1;

  const offsetParam =
    params.length + 2;

  const rowsResult =
    await pool.query(
      `SELECT
         id,
         event_id,
         bookmaker_id,
         bookmaker_key,
         bookmaker_name,
         market,
         handicap_line,
         home_odd,
         away_odd,
         home_closed,
         away_closed,
         captured_at,
         capture_sequence,
         capture_type,
         source_name,
         source_region
       FROM odds_asian_snapshots
       WHERE ${where}
       ORDER BY
         captured_at DESC,
         capture_sequence DESC,
         id DESC
       LIMIT $${limitParam}
       OFFSET $${offsetParam}`,
      [
        ...params,
        safePageSize,
        offset
      ]
    );

  return {
    bookmaker_key:
      bookmakerKey,
    handicap_line:
      line,
    page:
      safePage,
    page_size:
      safePageSize,
    total_records:
      totalRecords,
    total_pages:
      totalPages,
    has_previous:
      safePage > 1 &&
      totalRecords > 0,
    has_next:
      safePage < totalPages,
    rows:
      rowsResult.rows
  };
}

async function getLatestOddsKgBatch(
  eventId,
  captureType
) {
  // CONTRACT_RAW_READER: use the single raw store for revised tracking.
  const contractRead = require('./oddsContract/quoteReader').readRuntimeBatch(
    eventId, 'KG', {captureType,latestOnly:true}
  );
  if (contractRead.handled) return contractRead.batch;

  const id =
    String(eventId || '').trim();

  const type =
    String(captureType || '').trim();

  if (
    !id ||
    !['opening', 'current', 'periodic']
      .includes(type)
  ) {
    throw new Error(
      'Geçersiz KG snapshot sorgusu.'
    );
  }

  const latest =
    await pool.query(
      `SELECT capture_sequence
       FROM odds_kg_snapshots
       WHERE event_id=$1
         AND capture_type=$2
       ORDER BY capture_sequence DESC
       LIMIT 1`,
      [id, type]
    );

  if (!latest.rows[0]) {
    return null;
  }

  const sequence =
    latest.rows[0].capture_sequence;

  const rows =
    await pool.query(
      `SELECT
         bookmaker_id,
         bookmaker_key,
         bookmaker_name,
         yes_odd,
         no_odd,
         yes_closed,
         no_closed,
         captured_at,
         capture_sequence,
         capture_type,
         source_name,
         source_region
       FROM odds_kg_snapshots
       WHERE event_id=$1
         AND capture_type=$2
         AND capture_sequence=$3
       ORDER BY bookmaker_name ASC`,
      [
        id,
        type,
        sequence
      ]
    );

  if (!rows.rows.length) {
    return null;
  }

  const maxCapturedAt =
    rows.rows.reduce(
      (max, row) => {
        const ms =
          new Date(
            row.captured_at
          ).getTime();

        return (
          Number.isFinite(ms) &&
          ms > max
        )
          ? ms
          : max;
      },
      0
    );

  return {
    capture_sequence:
      String(sequence),
    capture_type:
      type,
    captured_at:
      maxCapturedAt
        ? new Date(maxCapturedAt)
        : rows.rows[0].captured_at,
    source_name:
      rows.rows[0].source_name,
    source_region:
      rows.rows[0].source_region,
    rows:
      rows.rows
  };
}

async function getLatestLiveOddsKgState(
  eventId
) {
  // CONTRACT_RAW_READER: use the single raw store for revised tracking.
  const contractRead = require('./oddsContract/quoteReader').readRuntimeBatch(
    eventId, 'KG', {captureType:'current',latestOnly:false}
  );
  if (contractRead.handled) return contractRead.batch;

  const id =
    String(eventId || '').trim();

  if (!id) {
    throw new Error(
      'Invalid match id.'
    );
  }

  const result =
    await pool.query(
      `SELECT DISTINCT ON (
         bookmaker_key
       )
         bookmaker_id,
         bookmaker_key,
         bookmaker_name,
         yes_odd,
         no_odd,
         yes_closed,
         no_closed,
         captured_at,
         capture_sequence,
         capture_type,
         source_name,
         source_region
       FROM odds_kg_snapshots
       WHERE event_id=$1
         AND capture_type IN (
           'current',
           'periodic'
         )
       ORDER BY
         bookmaker_key,
         captured_at DESC,
         capture_sequence DESC,
         id DESC`,
      [id]
    );

  if (!result.rows.length) {
    return null;
  }

  const rows =
    result.rows.sort(
      (a, b) =>
        String(
          a.bookmaker_name || ''
        ).localeCompare(
          String(
            b.bookmaker_name || ''
          )
        )
    );

  const newest =
    rows.reduce(
      (latest, row) => {
        if (!latest) {
          return row;
        }

        const rowMs =
          new Date(
            row.captured_at
          ).getTime();

        const latestMs =
          new Date(
            latest.captured_at
          ).getTime();

        if (rowMs > latestMs) {
          return row;
        }

        if (rowMs < latestMs) {
          return latest;
        }

        return (
          BigInt(
            String(
              row.capture_sequence ||
              '0'
            )
          ) >
          BigInt(
            String(
              latest.capture_sequence ||
              '0'
            )
          )
        )
          ? row
          : latest;
      },
      null
    );

  return {
    capture_sequence:
      String(
        newest.capture_sequence
      ),
    capture_type:
      newest.capture_type,
    captured_at:
      newest.captured_at,
    source_name:
      newest.source_name,
    source_region:
      newest.source_region,
    rows
  };
}

async function listOddsKgHistory({
  eventId,
  bookmaker = null,
  sourceContextId = undefined,
  period = undefined,
  priceType = undefined,
  page = 1,
  pageSize = 50
}) {
  const contractHistory = require('./oddsContract/quoteReader').readRuntimeHistory(
    eventId, 'KG', {bookmaker,page,pageSize,sourceContextId,period,priceType}
  );
  if (contractHistory.handled) return contractHistory.history;

  const id =
    String(eventId || '').trim();

  if (!id) {
    throw new Error(
      'Invalid match id.'
    );
  }

  const safePage =
    Math.max(
      1,
      Math.min(
        100000,
        Number(page) || 1
      )
    );

  const safePageSize = 50;

  const bookmakerKey =
    bookmaker
      ? normalizeBookmakerKey(
          bookmaker
        )
      : null;

  if (
    bookmaker &&
    !bookmakerKey
  ) {
    throw new Error(
      'Invalid bookmaker.'
    );
  }

  const clauses = [
    'event_id=$1'
  ];

  const params = [id];

  if (bookmakerKey) {
    params.push(bookmakerKey);

    clauses.push(
      `bookmaker_key=$${params.length}`
    );
  }

  const where =
    clauses.join(' AND ');

  const countResult =
    await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM odds_kg_snapshots
       WHERE ${where}`,
      params
    );

  const totalRecords =
    Number(
      countResult.rows[0]?.total ||
      0
    );

  const totalPages =
    Math.ceil(
      totalRecords /
      safePageSize
    );

  const offset =
    (safePage - 1) *
    safePageSize;

  const limitParam =
    params.length + 1;

  const offsetParam =
    params.length + 2;

  const rowsResult =
    await pool.query(
      `SELECT
         id,
         event_id,
         bookmaker_id,
         bookmaker_key,
         bookmaker_name,
         market,
         yes_odd,
         no_odd,
         yes_closed,
         no_closed,
         captured_at,
         capture_sequence,
         capture_type,
         source_name,
         source_region
       FROM odds_kg_snapshots
       WHERE ${where}
       ORDER BY
         captured_at DESC,
         capture_sequence DESC,
         id DESC
       LIMIT $${limitParam}
       OFFSET $${offsetParam}`,
      [
        ...params,
        safePageSize,
        offset
      ]
    );

  return {
    bookmaker_key:
      bookmakerKey,
    page:
      safePage,
    page_size:
      safePageSize,
    total_records:
      totalRecords,
    total_pages:
      totalPages,
    has_previous:
      safePage > 1 &&
      totalRecords > 0,
    has_next:
      safePage < totalPages,
    rows:
      rowsResult.rows
  };
}

module.exports = {
  getLatestOddsOverUnderBatch,
  getLatestLiveOddsOverUnderState,
  listOddsOverUnderHistory,
  pool,
  initDb,
  upsertMatch,
  listMatches,
  setActive,
  removeTrackedMatch,
  setMatchLifecycle,
  archiveStartedMatch,
  finishMatch,
  saveOdds1x2Snapshot,
  saveOdds1x2Batch,
  saveOddsOverUnderSnapshot,
  saveOddsOverUnderBatch,
  saveOddsAsianSnapshot,
  saveOddsAsianBatch,
  saveOddsKgSnapshot,
  saveOddsKgBatch,
  getTrackingSettings,
  updateTrackingSettings,
  getLatestOdds1x2Batch,
  getLatestLiveOdds1x2State,
  listOdds1x2History,
  listDueTrackingJobs,
  markTrackingAttempt,
  markTrackingSuccess,
  markTrackingFailure,
  getPerformanceCache,
  markPerformancePreparing,
  savePerformanceCache,
  failPerformanceCache,
  getLatestOddsAsianBatch,
  getLatestLiveOddsAsianState,
  listOddsAsianHistory,
  getLatestOddsKgBatch,
  getLatestLiveOddsKgState,
  listOddsKgHistory
};
