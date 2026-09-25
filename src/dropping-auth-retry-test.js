const { pool } = require('./db');
const { ensureDroppingSchema } = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

(async () => {
  await ensureDroppingSchema();
  const stamp = Date.now().toString();
  const prefix = 'TEST_AUTH_RETRY_' + stamp + '_';
  const token = 'TEST_AUTH_RETRY_DEVICE_' + stamp;
  const alertIds = [];
  let deviceId = null;
  let sends = 0;

  try {
    const d = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'auth-retry-' + stamp]
    );
    deviceId = Number(d.rows[0].id);

    for (let i = 1; i <= 3; i++) {
      const item = prefix + i + '|OUTCOME';
      const a = await pool.query(
        "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME',$3,'1','new',$4,TRUE) RETURNING id",
        [item, prefix + i, 'Auth Retry ' + i, 2 - i / 100]
      );
      alertIds.push(Number(a.rows[0].id));
    }

    let authFailed = false;
    try {
      await flushDroppingPushes({
        limit: 25,
        accountOverride: {
          projectId: 'test-project',
          clientEmail: 'test@example.invalid',
          privateKey: 'NOT_A_VALID_RSA_PRIVATE_KEY'
        },
        sendImpl: async () => {
          sends++;
          return 'should-not-run';
        }
      });
    } catch (e) {
      authFailed = true;
    }

    if (!authFailed) throw new Error('auth failure did not throw');
    if (sends !== 0) throw new Error('sendImpl ran during auth failure');

    const afterFail = await pool.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE push_sent_at IS NULL)::int AS unsent,
         count(*) FILTER (WHERE push_eligible=TRUE)::int AS eligible,
         count(*) FILTER (WHERE push_attempt_count=1)::int AS one_attempt,
         count(*) FILTER (WHERE push_last_attempt_at IS NOT NULL)::int AS has_attempt_time,
         count(*) FILTER (WHERE push_last_error LIKE 'FCM auth:%')::int AS auth_errors
       FROM dropping_alerts
       WHERE id = ANY($1::bigint[])`,
      [alertIds]
    );
    const f = afterFail.rows[0];

    if (Number(f.total) !== 3 ||
        Number(f.unsent) !== 3 ||
        Number(f.eligible) !== 3 ||
        Number(f.one_attempt) !== 3 ||
        Number(f.has_attempt_time) !== 3 ||
        Number(f.auth_errors) !== 3) {
      throw new Error('auth failure persistence mismatch ' + JSON.stringify(f));
    }

    const deliveriesAfterFail = await pool.query(
      'SELECT count(*)::int AS n FROM dropping_push_deliveries WHERE alert_id = ANY($1::bigint[])',
      [alertIds]
    );
    if (Number(deliveriesAfterFail.rows[0].n) !== 0) {
      throw new Error('delivery rows created before auth succeeded');
    }

    const recovered = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async () => {
        sends++;
        return 'ok';
      }
    });

    if (recovered.pending !== 3 ||
        recovered.sentAlerts !== 3 ||
        recovered.sentDevices !== 3 ||
        recovered.failedDevices !== 0) {
      throw new Error('recovery flush mismatch ' + JSON.stringify(recovered));
    }
    if (sends !== 3) throw new Error('recovery send count mismatch ' + sends);

    const afterSuccess = await pool.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE push_sent_at IS NOT NULL)::int AS sent,
         count(*) FILTER (WHERE push_attempt_count=2)::int AS two_attempts,
         count(*) FILTER (WHERE push_last_error IS NULL)::int AS errors_cleared
       FROM dropping_alerts
       WHERE id = ANY($1::bigint[])`,
      [alertIds]
    );
    const s = afterSuccess.rows[0];

    if (Number(s.total) !== 3 ||
        Number(s.sent) !== 3 ||
        Number(s.two_attempts) !== 3 ||
        Number(s.errors_cleared) !== 3) {
      throw new Error('recovery alert state mismatch ' + JSON.stringify(s));
    }

    const deliverySuccess = await pool.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE attempt_count=1 AND sent_at IS NOT NULL AND last_error IS NULL)::int AS clean
       FROM dropping_push_deliveries
       WHERE alert_id = ANY($1::bigint[])`,
      [alertIds]
    );
    if (Number(deliverySuccess.rows[0].total) !== 3 ||
        Number(deliverySuccess.rows[0].clean) !== 3) {
      throw new Error('recovery delivery state mismatch ' + JSON.stringify(deliverySuccess.rows[0]));
    }

    const third = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async () => {
        sends++;
        return 'ok';
      }
    });

    if (third.pending !== 0 || third.sentAlerts !== 0 || third.sentDevices !== 0) {
      throw new Error('completed alerts replayed ' + JSON.stringify(third));
    }
    if (sends !== 3) throw new Error('duplicate sends after recovery');

    console.log(
      'AUTH_RETRY=OK AUTH_FAILED=3 SENDS_DURING_AUTH=0 ' +
      'RECOVERED=3 ATTEMPTS=2 DELIVERY_ATTEMPTS=1 THIRD=0 DUPLICATES=0'
    );
  } finally {
    if (alertIds.length) {
      await pool.query('DELETE FROM dropping_alerts WHERE id = ANY($1::bigint[])', [alertIds]);
    }
    if (deviceId) await pool.query('DELETE FROM dropping_push_devices WHERE id=$1', [deviceId]);
    else await pool.query('DELETE FROM dropping_push_devices WHERE token=$1', [token]);

    const c = await pool.query(
      "SELECT (SELECT count(*)::int FROM dropping_alerts WHERE item_key LIKE $1) alerts,(SELECT count(*)::int FROM dropping_push_devices WHERE token=$2) devices,(SELECT count(*)::int FROM dropping_alerts WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending",
      [prefix + '%', token]
    );

    if (Number(c.rows[0].alerts) !== 0 || Number(c.rows[0].devices) !== 0) {
      throw new Error('synthetic cleanup failed');
    }

    console.log('AUTH_RETRY_CLEANUP=OK PENDING=' + c.rows[0].pending);
    await pool.end();
  }
})().catch(e => {
  console.error('AUTH_RETRY_ERROR=' + (e.message || e));
  process.exitCode = 1;
});
