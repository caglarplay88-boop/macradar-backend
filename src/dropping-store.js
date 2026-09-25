const { pool } = require('./db');

async function ensureDroppingSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dropping_state (
      item_key TEXT PRIMARY KEY,
      match_id TEXT NOT NULL,
      outcome_id TEXT NOT NULL,
      match_name TEXT NOT NULL,
      selection TEXT,
      league TEXT,
      match_date TEXT,
      kickoff_time TEXT,
      old_odd DOUBLE PRECISION,
      current_odd DOUBLE PRECISION NOT NULL,
      drop_pct DOUBLE PRECISION,
      bookies_pct INTEGER,
      bookies_down INTEGER,
      bookies_total INTEGER,
      country_code TEXT,
      country_name TEXT,
      odd_1 DOUBLE PRECISION,
      odd_x DOUBLE PRECISION,
      odd_2 DOUBLE PRECISION,
      best_bet_odd DOUBLE PRECISION,
      best_bet_bookmaker TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_notified_odd DOUBLE PRECISION,
      active BOOLEAN NOT NULL DEFAULT TRUE
    );

    ALTER TABLE dropping_state
      ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE dropping_state ADD COLUMN IF NOT EXISTS country_code TEXT;
    ALTER TABLE dropping_state ADD COLUMN IF NOT EXISTS country_name TEXT;
    ALTER TABLE dropping_state ADD COLUMN IF NOT EXISTS odd_1 DOUBLE PRECISION;
    ALTER TABLE dropping_state ADD COLUMN IF NOT EXISTS odd_x DOUBLE PRECISION;
    ALTER TABLE dropping_state ADD COLUMN IF NOT EXISTS odd_2 DOUBLE PRECISION;
    ALTER TABLE dropping_state ADD COLUMN IF NOT EXISTS best_bet_odd DOUBLE PRECISION;
    ALTER TABLE dropping_state ADD COLUMN IF NOT EXISTS best_bet_bookmaker TEXT;

    CREATE INDEX IF NOT EXISTS idx_dropping_state_last_seen
      ON dropping_state(last_seen_at DESC);

    CREATE INDEX IF NOT EXISTS idx_dropping_state_active
      ON dropping_state(active, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS dropping_alerts (
      id BIGSERIAL PRIMARY KEY,
      item_key TEXT NOT NULL,
      match_id TEXT NOT NULL,
      outcome_id TEXT NOT NULL,
      match_name TEXT NOT NULL,
      selection TEXT,
      league TEXT,
      match_date TEXT,
      kickoff_time TEXT,
      event_type TEXT NOT NULL,
      previous_odd DOUBLE PRECISION,
      current_odd DOUBLE PRECISION NOT NULL,
      drop_pct DOUBLE PRECISION,
      bookies_pct INTEGER,
      bookies_down INTEGER,
      bookies_total INTEGER,
      country_code TEXT,
      country_name TEXT,
      odd_1 DOUBLE PRECISION,
      odd_x DOUBLE PRECISION,
      odd_2 DOUBLE PRECISION,
      best_bet_odd DOUBLE PRECISION,
      best_bet_bookmaker TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      push_eligible BOOLEAN NOT NULL DEFAULT FALSE,
      push_sent_at TIMESTAMPTZ,
      push_attempt_count INTEGER NOT NULL DEFAULT 0,
      push_last_attempt_at TIMESTAMPTZ,
      push_last_error TEXT,
      UNIQUE(item_key, current_odd)
    );

    ALTER TABLE dropping_alerts
      ADD COLUMN IF NOT EXISTS push_eligible BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE dropping_alerts
      ADD COLUMN IF NOT EXISTS push_attempt_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE dropping_alerts
      ADD COLUMN IF NOT EXISTS push_last_attempt_at TIMESTAMPTZ;
    ALTER TABLE dropping_alerts
      ADD COLUMN IF NOT EXISTS push_last_error TEXT;
    ALTER TABLE dropping_alerts ADD COLUMN IF NOT EXISTS country_code TEXT;
    ALTER TABLE dropping_alerts ADD COLUMN IF NOT EXISTS country_name TEXT;
    ALTER TABLE dropping_alerts ADD COLUMN IF NOT EXISTS odd_1 DOUBLE PRECISION;
    ALTER TABLE dropping_alerts ADD COLUMN IF NOT EXISTS odd_x DOUBLE PRECISION;
    ALTER TABLE dropping_alerts ADD COLUMN IF NOT EXISTS odd_2 DOUBLE PRECISION;
    ALTER TABLE dropping_alerts ADD COLUMN IF NOT EXISTS best_bet_odd DOUBLE PRECISION;
    ALTER TABLE dropping_alerts ADD COLUMN IF NOT EXISTS best_bet_bookmaker TEXT;

    CREATE INDEX IF NOT EXISTS idx_dropping_alerts_id
      ON dropping_alerts(id DESC);

    CREATE INDEX IF NOT EXISTS idx_dropping_alerts_created_at
      ON dropping_alerts(created_at);

    CREATE INDEX IF NOT EXISTS idx_dropping_alerts_pending_push
      ON dropping_alerts(id ASC)
      WHERE push_eligible=TRUE AND push_sent_at IS NULL;


    DROP INDEX IF EXISTS idx_dropping_alerts_pending_push_fair;

    CREATE INDEX IF NOT EXISTS idx_dropping_alerts_pending_push_age
      ON dropping_alerts((COALESCE(push_last_attempt_at, created_at)) ASC, id ASC)
      WHERE push_eligible=TRUE AND push_sent_at IS NULL;

    CREATE TABLE IF NOT EXISTS dropping_worker_status (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      last_poll_at TIMESTAMPTZ,
      last_ok_at TIMESTAMPTZ,
      last_error TEXT,
      tracked_count INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      interval_seconds INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO dropping_worker_status(id)
    VALUES(1)
    ON CONFLICT(id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS dropping_settings (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      drops_in_last_hours INTEGER NOT NULL DEFAULT 1,
      matches_for TEXT NOT NULL DEFAULT 'today',
      bookies_pct INTEGER NOT NULL DEFAULT 30,
      poll_seconds INTEGER NOT NULL DEFAULT 60,
      notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    INSERT INTO dropping_settings(id)
    VALUES(1)
    ON CONFLICT(id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS dropping_push_devices (
      id BIGSERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL DEFAULT 'android',
      device_id TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_dropping_push_devices_enabled
      ON dropping_push_devices(enabled, updated_at DESC);

    CREATE TABLE IF NOT EXISTS dropping_push_deliveries (
      alert_id BIGINT NOT NULL REFERENCES dropping_alerts(id) ON DELETE CASCADE,
      device_id BIGINT NOT NULL REFERENCES dropping_push_devices(id) ON DELETE CASCADE,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      last_error TEXT,
      PRIMARY KEY(alert_id, device_id)
    );

    CREATE INDEX IF NOT EXISTS idx_dropping_push_deliveries_alert
      ON dropping_push_deliveries(alert_id, sent_at);

  `);
}

function keyOf(row) {
  return row.matchId + '|' + row.outcomeId;
}

async function writeOne(client, row, prime = false) {
  await client.query(
    `INSERT INTO dropping_state(
      item_key, match_id, outcome_id, match_name, selection, league,
      match_date, kickoff_time, old_odd, current_odd, drop_pct,
      bookies_pct, bookies_down, bookies_total, last_seen_at,
      last_notified_odd, active
    ) VALUES(
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,TRUE
    )
    ON CONFLICT(item_key) DO UPDATE SET
      match_name=EXCLUDED.match_name,
      selection=EXCLUDED.selection,
      league=EXCLUDED.league,
      match_date=EXCLUDED.match_date,
      kickoff_time=EXCLUDED.kickoff_time,
      old_odd=EXCLUDED.old_odd,
      current_odd=EXCLUDED.current_odd,
      drop_pct=EXCLUDED.drop_pct,
      bookies_pct=EXCLUDED.bookies_pct,
      bookies_down=EXCLUDED.bookies_down,
      bookies_total=EXCLUDED.bookies_total,
      last_seen_at=NOW(),
      active=TRUE,
      last_notified_odd=CASE
        WHEN $16::boolean THEN EXCLUDED.current_odd
        ELSE dropping_state.last_notified_odd
      END`,
    [
      keyOf(row), row.matchId, row.outcomeId, row.match, row.selection,
      row.league, row.date, row.time, row.oldOdd, row.currentOdd,
      row.dropPct, row.bookiesPct, row.bookiesDown, row.bookiesTotal,
      prime ? row.currentOdd : null, prime
    ]
  );

  await client.query(
    `UPDATE dropping_state SET
      country_code=$2,
      country_name=$3,
      odd_1=$4,
      odd_x=$5,
      odd_2=$6,
      best_bet_odd=$7,
      best_bet_bookmaker=$8
     WHERE item_key=$1`,
    [
      keyOf(row),
      row.countryCode ?? null,
      row.country ?? null,
      row.odd1 ?? null,
      row.oddX ?? null,
      row.odd2 ?? null,
      row.bestBetOdd ?? null,
      row.bestBetBookmaker ?? null
    ]
  );
}

async function upsertDroppingRows(rows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) await writeOne(client, row, false);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function primeDroppingRows(rows) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const row of rows) await writeOne(client, row, true);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function syncDroppingCurrent(rows, { prime = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE dropping_state SET active=FALSE WHERE active=TRUE');
    for (const row of rows) await writeOne(client, row, prime);
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function loadDroppingState() {
  const result = await pool.query(
    `SELECT * FROM dropping_state ORDER BY last_seen_at DESC`
  );

  return result.rows.map(row => ({
    itemKey: row.item_key,
    matchId: row.match_id,
    outcomeId: row.outcome_id,
    match: row.match_name,
    selection: row.selection,
    league: row.league,
    date: row.match_date,
    time: row.kickoff_time,
    oldOdd: row.old_odd,
    currentOdd: row.current_odd,
    dropPct: row.drop_pct,
    bookiesPct: row.bookies_pct,
    bookiesDown: row.bookies_down,
    bookiesTotal: row.bookies_total,
    lastNotifiedOdd: row.last_notified_odd,
    active: row.active === true
  }));
}

async function recordDroppingAlert(event, { pushEligible = true } = {}) {
  const row = event.after;
  const key = keyOf(row);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const state = await client.query(
      'SELECT last_notified_odd FROM dropping_state WHERE item_key=$1 FOR UPDATE',
      [key]
    );

    const last = state.rows[0]?.last_notified_odd;
    if (last !== null && last !== undefined &&
        Number(last) === Number(row.currentOdd)) {
      await client.query('COMMIT');
      return null;
    }

    const inserted = await client.query(
      `INSERT INTO dropping_alerts(
        item_key, match_id, outcome_id, match_name, selection, league,
        match_date, kickoff_time, event_type, previous_odd, current_odd,
        drop_pct, bookies_pct, bookies_down, bookies_total, push_eligible
      ) VALUES(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      )
      ON CONFLICT(item_key, current_odd) DO NOTHING
      RETURNING *`,
      [
        key, row.matchId, row.outcomeId, row.match, row.selection,
        row.league, row.date, row.time, event.type,
        event.before ? event.before.currentOdd : row.oldOdd,
        row.currentOdd, row.dropPct, row.bookiesPct,
        row.bookiesDown, row.bookiesTotal, pushEligible === true
      ]
    );

    if (inserted.rows[0]) {
      await client.query(
        `UPDATE dropping_alerts SET
          country_code=$2,
          country_name=$3,
          odd_1=$4,
          odd_x=$5,
          odd_2=$6,
          best_bet_odd=$7,
          best_bet_bookmaker=$8
         WHERE id=$1`,
        [
          inserted.rows[0].id,
          row.countryCode ?? null,
          row.country ?? null,
          row.odd1 ?? null,
          row.oddX ?? null,
          row.odd2 ?? null,
          row.bestBetOdd ?? null,
          row.bestBetBookmaker ?? null
        ]
      );
    }

    await client.query(
      'UPDATE dropping_state SET last_notified_odd=$2 WHERE item_key=$1',
      [key, row.currentOdd]
    );

    await client.query('COMMIT');
    return inserted.rows[0] || null;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function saveDroppingWorkerStatus({
  ok,
  tracked = 0,
  events = 0,
  intervalSeconds = null,
  error = null
}) {
  await pool.query(
    `UPDATE dropping_worker_status SET
      last_poll_at=NOW(),
      last_ok_at=CASE WHEN $1::boolean THEN NOW() ELSE last_ok_at END,
      last_error=CASE WHEN $1::boolean THEN NULL ELSE $5 END,
      tracked_count=$2,
      event_count=$3,
      interval_seconds=$4,
      updated_at=NOW()
    WHERE id=1`,
    [ok === true, Number(tracked) || 0, Number(events) || 0, intervalSeconds, error]
  );
}

async function listDroppingCurrent() {
  const result = await pool.query(
    `SELECT
      item_key, match_id, outcome_id, match_name, selection, league,
      match_date, kickoff_time, old_odd, current_odd, drop_pct,
      bookies_pct, bookies_down, bookies_total,
      country_code, country_name, odd_1, odd_x, odd_2,
      best_bet_odd, best_bet_bookmaker,
      first_seen_at, last_seen_at
    FROM dropping_state
    WHERE active=TRUE
    ORDER BY drop_pct DESC NULLS LAST, last_seen_at DESC`
  );
  return result.rows;
}

async function listDroppingAlerts({ afterId = 0, limit = 50 } = {}) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const result = await pool.query(
    `SELECT *
     FROM dropping_alerts
     WHERE id > $1
     ORDER BY id ASC
     LIMIT $2`,
    [Math.max(0, Number(afterId) || 0), safeLimit]
  );
  return result.rows;
}

async function markDroppingPushAttempt(alertId, error = null) {
  const message = error === null || error === undefined
    ? null
    : String(error).slice(0, 1000);

  const result = await pool.query(
    `UPDATE dropping_alerts
     SET push_attempt_count=COALESCE(push_attempt_count, 0) + 1,
         push_last_attempt_at=NOW(),
         push_last_error=$2
     WHERE id=$1
     RETURNING id, push_attempt_count, push_last_attempt_at, push_last_error`,
    [Number(alertId), message]
  );
  return result.rows[0] || null;
}

async function markDroppingPushSent(alertId) {
  const result = await pool.query(
    `UPDATE dropping_alerts
     SET push_sent_at=COALESCE(push_sent_at, NOW()),
         push_last_error=NULL
     WHERE id=$1
     RETURNING id, push_sent_at, push_attempt_count, push_last_attempt_at, push_last_error`,
    [Number(alertId)]
  );
  return result.rows[0] || null;
}

async function markDroppingPushIneligible(alertId) {
  const result = await pool.query(
    `UPDATE dropping_alerts
     SET push_eligible=FALSE
     WHERE id=$1
     RETURNING id, push_eligible, push_sent_at, push_attempt_count,
               push_last_attempt_at, push_last_error`,
    [Number(alertId)]
  );
  return result.rows[0] || null;
}

async function isDroppingPushAlertPending(alertId) {
  const result = await pool.query(
    `SELECT EXISTS(
       SELECT 1
       FROM dropping_alerts
       WHERE id=$1
         AND push_eligible=TRUE
         AND push_sent_at IS NULL
     ) AS pending`,
    [alertId]
  );

  return result.rows[0]?.pending === true;
}

async function tryAcquireDroppingPushAlertLock(alertId) {
  const client = await pool.connect();
  const lockKeySql =
    '(-7000000000000000000::bigint + $1::bigint)';

  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock(' + lockKeySql + ') AS locked',
      [String(alertId)]
    );

    if (result.rows[0]?.locked !== true) {
      client.release();
      return null;
    }

    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        try {
          await client.query(
            'SELECT pg_advisory_unlock(' + lockKeySql + ')',
            [String(alertId)]
          );
        } finally {
          client.release();
        }
      }
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

async function listPendingDroppingPushes(limit = 50) {
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const result = await pool.query(
    `SELECT *
     FROM dropping_alerts
     WHERE push_eligible=TRUE
       AND push_sent_at IS NULL
     ORDER BY COALESCE(push_last_attempt_at, created_at) ASC, id ASC
     LIMIT $1`,
    [safeLimit]
  );
  return result.rows;
}

async function listDeliveredDroppingPushDeviceIds(alertId) {
  const result = await pool.query(
    `SELECT device_id
     FROM dropping_push_deliveries
     WHERE alert_id=$1
       AND sent_at IS NOT NULL`,
    [Number(alertId)]
  );
  return result.rows.map(row => String(row.device_id));
}

async function markDroppingPushDeviceResult(
  alertId,
  deviceId,
  { sent = false, error = null } = {}
) {
  const message = error === null || error === undefined
    ? null
    : String(error).slice(0, 1000);

  const result = await pool.query(
    `INSERT INTO dropping_push_deliveries(
       alert_id, device_id, attempt_count, last_attempt_at, sent_at, last_error
     ) VALUES($1,$2,1,NOW(),CASE WHEN $3::boolean THEN NOW() ELSE NULL END,$4)
     ON CONFLICT(alert_id, device_id) DO UPDATE SET
       attempt_count=dropping_push_deliveries.attempt_count + 1,
       last_attempt_at=NOW(),
       sent_at=CASE
         WHEN $3::boolean THEN COALESCE(dropping_push_deliveries.sent_at, NOW())
         ELSE dropping_push_deliveries.sent_at
       END,
       last_error=CASE
         WHEN $3::boolean THEN NULL
         ELSE $4
       END
     RETURNING alert_id, device_id, attempt_count, last_attempt_at, sent_at, last_error`,
    [Number(alertId), Number(deviceId), sent === true, message]
  );
  return result.rows[0] || null;
}

async function getDroppingHealth() {
  const [status, counts, latest, push] = await Promise.all([
    pool.query('SELECT * FROM dropping_worker_status WHERE id=1'),
    pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE active=TRUE)::int AS active_count,
        COUNT(*)::int AS known_count
       FROM dropping_state`
    ),
    pool.query(
      `SELECT COALESCE(MAX(id),0)::bigint AS latest_alert_id,
              COUNT(*)::int AS alert_count
       FROM dropping_alerts`
    ),
    pool.query(
      `SELECT
        (SELECT COUNT(*)::int
           FROM dropping_push_devices
          WHERE enabled=TRUE) AS push_device_count,
        COUNT(*) FILTER (
          WHERE push_eligible=TRUE
            AND push_sent_at IS NULL
        )::int AS push_pending_count,
        COUNT(*) FILTER (
          WHERE push_eligible=TRUE
            AND push_sent_at IS NULL
            AND push_last_error IS NOT NULL
        )::int AS push_failed_pending_count,
        MAX(push_last_attempt_at) AS push_last_attempt_at,
        (
          SELECT push_last_error
          FROM dropping_alerts
          WHERE push_last_error IS NOT NULL
          ORDER BY push_last_attempt_at DESC NULLS LAST, id DESC
          LIMIT 1
        ) AS push_last_error
       FROM dropping_alerts`
    )
  ]);

  const pushRow = push.rows[0] || {};
  const pushConfigured = Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_B64 ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS
  );
  const pushDevices = Number(pushRow.push_device_count || 0);

  return {
    ...(status.rows[0] || {}),
    ...(counts.rows[0] || {}),
    ...(latest.rows[0] || {}),
    ...pushRow,
    push_configured: pushConfigured,
    push_ready: pushConfigured && pushDevices > 0
  };
}

async function registerDroppingPushDevice({ token, platform = 'android', deviceId = null }) {
  const cleanToken = String(token);
  const cleanPlatform = String(platform || 'android');
  const cleanDeviceId = deviceId ? String(deviceId) : null;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    if (cleanDeviceId) {
      await client.query(
        `UPDATE dropping_push_devices
         SET enabled=FALSE, updated_at=NOW()
         WHERE device_id=$1
           AND token<>$2
           AND enabled=TRUE`,
        [cleanDeviceId, cleanToken]
      );
    }

    const result = await client.query(
      `INSERT INTO dropping_push_devices(
        token, platform, device_id, enabled, created_at, updated_at, last_seen_at
      ) VALUES($1,$2,$3,TRUE,NOW(),NOW(),NOW())
      ON CONFLICT(token) DO UPDATE SET
        platform=EXCLUDED.platform,
        device_id=COALESCE(EXCLUDED.device_id, dropping_push_devices.device_id),
        enabled=TRUE,
        updated_at=NOW(),
        last_seen_at=NOW()
      RETURNING id, platform, device_id, enabled, created_at, updated_at, last_seen_at`,
      [cleanToken, cleanPlatform, cleanDeviceId]
    );

    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function disableDroppingPushDevice(token) {
  const result = await pool.query(
    `UPDATE dropping_push_devices
     SET enabled=FALSE, updated_at=NOW()
     WHERE token=$1
     RETURNING id, enabled, updated_at`,
    [String(token)]
  );
  return result.rows[0] || null;
}

async function listEnabledDroppingPushDevices() {
  const result = await pool.query(
    `SELECT id, token, platform, device_id, created_at, updated_at, last_seen_at
     FROM dropping_push_devices
     WHERE enabled=TRUE
     ORDER BY updated_at DESC`
  );
  return result.rows;
}

async function getDroppingSettings() {
  const result = await pool.query(
    `SELECT
      drops_in_last_hours,
      matches_for,
      bookies_pct,
      poll_seconds,
      notifications_enabled,
      updated_at
    FROM dropping_settings
    WHERE id=1`
  );

  return result.rows[0] || null;
}

async function updateDroppingSettings(settings) {
  const result = await pool.query(
    `UPDATE dropping_settings SET
      drops_in_last_hours=$1,
      matches_for=$2,
      bookies_pct=$3,
      poll_seconds=$4,
      notifications_enabled=$5,
      updated_at=NOW()
    WHERE id=1
    RETURNING
      drops_in_last_hours,
      matches_for,
      bookies_pct,
      poll_seconds,
      notifications_enabled,
      updated_at`,
    [
      settings.drops_in_last_hours,
      settings.matches_for,
      settings.bookies_pct,
      settings.poll_seconds,
      settings.notifications_enabled === true
    ]
  );

  return result.rows[0] || null;
}


async function pruneDroppingHistory({ days = 7 } = {}) {
  const keepDays = Number(days);
  if (!Number.isInteger(keepDays) || keepDays < 1 || keepDays > 3650) {
    throw new Error('Gecersiz dropping retention gunu: ' + days);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const alerts = await client.query(
      `DELETE FROM dropping_alerts
       WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [keepDays]
    );

    const state = await client.query(
      `DELETE FROM dropping_state
       WHERE active=FALSE
         AND last_seen_at < NOW() - ($1::int * INTERVAL '1 day')`,
      [keepDays]
    );

    await client.query('COMMIT');
    return {
      days: keepDays,
      alertsDeleted: alerts.rowCount,
      stateDeleted: state.rowCount
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ensureDroppingSchema,
  upsertDroppingRows,
  primeDroppingRows,
  syncDroppingCurrent,
  loadDroppingState,
  recordDroppingAlert,
  saveDroppingWorkerStatus,
  listDroppingCurrent,
  listDroppingAlerts,
  listPendingDroppingPushes,
  isDroppingPushAlertPending,
  tryAcquireDroppingPushAlertLock,
  listDeliveredDroppingPushDeviceIds,
  markDroppingPushDeviceResult,
  markDroppingPushAttempt,
  markDroppingPushSent,
  markDroppingPushIneligible,
  getDroppingHealth,
  registerDroppingPushDevice,
  disableDroppingPushDevice,
  listEnabledDroppingPushDevices,
  getDroppingSettings,
  updateDroppingSettings,
  pruneDroppingHistory,
  keyOf
};
