const { pool } = require('./db');
const { ensureDroppingSchema } = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

(async () => {
  await ensureDroppingSchema();

  const stamp = Date.now().toString();
  const prefix = 'TEST_STARVE_ALERT_' + stamp + '_';
  const token = 'TEST_STARVE_DEVICE_' + stamp;
  const alertIds = [];
  const failingIds = new Set();
  const healthyIds = new Set();
  let deviceId = null;
  let failingCalls = 0;
  let healthyCalls = 0;

  try {
    const d = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'starve-' + stamp]
    );
    deviceId = Number(d.rows[0].id);

    for (let i = 1; i <= 30; i++) {
      const a = await pool.query(
        "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME',$3,'1','new',$4,TRUE) RETURNING id",
        [
          prefix + String(i).padStart(2, '0') + '|OUTCOME',
          prefix + String(i).padStart(2, '0'),
          'Starvation Alert ' + i,
          2.50 - i / 1000
        ]
      );
      const id = Number(a.rows[0].id);
      alertIds.push(id);
      if (i <= 25) failingIds.add(id);
      else healthyIds.add(id);
    }

    const options = {
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert, device) => {
        if (String(device.id) !== String(deviceId)) {
          throw new Error('unexpected device');
        }

        const id = Number(alert.id);
        if (failingIds.has(id)) {
          failingCalls++;
          throw new Error('synthetic 503 starvation');
        }
        if (healthyIds.has(id)) {
          healthyCalls++;
          return 'ok';
        }
        throw new Error('unexpected alert id=' + id);
      }
    };

    const first = await flushDroppingPushes(options);

    if (first.pending !== 25 ||
        first.sentAlerts !== 0 ||
        first.sentDevices !== 0 ||
        first.failedDevices !== 25 ||
        failingCalls !== 25 ||
        healthyCalls !== 0) {
      throw new Error(
        'first flush mismatch ' +
        JSON.stringify({ first, failingCalls, healthyCalls })
      );
    }

    const afterFirst = await pool.query(
      `SELECT
         count(*) FILTER (WHERE id=ANY($1::bigint[]) AND push_attempt_count=1)::int AS failed_attempted,
         count(*) FILTER (WHERE id=ANY($2::bigint[]) AND push_attempt_count=0)::int AS healthy_unattempted
       FROM dropping_alerts
       WHERE id=ANY($3::bigint[])`,
      [[...failingIds], [...healthyIds], alertIds]
    );

    if (Number(afterFirst.rows[0].failed_attempted) !== 25 ||
        Number(afterFirst.rows[0].healthy_unattempted) !== 5) {
      throw new Error('first persistence mismatch ' + JSON.stringify(afterFirst.rows[0]));
    }

    const second = await flushDroppingPushes(options);

    if (healthyCalls !== 5) {
      throw new Error(
        'STARVATION healthy_calls=' + healthyCalls +
        ' second=' + JSON.stringify(second)
      );
    }

    const healthyDb = await pool.query(
      `SELECT
         count(*) FILTER (WHERE push_sent_at IS NOT NULL)::int AS sent,
         count(*) FILTER (WHERE push_attempt_count=1)::int AS attempts,
         (SELECT count(*)::int
            FROM dropping_push_deliveries
           WHERE alert_id=ANY($1::bigint[])
             AND sent_at IS NOT NULL) AS deliveries
       FROM dropping_alerts
       WHERE id=ANY($1::bigint[])`,
      [[...healthyIds]]
    );

    if (Number(healthyDb.rows[0].sent) !== 5 ||
        Number(healthyDb.rows[0].attempts) !== 5 ||
        Number(healthyDb.rows[0].deliveries) !== 5) {
      throw new Error('healthy persistence mismatch ' + JSON.stringify(healthyDb.rows[0]));
    }

    const failedDb = await pool.query(
      `SELECT
         min(push_attempt_count)::int AS min_attempt,
         max(push_attempt_count)::int AS max_attempt,
         count(*) FILTER (WHERE push_sent_at IS NULL)::int AS still_pending
       FROM dropping_alerts
       WHERE id=ANY($1::bigint[])`,
      [[...failingIds]]
    );

    if (Number(failedDb.rows[0].still_pending) !== 25) {
      throw new Error('failing pending mismatch ' + JSON.stringify(failedDb.rows[0]));
    }

    console.log(
      'RETRY_STARVATION=OK FIRST_FAILED=25 SECOND_HEALTHY_SENT=5 ' +
      'HEALTHY_DELIVERIES=5 FAILING_STILL_PENDING=25 ' +
      'FAILED_ATTEMPT_RANGE=' +
      failedDb.rows[0].min_attempt + '-' + failedDb.rows[0].max_attempt
    );
  } finally {
    if (alertIds.length) {
      await pool.query(
        'DELETE FROM dropping_alerts WHERE id=ANY($1::bigint[])',
        [alertIds]
      );
    }

    if (deviceId) {
      await pool.query('DELETE FROM dropping_push_devices WHERE id=$1', [deviceId]);
    } else {
      await pool.query('DELETE FROM dropping_push_devices WHERE token=$1', [token]);
    }

    const c = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM dropping_alerts WHERE item_key LIKE $1) alerts,
         (SELECT count(*)::int FROM dropping_push_devices WHERE token=$2) devices,
         (SELECT count(*)::int FROM dropping_alerts
           WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending,
         (SELECT count(*)::int FROM pg_locks
           WHERE locktype='advisory' AND granted) advisory_locks`,
      [prefix + '%', token]
    );

    console.log(
      'RETRY_STARVATION_CLEANUP=' +
      (
        Number(c.rows[0].alerts) === 0 &&
        Number(c.rows[0].devices) === 0
          ? 'OK'
          : 'FAIL'
      ) +
      ' PENDING=' + c.rows[0].pending +
      ' ADVISORY_LOCKS=' + c.rows[0].advisory_locks
    );

    await pool.end();
  }
})().catch(async error => {
  console.error('RETRY_STARVATION_ERROR=' + (error.message || error));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
