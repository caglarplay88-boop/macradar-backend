const { pool } = require('./db');
const { ensureDroppingSchema, registerDroppingPushDevice } = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

(async () => {
  await ensureDroppingSchema();

  const stamp = Date.now().toString();
  const prefix = 'TEST_ALL_UNREG_' + stamp + '_';
  const tokenA = 'TEST_ALL_UNREG_A_' + stamp;
  const tokenB = 'TEST_ALL_UNREG_B_' + stamp;
  const alertIds = [];
  let deviceA = null;
  let deviceB = null;
  const calls = { A: 0, B: 0 };
  let replayCalls = 0;

  try {
    const a = await registerDroppingPushDevice({
      token: tokenA,
      platform: 'android',
      deviceId: 'all-unreg-a-' + stamp
    });
    const b = await registerDroppingPushDevice({
      token: tokenB,
      platform: 'android',
      deviceId: 'all-unreg-b-' + stamp
    });
    deviceA = Number(a.id);
    deviceB = Number(b.id);

    for (let i = 1; i <= 5; i++) {
      const item = prefix + i + '|OUTCOME';
      const q = await pool.query(
        "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME',$3,'1','new',$4,TRUE) RETURNING id",
        [item, prefix + i, 'All Unregistered ' + i, 2 - i / 100]
      );
      alertIds.push(Number(q.rows[0].id));
    }

    const first = await flushDroppingPushes({
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert, device) => {
        if (String(device.id) === String(deviceA)) calls.A++;
        else if (String(device.id) === String(deviceB)) calls.B++;
        else throw new Error('unexpected device');

        const e = new Error('UNREGISTERED');
        e.unregistered = true;
        throw e;
      }
    });

    if (calls.A !== 1 || calls.B !== 1) {
      throw new Error('UNREGISTERED devices retried inside batch A=' + calls.A + ' B=' + calls.B);
    }

    const devicesAfter = await pool.query(
      'SELECT id,enabled FROM dropping_push_devices WHERE id = ANY($1::bigint[]) ORDER BY id',
      [[deviceA, deviceB]]
    );
    if (devicesAfter.rows.length !== 2 || devicesAfter.rows.some(r => r.enabled !== false)) {
      throw new Error('not all devices disabled');
    }

    const alertsAfter = await pool.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE push_eligible=FALSE)::int AS ineligible,
         count(*) FILTER (WHERE push_sent_at IS NULL)::int AS unsent,
         count(*) FILTER (WHERE push_attempt_count=1)::int AS one_attempt
       FROM dropping_alerts
       WHERE id = ANY($1::bigint[])`,
      [alertIds]
    );
    const ar = alertsAfter.rows[0];

    if (Number(ar.total) !== 5 ||
        Number(ar.ineligible) !== 5 ||
        Number(ar.unsent) !== 5 ||
        Number(ar.one_attempt) !== 5) {
      throw new Error('terminal alert state mismatch ' + JSON.stringify(ar));
    }

    const pending1 = await pool.query(
      'SELECT count(*)::int AS n FROM dropping_alerts WHERE id = ANY($1::bigint[]) AND push_eligible=TRUE AND push_sent_at IS NULL',
      [alertIds]
    );
    if (Number(pending1.rows[0].n) !== 0) {
      throw new Error('old alerts still pending after all devices unregistered');
    }

    const reA = await registerDroppingPushDevice({
      token: tokenA,
      platform: 'android',
      deviceId: 'all-unreg-a-' + stamp
    });
    const reB = await registerDroppingPushDevice({
      token: tokenB,
      platform: 'android',
      deviceId: 'all-unreg-b-' + stamp
    });
    if (reA.enabled !== true || reB.enabled !== true) {
      throw new Error('devices did not re-enable');
    }

    const replay = await flushDroppingPushes({
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async () => {
        replayCalls++;
        return 'ok';
      }
    });

    if (replayCalls !== 0 || replay.sentAlerts !== 0 || replay.sentDevices !== 0) {
      throw new Error('old terminal alerts replayed after re-register');
    }

    const fresh = await pool.query(
      "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME','Fresh After All Unregistered','1','new',1.80,TRUE) RETURNING id",
      [prefix + 'FRESH|OUTCOME', prefix + 'FRESH']
    );
    const freshId = Number(fresh.rows[0].id);
    alertIds.push(freshId);

    let freshCalls = 0;
    const freshFlush = await flushDroppingPushes({
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert) => {
        if (Number(alert.id) !== freshId) throw new Error('old alert entered fresh flush');
        freshCalls++;
        return 'ok';
      }
    });

    if (freshCalls !== 2 || freshFlush.sentAlerts !== 1 || freshFlush.sentDevices !== 2) {
      throw new Error('fresh alert delivery mismatch calls=' + freshCalls + ' result=' + JSON.stringify(freshFlush));
    }

    console.log(
      'ALL_UNREGISTERED=OK ' +
      'A_CALLS=1 B_CALLS=1 OLD_TERMINAL=5 OLD_REPLAY=0 ' +
      'REREGISTERED=2 FRESH_DEVICE_SENDS=2'
    );
  } finally {
    if (alertIds.length) {
      await pool.query('DELETE FROM dropping_alerts WHERE id = ANY($1::bigint[])', [alertIds]);
    }
    await pool.query('DELETE FROM dropping_push_devices WHERE token = ANY($1::text[])', [[tokenA, tokenB]]);

    const c = await pool.query(
      "SELECT (SELECT count(*)::int FROM dropping_alerts WHERE item_key LIKE $1) alerts,(SELECT count(*)::int FROM dropping_push_devices WHERE token = ANY($2::text[])) devices,(SELECT count(*)::int FROM dropping_alerts WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending",
      [prefix + '%', [tokenA, tokenB]]
    );

    if (Number(c.rows[0].alerts) !== 0 || Number(c.rows[0].devices) !== 0) {
      throw new Error('synthetic cleanup failed');
    }

    console.log('ALL_UNREGISTERED_CLEANUP=OK PENDING=' + c.rows[0].pending);
    await pool.end();
  }
})().catch(e => {
  console.error('ALL_UNREGISTERED_ERROR=' + (e.message || e));
  process.exitCode = 1;
});
