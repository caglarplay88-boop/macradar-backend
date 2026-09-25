const { pool } = require('./db');
const { ensureDroppingSchema } = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

(async () => {
  await ensureDroppingSchema();
  const stamp = Date.now().toString();
  const prefix = 'TEST_AUTH_BATCH_' + stamp + '_';
  const tokens = ['TEST_AUTH_BATCH_A_' + stamp, 'TEST_AUTH_BATCH_B_' + stamp];
  const deviceIds = [];
  const alertIds = [];
  let staleCalls = 0;
  let recoveryCalls = 0;

  try {
    for (let i = 0; i < 2; i++) {
      const d = await pool.query(
        "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
        [tokens[i], 'auth-batch-' + i + '-' + stamp]
      );
      deviceIds.push(Number(d.rows[0].id));
    }

    for (let i = 1; i <= 3; i++) {
      const a = await pool.query(
        "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME',$3,'1','new',$4,TRUE) RETURNING id",
        [prefix + i + '|OUTCOME', prefix + i, 'Auth Batch ' + i, 2 - i / 100]
      );
      alertIds.push(Number(a.rows[0].id));
    }

    const first = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'stale-access',
      sendImpl: async () => {
        staleCalls++;
        const e = new Error('FCM HTTP 401: UNAUTHENTICATED');
        e.authRejected = true;
        throw e;
      }
    });

    const afterFirst = await pool.query(
      `SELECT
         count(*) FILTER (WHERE push_attempt_count=1)::int AS attempted,
         count(*) FILTER (WHERE push_attempt_count=0)::int AS untouched,
         (SELECT count(*)::int FROM dropping_push_deliveries WHERE alert_id = ANY($1::bigint[])) AS deliveries
       FROM dropping_alerts
       WHERE id = ANY($1::bigint[])`,
      [alertIds]
    );
    const f = afterFirst.rows[0];

    if (staleCalls !== 1) {
      throw new Error('AUTH_REJECTION_STORM staleCalls=' + staleCalls);
    }
    if (first.failedDevices !== 1) {
      throw new Error('first failedDevices expected 1 got ' + first.failedDevices);
    }
    if (Number(f.attempted) !== 1 || Number(f.untouched) !== 2 || Number(f.deliveries) !== 1) {
      throw new Error('first batch boundary mismatch ' + JSON.stringify(f));
    }

    const second = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'fresh-access',
      sendImpl: async () => {
        recoveryCalls++;
        return 'ok';
      }
    });

    if (second.sentAlerts !== 3 || second.sentDevices !== 6 || recoveryCalls !== 6) {
      throw new Error('recovery mismatch ' + JSON.stringify({ second, recoveryCalls }));
    }

    const final = await pool.query(
      `SELECT
         count(*) FILTER (WHERE push_sent_at IS NOT NULL)::int AS sent,
         count(*) FILTER (WHERE push_attempt_count=2)::int AS two_attempt,
         count(*) FILTER (WHERE push_attempt_count=1)::int AS one_attempt,
         (SELECT count(*)::int FROM dropping_push_deliveries
          WHERE alert_id = ANY($1::bigint[]) AND sent_at IS NOT NULL) AS delivered
       FROM dropping_alerts
       WHERE id = ANY($1::bigint[])`,
      [alertIds]
    );
    const r = final.rows[0];

    if (Number(r.sent) !== 3 || Number(r.two_attempt) !== 1 ||
        Number(r.one_attempt) !== 2 || Number(r.delivered) !== 6) {
      throw new Error('final persistence mismatch ' + JSON.stringify(r));
    }

    const third = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'fresh-access',
      sendImpl: async () => {
        recoveryCalls++;
        return 'ok';
      }
    });

    if (third.pending !== 0 || recoveryCalls !== 6) {
      throw new Error('duplicate after recovery');
    }

    console.log('AUTH_BATCH_STOP=OK FIRST_CALLS=1 FIRST_ATTEMPTED=1 FIRST_UNTOUCHED=2 RECOVERY_ALERTS=3 RECOVERY_DEVICE_SENDS=6 THIRD=0');
  } finally {
    if (alertIds.length) {
      await pool.query('DELETE FROM dropping_alerts WHERE id = ANY($1::bigint[])', [alertIds]);
    }
    await pool.query('DELETE FROM dropping_push_devices WHERE token = ANY($1::text[])', [tokens]);
    const c = await pool.query(
      "SELECT (SELECT count(*)::int FROM dropping_alerts WHERE item_key LIKE $1) alerts,(SELECT count(*)::int FROM dropping_push_devices WHERE token = ANY($2::text[])) devices,(SELECT count(*)::int FROM dropping_alerts WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending",
      [prefix + '%', tokens]
    );
    console.log('AUTH_BATCH_STOP_CLEANUP=' + (Number(c.rows[0].alerts)===0 && Number(c.rows[0].devices)===0 ? 'OK' : 'FAIL') + ' PENDING=' + c.rows[0].pending);
    await pool.end();
  }
})().catch(e => {
  console.error('AUTH_BATCH_STOP_ERROR=' + (e.message || e));
  process.exitCode = 1;
});
