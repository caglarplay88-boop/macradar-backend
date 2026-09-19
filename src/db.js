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

    CREATE TABLE IF NOT EXISTS snapshots (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL,
      bookmaker TEXT NOT NULL,
      bookmaker_rank INTEGER,
      ms1 DOUBLE PRECISION,
      msx DOUBLE PRECISION,
      ms2 DOUBLE PRECISION,
      ou15_over DOUBLE PRECISION,
      ou15_under DOUBLE PRECISION,
      ou25_over DOUBLE PRECISION,
      ou25_under DOUBLE PRECISION,
      btts_yes DOUBLE PRECISION,
      btts_no DOUBLE PRECISION
    );

    CREATE TABLE IF NOT EXISTS odds_alerts (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL,
      bookmaker TEXT NOT NULL,
      market TEXT NOT NULL,
      selection TEXT NOT NULL,
      previous_odd DOUBLE PRECISION NOT NULL,
      current_odd DOUBLE PRECISION NOT NULL,
      drop_pct DOUBLE PRECISION NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(event_id, captured_at, bookmaker, market, selection)
    );

    CREATE TABLE IF NOT EXISTS worker_runs (
      id BIGSERIAL PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'running',
      total INTEGER NOT NULL DEFAULT 0,
      processed INTEGER NOT NULL DEFAULT 0,
      ok_count INTEGER NOT NULL DEFAULT 0,
      fail_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    ALTER TABLE snapshots
      ADD COLUMN IF NOT EXISTS bookmaker_rank INTEGER;

    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS display_name TEXT;

    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS league TEXT;

    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS match_date DATE;

    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS kickoff_time TEXT;

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO app_settings(key,value)
    VALUES('refresh_minutes','50')
    ON CONFLICT(key) DO NOTHING;

    CREATE INDEX IF NOT EXISTS idx_snapshots_event_time
      ON snapshots(event_id, captured_at DESC);

    CREATE INDEX IF NOT EXISTS idx_worker_runs_started
      ON worker_runs(started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_odds_alerts_id
      ON odds_alerts(id DESC);

    CREATE INDEX IF NOT EXISTS idx_odds_alerts_event_time
      ON odds_alerts(event_id, captured_at DESC);
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


function alertCandidates(previous, current) {
  if (!previous || !current) return [];

  const fields = [
    ['MS', 'Ev', 'ms1'],
    ['MS', 'X', 'msx'],
    ['MS', 'Dep', 'ms2'],
    ['1.5', 'Alt', 'ou15_under'],
    ['1.5', 'Üst', 'ou15_over'],
    ['2.5', 'Alt', 'ou25_under'],
    ['2.5', 'Üst', 'ou25_over'],
    ['KG', 'Yok', 'btts_no'],
    ['KG', 'Var', 'btts_yes']
  ];

  const alerts = [];
  for (const [market, selection, key] of fields) {
    const before = Number(previous[key]);
    const after = Number(current[key]);
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue;
    if (before <= 0 || after <= 0 || after >= before) continue;

    const absDrop = before - after;
    const pctDrop = (absDrop / before) * 100;
    if (absDrop + 1e-9 < 0.10 || pctDrop + 1e-9 < 5.0) continue;

    alerts.push({ market, selection, previousOdd: before, currentOdd: after, dropPct: pctDrop });
  }
  return alerts;
}

async function saveSnapshot({ eventId, url, slug, rows, capturedAt = new Date() }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const currentPreferred =
      rows.find(r => String(r.bookmaker || '').toLowerCase().replace(/\s+/g, '').startsWith('1xbet')) ||
      rows[0] ||
      null;

    let previousPreferred = null;
    if (currentPreferred) {
      previousPreferred = (await client.query(
        "SELECT * FROM snapshots WHERE event_id=$1 AND LOWER(REPLACE(bookmaker, ' ', '')) = LOWER(REPLACE($2, ' ', '')) AND captured_at < $3 ORDER BY captured_at DESC, id DESC LIMIT 1",
        [eventId, currentPreferred.bookmaker, capturedAt]
      )).rows[0] || null;
    }

    await client.query(`
      INSERT INTO matches(event_id,url,match_slug,active,created_at,updated_at)
      VALUES($1,$2,$3,TRUE,$4,$4)
      ON CONFLICT(event_id) DO UPDATE SET
        url=EXCLUDED.url,
        match_slug=EXCLUDED.match_slug,
        updated_at=EXCLUDED.updated_at
    `, [eventId, url, slug, capturedAt]);

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      await client.query(`
        INSERT INTO snapshots(
          event_id,captured_at,bookmaker,bookmaker_rank,ms1,msx,ms2,
          ou15_over,ou15_under,ou25_over,ou25_under,btts_yes,btts_no
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      `, [
        eventId, capturedAt, r.bookmaker, i + 1,
        r.ms1 ?? null, r.msx ?? null, r.ms2 ?? null,
        r.ou15_over ?? null, r.ou15_under ?? null,
        r.ou25_over ?? null, r.ou25_under ?? null,
        r.btts_yes ?? null, r.btts_no ?? null
      ]);
    }
    const activeRow = (await client.query(
      'SELECT active FROM matches WHERE event_id=$1',
      [eventId]
    )).rows[0];

    if (activeRow?.active && currentPreferred && previousPreferred) {
      const alerts = alertCandidates(previousPreferred, currentPreferred);
      for (const alert of alerts) {
        await client.query(
          'INSERT INTO odds_alerts(event_id,captured_at,bookmaker,market,selection,previous_odd,current_odd,drop_pct) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
          [eventId, capturedAt, currentPreferred.bookmaker, alert.market, alert.selection, alert.previousOdd, alert.currentOdd, alert.dropPct]
        );
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listMatches({ activeOnly = false } = {}) {
  const q = `
    SELECT m.*,
      (SELECT MAX(s.captured_at) FROM snapshots s WHERE s.event_id=m.event_id) AS last_capture,
      (SELECT COUNT(*)::int FROM snapshots s WHERE s.event_id=m.event_id) AS row_count,
      (
        SELECT COUNT(DISTINCT s.captured_at)::int
        FROM snapshots s
        WHERE s.event_id=m.event_id
          AND EXISTS (
            SELECT 1
            FROM snapshots sx
            WHERE sx.event_id=s.event_id
              AND sx.captured_at=s.captured_at
              AND LOWER(sx.bookmaker) LIKE '1xbet%'
          )
      ) AS capture_count
    FROM matches m
    ${activeOnly ? 'WHERE m.active=TRUE' : ''}
    ORDER BY
      CASE WHEN m.match_date IS NULL THEN 1 ELSE 0 END,
      m.match_date ASC NULLS LAST,
      CASE
        WHEN m.kickoff_time ~ '^[0-9]{1,2}:[0-9]{2}$'
        THEN split_part(m.kickoff_time,':',1)::int * 60
             + split_part(m.kickoff_time,':',2)::int
        ELSE 9999
      END ASC,
      m.display_name ASC NULLS LAST,
      COALESCE(
        (SELECT MAX(s2.captured_at)
         FROM snapshots s2
         WHERE s2.event_id=m.event_id),
        m.updated_at
      ) DESC
  `;
  const { rows } = await pool.query(q);
  return rows;
}
async function getMatch(eventId) {
  const m = (await pool.query('SELECT * FROM matches WHERE event_id=$1', [eventId])).rows[0];
  if (!m) return null;

  const latest = (await pool.query(
    'SELECT MAX(captured_at) AS captured_at FROM snapshots WHERE event_id=$1', [eventId]
  )).rows[0]?.captured_at || null;

  let rows = [];
  if (latest) {
    rows = (await pool.query(
      'SELECT * FROM snapshots WHERE event_id=$1 AND captured_at=$2 ORDER BY bookmaker_rank NULLS LAST, id', [eventId, latest]
    )).rows;
  }

  const all = (await pool.query(
    'SELECT * FROM snapshots WHERE event_id=$1 ORDER BY captured_at,id', [eventId]
  )).rows;

  const groups = new Map();
  for (const r of all) {
    const key = new Date(r.captured_at).toISOString();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const keyOf = name => String(name || '').toLowerCase().replace(/\s+/g, '');
  const preferred =
    rows.find(x => keyOf(x.bookmaker).startsWith('1xbet')) ||
    rows[0] ||
    null;
  const preferredKey = keyOf(preferred?.bookmaker);

  const historyGroups = [...groups.entries()].map(([captured_at, a]) => {
    const ordered = [...a].sort((x, y) =>
      (x.bookmaker_rank ?? 999) - (y.bookmaker_rank ?? 999) || Number(x.id) - Number(y.id)
    );
    return {
      captured_at,
      rows: ordered.slice(0, 3)
    };
  }).filter(group =>
    group.rows.some(x => keyOf(x.bookmaker).startsWith('1xbet'))
  );

  const history = historyGroups.map(group => {
    const ordered = group.rows;
    const picked =
      (preferredKey ? ordered.find(x => keyOf(x.bookmaker) === preferredKey) : null) ||
      ordered.find(x => keyOf(x.bookmaker).startsWith('1xbet')) ||
      ordered[0];

    if (!picked) return null;

    return {
      captured_at: group.captured_at,
      bookmaker: picked.bookmaker,
      ms1: picked.ms1,
      msx: picked.msx,
      ms2: picked.ms2,
      ou15_over: picked.ou15_over,
      ou15_under: picked.ou15_under,
      ou25_over: picked.ou25_over,
      ou25_under: picked.ou25_under,
      btts_yes: picked.btts_yes,
      btts_no: picked.btts_no
    };
  }).filter(Boolean);

  return {
    ...m,
    latest_capture: latest,
    latest_rows: rows.slice(0, 3),
    history_bookmaker: preferred?.bookmaker || null,
    history,
    history_groups: historyGroups
  };
}

async function setActive(eventId, active) {
  const r = await pool.query(
    'UPDATE matches SET active=$2,updated_at=NOW() WHERE event_id=$1 RETURNING *',
    [eventId, active]
  );
  return r.rows[0] || null;
}

async function createWorkerRun(total) {
  const r = await pool.query(
    'INSERT INTO worker_runs(total) VALUES($1) RETURNING *',
    [total]
  );
  return r.rows[0];
}

async function updateWorkerRun(id, fields = {}) {
  const current = (await pool.query('SELECT * FROM worker_runs WHERE id=$1', [id])).rows[0];
  if (!current) return null;
  const next = {
    processed: fields.processed ?? current.processed,
    ok_count: fields.ok_count ?? current.ok_count,
    fail_count: fields.fail_count ?? current.fail_count,
    skipped_count: fields.skipped_count ?? current.skipped_count,
    status: fields.status ?? current.status,
    error: fields.error ?? current.error,
    finished_at: fields.finished_at ?? current.finished_at
  };
  const r = await pool.query(`
    UPDATE worker_runs
    SET processed=$2,ok_count=$3,fail_count=$4,skipped_count=$5,status=$6,error=$7,finished_at=$8
    WHERE id=$1
    RETURNING *
  `, [
    id, next.processed, next.ok_count, next.fail_count, next.skipped_count,
    next.status, next.error, next.finished_at
  ]);
  return r.rows[0];
}


async function listAlerts({ afterId = 0, limit = 30 } = {}) {
  const safeAfter = Number.isFinite(Number(afterId)) ? Number(afterId) : 0;
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const r = await pool.query(
    'SELECT a.*, m.match_slug FROM odds_alerts a JOIN matches m ON m.event_id=a.event_id WHERE a.id > $1 AND m.active=TRUE ORDER BY a.id ASC LIMIT $2',
    [safeAfter, safeLimit]
  );
  return r.rows;
}

async function getLatestAlertId() {
  const r = await pool.query('SELECT COALESCE(MAX(id),0)::bigint AS id FROM odds_alerts');
  return Number(r.rows[0]?.id || 0);
}

async function getSetting(key, fallback = null) {
  const r = await pool.query(
    'SELECT value FROM app_settings WHERE key=$1',
    [key]
  );
  return r.rows[0]?.value ?? fallback;
}

async function setSetting(key, value) {
  const r = await pool.query(`
    INSERT INTO app_settings(key,value,updated_at)
    VALUES($1,$2,NOW())
    ON CONFLICT(key) DO UPDATE SET
      value=EXCLUDED.value,
      updated_at=EXCLUDED.updated_at
    RETURNING *
  `, [key, String(value)]);
  return r.rows[0];
}

async function getRefreshMinutes() {
  const raw = Number(await getSetting('refresh_minutes', '50'));
  return Number.isFinite(raw) ? raw : 50;
}

async function getWorkerStatus() {
  const last = (await pool.query(
    'SELECT * FROM worker_runs ORDER BY started_at DESC LIMIT 1'
  )).rows[0] || null;
  const active = Number((await pool.query(
    'SELECT COUNT(*)::int AS c FROM matches WHERE active=TRUE'
  )).rows[0].c);
  const snapshots = Number((await pool.query(
    'SELECT COUNT(*)::int AS c FROM snapshots'
  )).rows[0].c);
  const refreshMinutes = await getRefreshMinutes();
  return {
    last_run: last,
    active_matches: active,
    snapshot_rows: snapshots,
    refresh_minutes: refreshMinutes
  };
}

module.exports = {
  pool,
  initDb,
  upsertMatch,
  saveSnapshot,
  listMatches,
  getMatch,
  setActive,
  createWorkerRun,
  updateWorkerRun,
  getWorkerStatus,
  listAlerts,
  getLatestAlertId,
  getSetting,
  setSetting,
  getRefreshMinutes
};
