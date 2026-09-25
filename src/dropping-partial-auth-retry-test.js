const { pool } = require('./db');
const { ensureDroppingSchema } = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

async function runScenario(status) {
  const stamp = Date.now().toString() + '_' + status;
  const prefix = 'TEST_PARTIAL_AUTH_' + status + '_' + stamp + '_';
  const tokenA = 'TEST_PARTIAL_AUTH_A_' + status + '_' + stamp;
  const tokenB = 'TEST_PARTIAL_AUTH_B_' + status + '_' + stamp;
  let deviceA = null;
  let deviceB = null;
  let alertId = null;
  const calls = { A: 0, B: 0 };

  try {
    const b = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [tokenB, 'partial-auth-b-' + status + '-' + stamp]
    );
    deviceB = Number(b.rows[0].id);

    await new Promise(resolve => setTimeout(resolve, 5));

    const a = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [tokenA, 'partial-auth-a-' + status + '-' + stamp]
    );
    deviceA = Number(a.rows[0].id);

    const alert = await pool.query(
      "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME',$3,'1','new',1.91,TRUE) RETURNING id",
      [prefix + 'ALERT|OUTCOME', prefix + 'ALERT', 'Partial Auth ' + status]
    );
    alertId = Number(alert.rows[0].id);

    const order = await pool.query(
      "SELECT id FROM dropping_push_devices WHERE id = ANY($1::bigint[]) AND enabled=TRUE ORDER BY updated_at DESC",
      [[deviceA, deviceB]]
    );
    if (order.rows.length !== 2 ||
        Number(order.rows[0].id) !== deviceA ||
        Number(order.rows[1].id) !== deviceB) {
      throw new Error(status + ' device order is not A then B');
    }

    const first = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'stale-access',
      sendImpl: async (account, accessToken, currentAlert, device) => {
        if (Number(currentAlert.id) !== alertId) throw new Error('unexpected alert');
        if (String(device.id) === String(deviceA)) {
          calls.A++;
          return 'ok';
        }
        if (String(device.id) === String(deviceB)) {
          calls.B++;
          const e = new Error('FCM HTTP ' + status + ': AUTH_REJECTED');
          e.authRejected = true;
          throw e;
        }
        throw new Error('unexpected device');
      }
    });

    if (calls.A !== 1 || calls.B !== 1) {
      throw new Error(status + ' first calls mismatch ' + JSON.stringify(calls));
    }
    if (first.sentAlerts !== 0 || first.sentDevices !== 1 || first.failedDevices !== 1) {
      throw new Error(status + ' first flush mismatch ' + JSON.stringify(first));
    }

    const firstDb = await pool.query(
      `SELECT
         a.push_attempt_count,
         a.push_sent_at,
         a.push_last_error,
         da.attempt_count AS a_attempts,
         da.sent_at AS a_sent,
         da.last_error AS a_error,
         db.attempt_count AS b_attempts,
         db.sent_at AS b_sent,
         db.last_error AS b_error
       FROM dropping_alerts a
       LEFT JOIN dropping_push_deliveries da ON da.alert_id=a.id AND da.device_id=$2
       LEFT JOIN dropping_push_deliveries db ON db.alert_id=a.id AND db.device_id=$3
       WHERE a.id=$1`,
      [alertId, deviceA, deviceB]
    );
    const f = firstDb.rows[0];

    if (Number(f.push_attempt_count) !== 1 ||
        f.push_sent_at !== null ||
        Number(f.a_attempts) !== 1 ||
        !f.a_sent ||
        f.a_error !== null ||
        Number(f.b_attempts) !== 1 ||
        f.b_sent !== null ||
        !String(f.b_error || '').includes('FCM HTTP ' + status)) {
      throw new Error(status + ' first persistence mismatch ' + JSON.stringify(f));
    }

    const second = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'fresh-access',
      sendImpl: async (account, accessToken, currentAlert, device) => {
        if (Number(currentAlert.id) !== alertId) throw new Error('unexpected alert on retry');
        if (String(device.id) === String(deviceA)) {
          calls.A++;
          return 'unexpected-a';
        }
        if (String(device.id) === String(deviceB)) {
          calls.B++;
          return 'ok';
        }
        throw new Error('unexpected retry device');
      }
    });

    if (calls.A !== 1 || calls.B !== 2) {
      throw new Error(status + ' retry duplicate/missing ' + JSON.stringify(calls));
    }
    if (second.pending !== 1 || second.sentAlerts !== 1 ||
        second.sentDevices !== 1 || second.failedDevices !== 0) {
      throw new Error(status + ' second flush mismatch ' + JSON.stringify(second));
    }

    const finalDb = await pool.query(
      `SELECT
         a.push_attempt_count,
         a.push_sent_at,
         a.push_last_error,
         da.attempt_count AS a_attempts,
         da.sent_at AS a_sent,
         db.attempt_count AS b_attempts,
         db.sent_at AS b_sent,
         db.last_error AS b_error
       FROM dropping_alerts a
       LEFT JOIN dropping_push_deliveries da ON da.alert_id=a.id AND da.device_id=$2
       LEFT JOIN dropping_push_deliveries db ON db.alert_id=a.id AND db.device_id=$3
       WHERE a.id=$1`,
      [alertId, deviceA, deviceB]
    );
    const s = finalDb.rows[0];

    if (Number(s.push_attempt_count) !== 2 ||
        !s.push_sent_at ||
        s.push_last_error !== null ||
        Number(s.a_attempts) !== 1 ||
        !s.a_sent ||
        Number(s.b_attempts) !== 2 ||
        !s.b_sent ||
        s.b_error !== null) {
      throw new Error(status + ' final persistence mismatch ' + JSON.stringify(s));
    }

    const third = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'fresh-access',
      sendImpl: async (account, accessToken, currentAlert, device) => {
        if (String(device.id) === String(deviceA)) calls.A++;
        if (String(device.id) === String(deviceB)) calls.B++;
        return 'ok';
      }
    });

    if (third.pending !== 0 || third.sentAlerts !== 0 ||
        calls.A !== 1 || calls.B !== 2) {
      throw new Error(status + ' third flush replay ' + JSON.stringify({ third, calls }));
    }

    console.log(
      'PARTIAL_AUTH_' + status + '=OK ' +
      'A_CALLS=1 B_CALLS=2 A_DELIVERY_ATTEMPTS=1 B_DELIVERY_ATTEMPTS=2 ' +
      'SECOND_ONLY_B=true THIRD=0 DUPLICATES=0'
    );
  } finally {
    if (alertId) await pool.query('DELETE FROM dropping_alerts WHERE id=$1', [alertId]);
    await pool.query(
      'DELETE FROM dropping_push_devices WHERE token = ANY($1::text[])',
      [[tokenA, tokenB]]
    );
  }
}

(async () => {
  await ensureDroppingSchema();
  await runScenario(401);
  await runScenario(403);

  const c = await pool.query(
    "SELECT (SELECT count(*)::int FROM dropping_alerts WHERE item_key LIKE 'TEST_PARTIAL_AUTH_%') alerts,(SELECT count(*)::int FROM dropping_push_devices WHERE token LIKE 'TEST_PARTIAL_AUTH_%') devices,(SELECT count(*)::int FROM dropping_alerts WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending"
  );
  if (Number(c.rows[0].alerts) !== 0 || Number(c.rows[0].devices) !== 0) {
    throw new Error('synthetic cleanup failed');
  }

  console.log('PARTIAL_AUTH_CLEANUP=OK PENDING=' + c.rows[0].pending);
  await pool.end();
})().catch(async e => {
  console.error('PARTIAL_AUTH_ERROR=' + (e.message || e));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
