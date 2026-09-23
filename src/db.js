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

    CREATE TABLE IF NOT EXISTS snapshot_meta (
      event_id TEXT NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL,
      source TEXT,
      tor_source TEXT,
      tor_country TEXT,
      tor_circuit INTEGER,
      coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
      degraded BOOLEAN NOT NULL DEFAULT FALSE,
      fallback_checked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(event_id, captured_at)
    );

    ALTER TABLE snapshot_meta
      ADD COLUMN IF NOT EXISTS tor_country TEXT;

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

    ALTER TABLE snapshots
      ADD COLUMN IF NOT EXISTS status_map JSONB NOT NULL DEFAULT '{}'::jsonb;

    CREATE TABLE IF NOT EXISTS market_state_events (
      id BIGSERIAL PRIMARY KEY,
      event_id TEXT NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL,
      bookmaker TEXT NOT NULL,
      market TEXT NOT NULL,
      selection TEXT NOT NULL,
      outcome_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      last_active_at TIMESTAMPTZ,
      last_active_odd DOUBLE PRECISION,
      current_odd DOUBLE PRECISION,
      reopen_gap_pct DOUBLE PRECISION,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(event_id,captured_at,bookmaker,outcome_key,event_type)
    );

    CREATE INDEX IF NOT EXISTS idx_market_state_events_event_time
      ON market_state_events(event_id,captured_at DESC);


    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS display_name TEXT;

    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS league TEXT;

    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS match_date DATE;

    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS kickoff_time TEXT;

    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS lifecycle TEXT NOT NULL DEFAULT 'tracking';

    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS home_score INTEGER;

    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS away_score INTEGER;

    ALTER TABLE matches
      ADD COLUMN IF NOT EXISTS result_status TEXT;
      ALTER TABLE matches
        ADD COLUMN IF NOT EXISTS refresh_minutes INTEGER;


    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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

    INSERT INTO app_settings(key,value)
    VALUES('refresh_minutes','60')
    ON CONFLICT(key) DO NOTHING;

    UPDATE app_settings
    SET value='60', updated_at=NOW()
    WHERE key='refresh_minutes' AND value='50';

    CREATE INDEX IF NOT EXISTS idx_snapshots_event_time
      ON snapshots(event_id, captured_at DESC);

    CREATE INDEX IF NOT EXISTS idx_snapshot_meta_event_time
      ON snapshot_meta(event_id, captured_at DESC);

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
    const previousStatus = String(previous.status_map?.[key] || "unknown").toLowerCase();
    const currentStatus = String(current[key + "_status"] || "unknown").toLowerCase();

    if (previousStatus !== "active" || currentStatus !== "active") continue;

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

function marketStateTransitions(previous, current) {
  if (!previous || !current) return [];

  const fields = [
    ["MS","1","ms1"], ["MS","X","msx"], ["MS","2","ms2"],
    ["1.5","Üst","ou15_over"], ["1.5","Alt","ou15_under"],
    ["2.5","Üst","ou25_over"], ["2.5","Alt","ou25_under"],
    ["KG","Var","btts_yes"], ["KG","Yok","btts_no"]
  ];

  const out = [];

  for (const [market, selection, key] of fields) {
    const from = String(previous.status_map?.[key] || "unknown").toLowerCase();
    const to = String(current[key + "_status"] || "unknown").toLowerCase();

    if (!["active","suspended"].includes(from)) continue;
    if (!["active","suspended"].includes(to)) continue;
    if (from === to) continue;

    out.push({
      market,
      selection,
      key,
      eventType: from === "active" && to === "suspended" ? "SUSPEND" : "REOPEN",
      fromStatus: from,
      toStatus: to
    });
  }

  return out;
}

