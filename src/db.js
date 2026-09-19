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

    CREATE INDEX IF NOT EXISTS idx_snapshots_event_time
      ON snapshots(event_id, captured_at DESC);

    CREATE INDEX IF NOT EXISTS idx_worker_runs_started
      ON worker_runs(started_at DESC);
  `);
}

async function upsertMatch({ eventId, url, slug, active = true }) {
  const now = new Date();
  await pool.query(`
    INSERT INTO matches(event_id,url,match_slug,active,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$5)
    ON CONFLICT(event_id) DO UPDATE SET
      url=EXCLUDED.url,
      match_slug=EXCLUDED.match_slug,
      active=EXCLUDED.active,
      updated_at=EXCLUDED.updated_at
  `, [eventId, url, slug, active, now]);
}

async function saveSnapshot({ eventId, url, slug, rows, capturedAt = new Date() }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
      (SELECT COUNT(DISTINCT s.captured_at)::int FROM snapshots s WHERE s.event_id=m.event_id) AS capture_count
    FROM matches m
    ${activeOnly ? 'WHERE m.active=TRUE' : ''}
    ORDER BY COALESCE((SELECT MAX(s2.captured_at) FROM snapshots s2 WHERE s2.event_id=m.event_id),m.updated_at) DESC
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
  });

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
  return { last_run: last, active_matches: active, snapshot_rows: snapshots };
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
  getWorkerStatus
};
