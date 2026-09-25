const fs = require('fs');
const path = require('path');
const { pool } = require('./db');
const {
  ensureDroppingSchema,
  primeDroppingRows,
  recordDroppingAlert
} = require('./dropping-store');
const {
  flushDroppingPushes,
  buildMessage
} = require('./dropping-push');

(async () => {
  await ensureDroppingSchema();

  const stamp = Date.now().toString();
  const matchId = 'TEST_NEW_DROP_MATCH_' + stamp;
  const outcomeId = 'OUTCOME_1';
  const itemKey = matchId + '|' + outcomeId;
  const token = 'TEST_NEW_DROP_DEVICE_' + stamp;

  let deviceId = null;
  const alertIds = [];
  const payloads = [];

  const makeRow = (currentOdd, oldOdd, dropPct) => ({
    matchId,
    outcomeId,
    match: 'New Drop Identity Test',
    selection: '1',
    league: 'TEST',
    date: '2026-09-25',
    time: '20:00',
    oldOdd,
    currentOdd,
    dropPct,
    bookiesPct: 30,
    bookiesDown: 3,
    bookiesTotal: 10
  });

  try {
    const baseline = makeRow(2.10, 2.20, 4.55);
    await primeDroppingRows([baseline]);

    const firstRow = makeRow(2.00, 2.10, 4.76);
    const first = await recordDroppingAlert(
      { type: 'changed', before: baseline, after: firstRow },
      { pushEligible: true }
    );

    if (!first) throw new Error('first real drop did not create alert');
    alertIds.push(Number(first.id));

    const duplicate = await recordDroppingAlert(
      { type: 'changed', before: baseline, after: firstRow },
      { pushEligible: true }
    );

    if (duplicate !== null) {
      throw new Error('same currentOdd created duplicate alert');
    }

    const secondRow = makeRow(1.90, 2.00, 5.00);
    const second = await recordDroppingAlert(
      { type: 'changed', before: firstRow, after: secondRow },
      { pushEligible: true }
    );

    if (!second) throw new Error('second real drop was suppressed');
    alertIds.push(Number(second.id));

    if (alertIds[0] === alertIds[1]) {
      throw new Error('two real drops share alert_id');
    }

    const rows = await pool.query(
      `SELECT id,item_key,match_id,outcome_id,current_odd,push_eligible,push_sent_at
       FROM dropping_alerts
       WHERE id = ANY($1::bigint[])
       ORDER BY id ASC`,
      [alertIds]
    );

    if (rows.rows.length !== 2 ||
        rows.rows.some(r => r.item_key !== itemKey) ||
        rows.rows.some(r => r.match_id !== matchId) ||
        rows.rows.some(r => r.outcome_id !== outcomeId) ||
        Number(rows.rows[0].current_odd) !== 2.00 ||
        Number(rows.rows[1].current_odd) !== 1.90) {
      throw new Error('alert identity/currentOdd mismatch ' + JSON.stringify(rows.rows));
    }

    const d = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'new-drop-' + stamp]
    );
    deviceId = Number(d.rows[0].id);

    const flushed = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert, device) => {
        if (String(device.id) !== String(deviceId)) {
          throw new Error('unexpected device');
        }

        const message = buildMessage(alert, device.token);
        payloads.push({
          alertId: String(alert.id),
          dataAlertId: message.message.data.alert_id,
          tag: message.message.android.notification.tag,
          collapseKey: message.message.android.collapse_key,
          currentOdd: message.message.data.current_odd
        });
        return 'ok';
      }
    });

    if (flushed.pending !== 2 ||
        flushed.sentAlerts !== 2 ||
        flushed.sentDevices !== 2 ||
        flushed.failedDevices !== 0 ||
        payloads.length !== 2) {
      throw new Error('flush mismatch ' + JSON.stringify({ flushed, payloads }));
    }

    const expected1 = 'dropping_alert_' + String(alertIds[0]);
    const expected2 = 'dropping_alert_' + String(alertIds[1]);

    if (payloads[0].dataAlertId !== String(alertIds[0]) ||
        payloads[1].dataAlertId !== String(alertIds[1]) ||
        payloads[0].tag !== expected1 ||
        payloads[1].tag !== expected2 ||
        payloads[0].collapseKey !== expected1 ||
        payloads[1].collapseKey !== expected2 ||
        payloads[0].tag === payloads[1].tag ||
        payloads[0].collapseKey === payloads[1].collapseKey) {
      throw new Error('notification identity mismatch ' + JSON.stringify(payloads));
    }

    const after = await pool.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE push_sent_at IS NOT NULL)::int AS sent,
         (SELECT count(*)::int
            FROM dropping_push_deliveries
           WHERE alert_id = ANY($1::bigint[])
             AND sent_at IS NOT NULL) AS deliveries
       FROM dropping_alerts
       WHERE id = ANY($1::bigint[])`,
      [alertIds]
    );

    if (Number(after.rows[0].total) !== 2 ||
        Number(after.rows[0].sent) !== 2 ||
        Number(after.rows[0].deliveries) !== 2) {
      throw new Error('sent persistence mismatch ' + JSON.stringify(after.rows[0]));
    }

    const third = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async () => {
        throw new Error('completed alerts replayed');
      }
    });

    if (third.pending !== 0 || third.sentAlerts !== 0 || third.sentDevices !== 0) {
      throw new Error('third flush not empty ' + JSON.stringify(third));
    }

    const mobileSource = fs.readFileSync(
      path.join(__dirname, '..', 'mobile', 'lib', 'main.dart'),
      'utf8'
    );

    if (!mobileSource.includes("int.tryParse(data['alert_id'] ?? '')") ||
        !mobileSource.includes('onlyAlertOnce: true')) {
      throw new Error('mobile stable notification identity protection missing');
    }

    console.log(
      'NEW_DROP_NOTIFICATION_IDENTITY=OK ' +
      'SAME_MATCH_OUTCOME=true FIRST_ODD=2 SECOND_ODD=1.9 ' +
      'SAME_ODD_DUPLICATE=0 ALERTS=2 DISTINCT_ALERT_IDS=true ' +
      'DISTINCT_TAGS=true DISTINCT_COLLAPSE_KEYS=true SENDS=2 THIRD=0'
    );
  } finally {
    if (alertIds.length) {
      await pool.query('DELETE FROM dropping_alerts WHERE id = ANY($1::bigint[])', [alertIds]);
    }
    if (deviceId) {
      await pool.query('DELETE FROM dropping_push_devices WHERE id=$1', [deviceId]);
    } else {
      await pool.query('DELETE FROM dropping_push_devices WHERE token=$1', [token]);
    }
    await pool.query('DELETE FROM dropping_state WHERE item_key=$1', [itemKey]);

    const c = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM dropping_alerts WHERE item_key=$1) alerts,
         (SELECT count(*)::int FROM dropping_state WHERE item_key=$1) states,
         (SELECT count(*)::int FROM dropping_push_devices WHERE token=$2) devices,
         (SELECT count(*)::int FROM dropping_alerts WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending`,
      [itemKey, token]
    );

    if (Number(c.rows[0].alerts) !== 0 ||
        Number(c.rows[0].states) !== 0 ||
        Number(c.rows[0].devices) !== 0) {
      throw new Error('synthetic cleanup failed ' + JSON.stringify(c.rows[0]));
    }

    console.log('NEW_DROP_NOTIFICATION_CLEANUP=OK PENDING=' + c.rows[0].pending);
    await pool.end();
  }
})().catch(async e => {
  console.error('NEW_DROP_NOTIFICATION_ERROR=' + (e.message || e));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
