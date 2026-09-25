const crypto = require('crypto');
const { pool } = require('./db');
const { ensureDroppingSchema } = require('./dropping-store');

async function runScenario(status) {
  const stamp = Date.now().toString() + '_' + status;
  const prefix = 'TEST_AUTH_CACHE_' + status + '_' + stamp + '_';
  const token = 'TEST_AUTH_CACHE_DEVICE_' + status + '_' + stamp;
  let alertId = null;
  let deviceId = null;

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });

  let tokenCalls = 0;
  let fcmCalls = 0;
  const stale = 'STALE_' + status;
  const fresh = 'FRESH_' + status;

  const originalFetch = global.fetch;

  try {
    const d = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'auth-cache-' + status + '-' + stamp]
    );
    deviceId = Number(d.rows[0].id);

    const a = await pool.query(
      "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME',$3,'1','new',1.95,TRUE) RETURNING id",
      [prefix + 'ALERT|OUTCOME', prefix + 'ALERT', 'Auth Cache ' + status]
    );
    alertId = Number(a.rows[0].id);

    global.fetch = async (url, options = {}) => {
      const target = String(url);

      if (target.includes('oauth2.googleapis.com/token')) {
        tokenCalls++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: tokenCalls === 1 ? stale : fresh,
            expires_in: 3600
          })
        };
      }

      if (target.includes('fcm.googleapis.com/')) {
        fcmCalls++;
        const auth = String(options.headers?.authorization || '');

        if (auth === 'Bearer ' + stale) {
          return {
            ok: false,
            status,
            text: async () => JSON.stringify({
              error: { status: status === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED' }
            })
          };
        }

        if (auth === 'Bearer ' + fresh) {
          return {
            ok: true,
            status: 200,
            text: async () => '{}'
          };
        }

        throw new Error('unexpected auth header ' + auth);
      }

      throw new Error('unexpected fetch url ' + target);
    };

    delete require.cache[require.resolve('./dropping-push')];
    const { flushDroppingPushes } = require('./dropping-push');

    const account = {
      projectId: 'test-project',
      clientEmail: 'test@example.invalid',
      privateKey
    };

    const first = await flushDroppingPushes({
      limit: 25,
      accountOverride: account
    });

    if (first.pending !== 1 || first.sentAlerts !== 0 ||
        first.sentDevices !== 0 || first.failedDevices !== 1) {
      throw new Error(status + ' first flush mismatch ' + JSON.stringify(first));
    }
    if (tokenCalls !== 1 || fcmCalls !== 1) {
      throw new Error(status + ' first call counts mismatch token=' + tokenCalls + ' fcm=' + fcmCalls);
    }

    const failState = await pool.query(
      `SELECT
         push_attempt_count,
         push_sent_at,
         push_last_error,
         (SELECT attempt_count FROM dropping_push_deliveries WHERE alert_id=$1 AND device_id=$2) AS d_count,
         (SELECT last_error FROM dropping_push_deliveries WHERE alert_id=$1 AND device_id=$2) AS d_error
       FROM dropping_alerts WHERE id=$1`,
      [alertId, deviceId]
    );
    const f = failState.rows[0];

    if (Number(f.push_attempt_count) !== 1 ||
        f.push_sent_at !== null ||
        !String(f.push_last_error || '').includes('FCM HTTP ' + status) ||
        Number(f.d_count) !== 1 ||
        !String(f.d_error || '').includes('FCM HTTP ' + status)) {
      throw new Error(status + ' failure DB state mismatch ' + JSON.stringify(f));
    }

    const second = await flushDroppingPushes({
      limit: 25,
      accountOverride: account
    });

    if (second.pending !== 1 || second.sentAlerts !== 1 ||
        second.sentDevices !== 1 || second.failedDevices !== 0) {
      throw new Error(status + ' second flush mismatch ' + JSON.stringify(second));
    }

    if (tokenCalls !== 2) {
      throw new Error(status + ' cached token was reused tokenCalls=' + tokenCalls);
    }
    if (fcmCalls !== 2) {
      throw new Error(status + ' FCM call count mismatch ' + fcmCalls);
    }

    const successState = await pool.query(
      `SELECT
         push_attempt_count,
         push_sent_at,
         push_last_error,
         (SELECT attempt_count FROM dropping_push_deliveries WHERE alert_id=$1 AND device_id=$2) AS d_count,
         (SELECT sent_at FROM dropping_push_deliveries WHERE alert_id=$1 AND device_id=$2) AS d_sent,
         (SELECT last_error FROM dropping_push_deliveries WHERE alert_id=$1 AND device_id=$2) AS d_error
       FROM dropping_alerts WHERE id=$1`,
      [alertId, deviceId]
    );
    const s = successState.rows[0];

    if (Number(s.push_attempt_count) !== 2 ||
        !s.push_sent_at ||
        s.push_last_error !== null ||
        Number(s.d_count) !== 2 ||
        !s.d_sent ||
        s.d_error !== null) {
      throw new Error(status + ' success DB state mismatch ' + JSON.stringify(s));
    }

    const third = await flushDroppingPushes({
      limit: 25,
      accountOverride: account
    });

    if (third.pending !== 0 || third.sentAlerts !== 0 || third.sentDevices !== 0) {
      throw new Error(status + ' third flush replay ' + JSON.stringify(third));
    }
    if (tokenCalls !== 2 || fcmCalls !== 2) {
      throw new Error(status + ' completed alert caused extra calls');
    }

    console.log(
      'AUTH_CACHE_' + status + '=OK TOKEN_CALLS=2 FCM_CALLS=2 ' +
      'FIRST_FAILED=1 SECOND_SENT=1 THIRD=0 DUPLICATES=0'
    );
  } finally {
    global.fetch = originalFetch;
    if (alertId) await pool.query('DELETE FROM dropping_alerts WHERE id=$1', [alertId]);
    if (deviceId) await pool.query('DELETE FROM dropping_push_devices WHERE id=$1', [deviceId]);
    else await pool.query('DELETE FROM dropping_push_devices WHERE token=$1', [token]);
  }
}

(async () => {
  await ensureDroppingSchema();
  await runScenario(401);
  await runScenario(403);

  const c = await pool.query(
    "SELECT (SELECT count(*)::int FROM dropping_alerts WHERE item_key LIKE 'TEST_AUTH_CACHE_%') alerts,(SELECT count(*)::int FROM dropping_push_devices WHERE token LIKE 'TEST_AUTH_CACHE_%') devices,(SELECT count(*)::int FROM dropping_alerts WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending"
  );

  if (Number(c.rows[0].alerts) !== 0 || Number(c.rows[0].devices) !== 0) {
    throw new Error('synthetic cleanup failed');
  }

  console.log('AUTH_CACHE_CLEANUP=OK PENDING=' + c.rows[0].pending);
  await pool.end();
})().catch(async e => {
  console.error('AUTH_CACHE_ERROR=' + (e.message || e));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
