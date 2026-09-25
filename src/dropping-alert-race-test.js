const { pool } = require('./db');
const {
  ensureDroppingSchema,
  primeDroppingRows,
  recordDroppingAlert
} = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

(async () => {
  await ensureDroppingSchema();

  const stamp = Date.now().toString();
  const matchId = 'TEST_RACE_MATCH_' + stamp;
  const outcomeId = 'OUTCOME_1';
  const itemKey = matchId + '|' + outcomeId;
  const token = 'TEST_RACE_DEVICE_' + stamp;
  let deviceId = null;
  const alertIds = [];

  const baseline = {
    matchId,
    outcomeId,
    match: 'Race Condition Test',
    selection: '1',
    league: 'TEST',
    date: '2026-09-25',
    time: '21:00',
    oldOdd: 2.20,
    currentOdd: 2.10,
    dropPct: 4.55,
    bookiesPct: 30,
    bookiesDown: 3,
    bookiesTotal: 10
  };

  const changed = {
    ...baseline,
    oldOdd: 2.10,
    currentOdd: 2.00,
    dropPct: 4.76
  };

  try {
    await primeDroppingRows([baseline]);

    const event = {
      type: 'changed',
      before: baseline,
      after: changed
    };

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        recordDroppingAlert(event, { pushEligible: true })
      )
    );

    const created = results.filter(Boolean);
    if (created.length !== 1) {
      throw new Error('parallel inserts created=' + created.length);
    }

    alertIds.push(Number(created[0].id));

    const db = await pool.query(
      `SELECT
         count(*)::int AS alerts,
         count(DISTINCT id)::int AS distinct_ids,
         min(current_odd) AS min_odd,
         max(current_odd) AS max_odd
       FROM dropping_alerts
       WHERE item_key=$1 AND current_odd=$2`,
      [itemKey, changed.currentOdd]
    );

    if (Number(db.rows[0].alerts) !== 1 ||
        Number(db.rows[0].distinct_ids) !== 1 ||
        Number(db.rows[0].min_odd) !== 2.00 ||
        Number(db.rows[0].max_odd) !== 2.00) {
      throw new Error('DB duplicate mismatch ' + JSON.stringify(db.rows[0]));
    }

    const state = await pool.query(
      'SELECT last_notified_odd FROM dropping_state WHERE item_key=$1',
      [itemKey]
    );

    if (state.rows.length !== 1 ||
        Number(state.rows[0].last_notified_odd) !== 2.00) {
      throw new Error('last_notified_odd mismatch ' + JSON.stringify(state.rows[0]));
    }

    const sequentialDuplicate = await recordDroppingAlert(
      event,
      { pushEligible: true }
    );

    if (sequentialDuplicate !== null) {
      throw new Error('post-race same odd created duplicate');
    }

    const d = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'race-' + stamp]
    );
    deviceId = Number(d.rows[0].id);

    let sends = 0;
    const firstFlush = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert, device) => {
        if (Number(alert.id) !== alertIds[0]) {
          throw new Error('unexpected alert id ' + alert.id);
        }
        if (String(device.id) !== String(deviceId)) {
          throw new Error('unexpected device id ' + device.id);
        }
        sends++;
        return 'ok';
      }
    });

    if (firstFlush.pending !== 1 ||
        firstFlush.sentAlerts !== 1 ||
        firstFlush.sentDevices !== 1 ||
        firstFlush.failedDevices !== 0 ||
        sends !== 1) {
      throw new Error('first flush mismatch ' + JSON.stringify({ firstFlush, sends }));
    }

    const secondFlush = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async () => {
        sends++;
        return 'unexpected';
      }
    });

    if (secondFlush.pending !== 0 ||
        secondFlush.sentAlerts !== 0 ||
        secondFlush.sentDevices !== 0 ||
        sends !== 1) {
      throw new Error('second flush duplicate ' + JSON.stringify({ secondFlush, sends }));
    }

    const deliveries = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE attempt_count=1 AND sent_at IS NOT NULL)::int AS clean
       FROM dropping_push_deliveries
       WHERE alert_id=$1`,
      [alertIds[0]]
    );

    if (Number(deliveries.rows[0].total) !== 1 ||
        Number(deliveries.rows[0].clean) !== 1) {
      throw new Error('delivery persistence mismatch ' + JSON.stringify(deliveries.rows[0]));
    }

    console.log(
      'ALERT_RACE=OK CONCURRENT_CALLS=12 CREATED=1 DB_ROWS=1 ' +
      'POST_RACE_DUPLICATE=0 SENDS=1 SECOND_FLUSH=0'
    );
  } finally {
    if (alertIds.length) {
      await pool.query(
        'DELETE FROM dropping_alerts WHERE id = ANY($1::bigint[])',
        [alertIds]
      );
    }

    if (deviceId) {
      await pool.query('DELETE FROM dropping_push_devices WHERE id=$1', [deviceId]);
    } else {
      await pool.query('DELETE FROM dropping_push_devices WHERE token=$1', [token]);
    }

    await pool.query('DELETE FROM dropping_state WHERE item_key=$1', [itemKey]);

    const cleanup = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM dropping_alerts WHERE item_key=$1) alerts,
         (SELECT count(*)::int FROM dropping_state WHERE item_key=$1) states,
         (SELECT count(*)::int FROM dropping_push_devices WHERE token=$2) devices,
         (SELECT count(*)::int FROM dropping_alerts
           WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending`,
      [itemKey, token]
    );

    if (Number(cleanup.rows[0].alerts) !== 0 ||
        Number(cleanup.rows[0].states) !== 0 ||
        Number(cleanup.rows[0].devices) !== 0) {
      throw new Error('cleanup mismatch ' + JSON.stringify(cleanup.rows[0]));
    }

    console.log('ALERT_RACE_CLEANUP=OK PENDING=' + cleanup.rows[0].pending);
    await pool.end();
  }
})().catch(async e => {
  console.error('ALERT_RACE_ERROR=' + (e.message || e));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