async function saveMarketStateEvents(client, eventId, capturedAt, previous, current) {
  const transitions = marketStateTransitions(previous, current);

  for (const t of transitions) {
    let lastActive = null;

    if (t.eventType === "REOPEN") {
      lastActive = (await client.query(
        "SELECT * FROM snapshots WHERE event_id=$1 AND LOWER(REPLACE(bookmaker, ' ', '')) = LOWER(REPLACE($2, ' ', '')) AND captured_at < $3 AND COALESCE(status_map ->> $4::text, 'unknown') = 'active' ORDER BY captured_at DESC, id DESC LIMIT 1",
        [eventId, current.bookmaker, capturedAt, t.key]
      )).rows[0] || null;
    } else {
      lastActive = previous;
    }

    const before = Number(lastActive?.[t.key]);
    const after = Number(current[t.key]);

    const gapPct =
      t.eventType === "REOPEN" &&
      Number.isFinite(before) &&
      before > 0 &&
      Number.isFinite(after)
        ? ((after - before) / before) * 100
        : null;

    await client.query(
      "INSERT INTO market_state_events(event_id,captured_at,bookmaker,market,selection,outcome_key,event_type,from_status,to_status,last_active_at,last_active_odd,current_odd,reopen_gap_pct) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING",
      [
        eventId,
        capturedAt,
        current.bookmaker,
        t.market,
        t.selection,
        t.key,
        t.eventType,
        t.fromStatus,
        t.toStatus,
        lastActive?.captured_at || null,
        Number.isFinite(before) ? before : null,
        Number.isFinite(after) ? after : null,
        gapPct
      ]
    );
  }
}

function snapshotStatusMap(row) {
  const keys = ["ms1","msx","ms2","ou15_over","ou15_under","ou25_over","ou25_under","btts_yes","btts_no"];
  const out = {};
  for (const key of keys) {
    if (!Number.isFinite(Number(row[key]))) continue;
    const raw = String(row[key + "_status"] || "unknown").toLowerCase();
    out[key] = raw === "active" || raw === "suspended" ? raw : "unknown";
  }
  return out;
}

async function saveSnapshot({ eventId, url, slug, rows, capturedAt = new Date(), meta = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const previousByBookmaker = new Map();

    for (const current of rows) {
      const previous = (await client.query(
        "SELECT * FROM snapshots WHERE event_id=$1 AND LOWER(REPLACE(bookmaker, ' ', '')) = LOWER(REPLACE($2, ' ', '')) AND captured_at < $3 ORDER BY captured_at DESC, id DESC LIMIT 1",
        [eventId, current.bookmaker, capturedAt]
      )).rows[0] || null;

      previousByBookmaker.set(
        String(current.bookmaker || '').toLowerCase().replace(/\s+/g, ''),
        previous
      );
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
          ou15_over,ou15_under,ou25_over,ou25_under,btts_yes,btts_no,status_map
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
      `, [
        eventId, capturedAt, r.bookmaker, i + 1,
        r.ms1 ?? null, r.msx ?? null, r.ms2 ?? null,
        r.ou15_over ?? null, r.ou15_under ?? null,
        r.ou25_over ?? null, r.ou25_under ?? null,
        r.btts_yes ?? null, r.btts_no ?? null,
        JSON.stringify(snapshotStatusMap(r))
      ]);
    }
    for (const current of rows) {
      const key = String(current.bookmaker || "")
        .toLowerCase()
        .replace(/\s+/g, "");

      const previous = previousByBookmaker.get(key);

      if (previous) {
        await saveMarketStateEvents(
          client,
          eventId,
          capturedAt,
          previous,
          current
        );
      }
    }

    await client.query(`
      INSERT INTO snapshot_meta(
        event_id,captured_at,source,tor_source,tor_country,tor_circuit,
        coverage,degraded,fallback_checked
      )
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
      ON CONFLICT(event_id,captured_at) DO UPDATE SET
        source=EXCLUDED.source,
        tor_source=EXCLUDED.tor_source,
        tor_country=EXCLUDED.tor_country,
        tor_circuit=EXCLUDED.tor_circuit,
        coverage=EXCLUDED.coverage,
        degraded=EXCLUDED.degraded,
        fallback_checked=EXCLUDED.fallback_checked
    `, [
      eventId,
      capturedAt,
      meta?.source ?? null,
      meta?.torSource ?? null,
      meta?.torCountry ?? null,
      Number.isFinite(Number(meta?.torCircuit)) ? Number(meta.torCircuit) : null,
      JSON.stringify(meta?.coverage || {}),
      meta?.degraded === true,
      meta?.fallbackChecked === true
    ]);

    const activeRow = (await client.query(
      'SELECT active FROM matches WHERE event_id=$1',
      [eventId]
    )).rows[0];

    if (activeRow?.active) {
      for (const current of rows) {
        const key = String(current.bookmaker || '')
          .toLowerCase()
          .replace(/\s+/g, '');

        const previous = previousByBookmaker.get(key);

        if (!previous) continue;

        const alerts = alertCandidates(previous, current);

        for (const alert of alerts) {
          await client.query(
            'INSERT INTO odds_alerts(event_id,captured_at,bookmaker,market,selection,previous_odd,current_odd,drop_pct) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
            [eventId, capturedAt, current.bookmaker, alert.market, alert.selection, alert.previousOdd, alert.currentOdd, alert.dropPct]
          );
        }
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
      ) AS capture_count,
      EXISTS (
        SELECT 1
        FROM (
          SELECT
            s.captured_at,
            s.bookmaker,

            LAG(s.captured_at) OVER (
              PARTITION BY LOWER(REPLACE(s.bookmaker, ' ', ''))
              ORDER BY s.captured_at
            ) AS prev_time,

            s.ms1,
            LAG(s.ms1) OVER (
              PARTITION BY LOWER(REPLACE(s.bookmaker, ' ', ''))
              ORDER BY s.captured_at
            ) AS p_ms1,

            s.msx,
            LAG(s.msx) OVER (
              PARTITION BY LOWER(REPLACE(s.bookmaker, ' ', ''))
              ORDER BY s.captured_at
            ) AS p_msx,

            s.ms2,
            LAG(s.ms2) OVER (
              PARTITION BY LOWER(REPLACE(s.bookmaker, ' ', ''))
              ORDER BY s.captured_at
            ) AS p_ms2,

            s.ou15_under,
            LAG(s.ou15_under) OVER (
              PARTITION BY LOWER(REPLACE(s.bookmaker, ' ', ''))
              ORDER BY s.captured_at
            ) AS p_15u,

            s.ou15_over,
            LAG(s.ou15_over) OVER (
              PARTITION BY LOWER(REPLACE(s.bookmaker, ' ', ''))
              ORDER BY s.captured_at
            ) AS p_15o,

            s.ou25_under,
            LAG(s.ou25_under) OVER (
              PARTITION BY LOWER(REPLACE(s.bookmaker, ' ', ''))
              ORDER BY s.captured_at
            ) AS p_25u,

            s.ou25_over,
            LAG(s.ou25_over) OVER (
              PARTITION BY LOWER(REPLACE(s.bookmaker, ' ', ''))
              ORDER BY s.captured_at
            ) AS p_25o,

            s.btts_no,
            LAG(s.btts_no) OVER (
              PARTITION BY LOWER(REPLACE(s.bookmaker, ' ', ''))
              ORDER BY s.captured_at
            ) AS p_kgy,

            s.btts_yes,
            LAG(s.btts_yes) OVER (
              PARTITION BY LOWER(REPLACE(s.bookmaker, ' ', ''))
              ORDER BY s.captured_at
            ) AS p_kgv

          FROM snapshots s
          WHERE s.event_id=m.event_id
        ) z
        WHERE z.captured_at >= NOW() - INTERVAL '60 minutes'
          AND z.prev_time IS NOT NULL
          AND z.captured_at - z.prev_time <= INTERVAL '35 minutes'
          AND GREATEST(
            ABS((z.ms1-z.p_ms1) / NULLIF(z.p_ms1,0)),
            ABS((z.msx-z.p_msx) / NULLIF(z.p_msx,0)),
            ABS((z.ms2-z.p_ms2) / NULLIF(z.p_ms2,0)),
            ABS((z.ou15_under-z.p_15u) / NULLIF(z.p_15u,0)),
            ABS((z.ou15_over-z.p_15o) / NULLIF(z.p_15o,0)),
            ABS((z.ou25_under-z.p_25u) / NULLIF(z.p_25u,0)),
            ABS((z.ou25_over-z.p_25o) / NULLIF(z.p_25o,0)),
            ABS((z.btts_no-z.p_kgy) / NULLIF(z.p_kgy,0)),
            ABS((z.btts_yes-z.p_kgv) / NULLIF(z.p_kgv,0))
          ) >= 0.15
      ) AS sharp_move_alert
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
function matchKickoffCutoff(match) {
  if (!match?.match_date || !match?.kickoff_time) return null;

  const rawDate = match.match_date;
  const date =
    rawDate instanceof Date && Number.isFinite(rawDate.getTime())
      ? rawDate.toISOString().slice(0, 10)
      : (String(rawDate).match(/\d{4}-\d{2}-\d{2}/)?.[0] || '');

  const tm = String(match.kickoff_time).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !tm) return null;

  const hh = String(Number(tm[1])).padStart(2, '0');
  const mm = String(Number(tm[2])).padStart(2, '0');
  const d = new Date(`${date}T${hh}:${mm}:00+03:00`);

  return Number.isFinite(d.getTime()) ? d : null;
}

async function getMatch(eventId) {
  const m = (await pool.query('SELECT * FROM matches WHERE event_id=$1', [eventId])).rows[0];
  if (!m) return null;

  // Grafik ve "son oranlar" yalnızca maç başlamadan önceki kayıtları gösterir.
  // Eski sürümün yanlışlıkla kaydettiği live oranlar DB'de kalsa bile uygulamaya dönmez.
  const cutoff = matchKickoffCutoff(m);
  const cutoffClause = cutoff ? ' AND captured_at < $2' : '';
  const params = cutoff ? [eventId, cutoff] : [eventId];

  const latest = (await pool.query(
    'SELECT MAX(captured_at) AS captured_at FROM snapshots WHERE event_id=$1' + cutoffClause,
    params
  )).rows[0]?.captured_at || null;

  let rows = [];
  if (latest) {
    rows = (await pool.query(
      'SELECT * FROM snapshots WHERE event_id=$1 AND captured_at=$2 ORDER BY bookmaker_rank NULLS LAST, id',
      [eventId, latest]
    )).rows;
  }

  const all = (await pool.query(
    'SELECT * FROM snapshots WHERE event_id=$1' + cutoffClause + ' ORDER BY captured_at,id',
    params
  )).rows;

  const allMeta = (await pool.query(
    'SELECT * FROM snapshot_meta WHERE event_id=$1' + cutoffClause + ' ORDER BY captured_at',
    params
  )).rows;

  const marketStateEvents = (await pool.query(
    'SELECT * FROM market_state_events WHERE event_id=$1' + cutoffClause + ' ORDER BY captured_at,id',
    params
  )).rows;


  const metaByCapturedAt = new Map(
    allMeta.map(x => [
      new Date(x.captured_at).toISOString(),
      {
        source: x.source,
        tor_source: x.tor_source,
        tor_country: x.tor_country,
        tor_circuit: x.tor_circuit,
        coverage: x.coverage || {},
        degraded: x.degraded === true,
        fallback_checked: x.fallback_checked === true
      }
    ])
  );

  const latestMeta = latest
    ? metaByCapturedAt.get(new Date(latest).toISOString()) || null
    : null;

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

  const allHistoryGroups = [...groups.entries()].map(([captured_at, a]) => {
    const ordered = [...a].sort((x, y) =>
      (x.bookmaker_rank ?? 999) - (y.bookmaker_rank ?? 999) || Number(x.id) - Number(y.id)
    );
    return {
      captured_at,
      rows: ordered,
      meta: metaByCapturedAt.get(captured_at) || null
    };
  });

  const historyGroups = allHistoryGroups.map(group => ({
    captured_at: group.captured_at,
    rows: group.rows.slice(0, 3)
  }));

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
    latest_meta: latestMeta,
    latest_rows: rows.slice(0, 3),
    all_latest_rows: rows,
    history_bookmaker: preferred?.bookmaker || null,
    history,
    history_groups: historyGroups,
    all_history_groups: allHistoryGroups,
    market_state_events: marketStateEvents,
    prematch_only: true,
    kickoff_cutoff: cutoff ? cutoff.toISOString() : null
  };
}

async function purgePostKickoffSnapshots() {
  const matches = (await pool.query(
    'SELECT event_id,match_date,kickoff_time FROM matches WHERE match_date IS NOT NULL AND kickoff_time IS NOT NULL'
  )).rows;

  let deletedSnapshots = 0;
  let deletedSnapshotMeta = 0;
  let deletedAlerts = 0;
  let deletedMarketStateEvents = 0;

  for (const match of matches) {
    const cutoff = matchKickoffCutoff(match);
    if (!cutoff) continue;

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const sm = await client.query(
        'DELETE FROM snapshot_meta WHERE event_id=$1 AND captured_at >= $2',
        [match.event_id, cutoff]
      );

      const s = await client.query(
        'DELETE FROM snapshots WHERE event_id=$1 AND captured_at >= $2',
        [match.event_id, cutoff]
      );

      const a = await client.query(
        'DELETE FROM odds_alerts WHERE event_id=$1 AND captured_at >= $2',
        [match.event_id, cutoff]
      );

      const mse = await client.query(
        'DELETE FROM market_state_events WHERE event_id=$1 AND captured_at >= $2',
        [match.event_id, cutoff]
      );

      await client.query('COMMIT');

      deletedSnapshotMeta += sm.rowCount || 0;
      deletedSnapshots += s.rowCount || 0;
      deletedAlerts += a.rowCount || 0;
      deletedMarketStateEvents += mse.rowCount || 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    deletedSnapshots,
    deletedSnapshotMeta,
    deletedAlerts,
    deletedMarketStateEvents
  };
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

async function setMatchRefreshMinutes(eventId, minutes) {
  const r = await pool.query(
    `UPDATE matches
     SET refresh_minutes=$2,
         updated_at=NOW()
     WHERE event_id=$1
     RETURNING *`,
    [eventId, minutes]
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
  const raw = Number(await getSetting('refresh_minutes', '60'));
  const allowed = new Set([15, 30, 60, 120]);
  return allowed.has(raw) ? raw : 60;
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

  const lastSnapshot = (await pool.query(
    'SELECT MAX(captured_at) AS captured_at FROM snapshots'
  )).rows[0]?.captured_at || null;

  const lastSnapshotMs = lastSnapshot
    ? new Date(lastSnapshot).getTime()
    : null;

  const snapshotAgeMinutes =
    Number.isFinite(lastSnapshotMs)
      ? Math.max(0, Math.floor((Date.now() - lastSnapshotMs) / 60000))
      : null;

  return {
    last_run: last,
    active_matches: active,
    snapshot_rows: snapshots,
    refresh_minutes: refreshMinutes,
    last_successful_capture: lastSnapshot,
    last_successful_capture_age_minutes: snapshotAgeMinutes,
    stale: snapshotAgeMinutes != null
      ? snapshotAgeMinutes > refreshMinutes + 5
      : true
  };
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
  pool,
  initDb,
  upsertMatch,
  saveSnapshot,
  listMatches,
  getMatch,
  setActive,
  setMatchRefreshMinutes,
  createWorkerRun,
  updateWorkerRun,
  getWorkerStatus,
  listAlerts,
  getLatestAlertId,
  getSetting,
  setSetting,
  getRefreshMinutes,
  purgePostKickoffSnapshots,
  setMatchLifecycle,
  archiveStartedMatch,
  finishMatch,
  getPerformanceCache,
  markPerformancePreparing,
  savePerformanceCache,
  failPerformanceCache
};
