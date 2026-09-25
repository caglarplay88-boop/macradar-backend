const { execFileSync } = require('child_process');
const { pool } = require('./db');
const {
  ensureDroppingSchema
} = require('./dropping-store');
const {
  flushDroppingPushes
} = require('./dropping-push');

const stage = process.env.AD64_STAGE || '';
const ids = String(process.env.AD64_ALERT_IDS || '')
  .split(',')
  .filter(Boolean)
  .map(Number);

async function runChild() {
  await ensureDroppingSchema();

  if (stage === 'fail') {
    let threw = false;
    try {
      await flushDroppingPushes({
        limit: 25,
        accountOverride: {
          projectId: 'test-project',
          clientEmail: 'test@example.invalid',
          privateKey: 'NOT_A_VALID_RSA_PRIVATE_KEY'
        },
        sendImpl: async () => {
          throw new Error('send should not run during auth failure');
        }
      });
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('auth stage did not throw');

    const q = await pool.query(
      `SELECT
         count(*) FILTER (WHERE push_attempt_count=1)::int AS attempts,
         count(*) FILTER (WHERE push_sent_at IS NULL)::int AS unsent,
         count(*) FILTER (WHERE push_last_error LIKE 'FCM auth:%')::int AS auth_errors,
         (SELECT count(*)::int FROM dropping_push_deliveries WHERE alert_id = ANY($1::bigint[])) AS deliveries
       FROM dropping_alerts WHERE id = ANY($1::bigint[])`,
      [ids]
    );
    const r = q.rows[0];
    if (Number(r.attempts) !== ids.length ||
        Number(r.unsent) !== ids.length ||
        Number(r.auth_errors) !== ids.length ||
        Number(r.deliveries) !== 0) {
      throw new Error('stage fail persistence mismatch ' + JSON.stringify(r));
    }

    console.log('RESTART_AUTH_STAGE1=OK ATTEMPTS=' + r.attempts + ' UNSENT=' + r.unsent + ' DELIVERIES=0');
    await pool.end();
    return;
  }

  if (stage === 'success') {
    let sends = 0;
    const result = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (a, t, alert) => {
        if (!ids.includes(Number(alert.id))) throw new Error('unexpected alert in success stage');
        sends++;
        return 'ok';
      }
    });

    if (result.pending !== ids.length ||
        result.sentAlerts !== ids.length ||
        result.sentDevices !== ids.length ||
        sends !== ids.length) {
      throw new Error('stage success flush mismatch ' + JSON.stringify({ result, sends }));
    }

    const q = await pool.query(
      `SELECT
         count(*) FILTER (WHERE push_attempt_count=2)::int AS attempts,
         count(*) FILTER (WHERE push_sent_at IS NOT NULL)::int AS sent,
         count(*) FILTER (WHERE push_last_error IS NULL)::int AS cleared,
         (SELECT count(*)::int FROM dropping_push_deliveries
          WHERE alert_id = ANY($1::bigint[]) AND attempt_count=1
            AND sent_at IS NOT NULL AND last_error IS NULL) AS deliveries
       FROM dropping_alerts WHERE id = ANY($1::bigint[])`,
      [ids]
    );
    const r = q.rows[0];
    if (Number(r.attempts) !== ids.length ||
        Number(r.sent) !== ids.length ||
        Number(r.cleared) !== ids.length ||
        Number(r.deliveries) !== ids.length) {
      throw new Error('stage success persistence mismatch ' + JSON.stringify(r));
    }

    console.log('RESTART_AUTH_STAGE2=OK SENDS=' + sends + ' ATTEMPTS=' + r.attempts + ' DELIVERIES=' + r.deliveries);
    await pool.end();
    return;
  }

  if (stage === 'verify') {
    let sends = 0;
    const result = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async () => {
        sends++;
        return 'ok';
      }
    });

    if (result.pending !== 0 ||
        result.sentAlerts !== 0 ||
        result.sentDevices !== 0 ||
        sends !== 0) {
      throw new Error('stage verify replayed completed alerts ' + JSON.stringify({ result, sends }));
    }

    console.log('RESTART_AUTH_STAGE3=OK SENDS=0 PENDING=0');
    await pool.end();
    return;
  }

  throw new Error('unknown child stage');
}

async function runParent() {
  await ensureDroppingSchema();

  const stamp = Date.now().toString();
  const prefix = 'TEST_AUTH_RESTART_' + stamp + '_';
  const token = 'TEST_AUTH_RESTART_DEVICE_' + stamp;
  const alertIds = [];
  let deviceId = null;

  try {
    const d = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'auth-restart-' + stamp]
    );
    deviceId = Number(d.rows[0].id);

    for (let i = 1; i <= 3; i++) {
      const item = prefix + i + '|OUTCOME';
      const a = await pool.query(
        "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME',$3,'1','new',$4,TRUE) RETURNING id",
        [item, prefix + i, 'Auth Restart ' + i, 2 - i / 100]
      );
      alertIds.push(Number(a.rows[0].id));
    }

    const envBase = {
      ...process.env,
      AD64_ALERT_IDS: alertIds.join(',')
    };

    for (const childStage of ['fail', 'success', 'verify']) {
      const output = execFileSync(
        process.execPath,
        [__filename],
        {
          env: { ...envBase, AD64_STAGE: childStage },
          encoding: 'utf8'
        }
      );
      process.stdout.write(output);
    }

    const final = await pool.query(
      `SELECT
         count(*) FILTER (WHERE push_sent_at IS NOT NULL)::int AS sent,
         count(*) FILTER (WHERE push_attempt_count=2)::int AS attempts,
         count(*) FILTER (WHERE push_last_error IS NULL)::int AS cleared
       FROM dropping_alerts WHERE id = ANY($1::bigint[])`,
      [alertIds]
    );
    const r = final.rows[0];

    if (Number(r.sent) !== 3 || Number(r.attempts) !== 3 || Number(r.cleared) !== 3) {
      throw new Error('parent final mismatch ' + JSON.stringify(r));
    }

    console.log('AUTH_RESTART_PERSISTENCE=OK STAGES=3 ALERTS=3 DUPLICATES=0');
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

    console.log('AUTH_RESTART_CLEANUP=OK PENDING=' + c.rows[0].pending);
    await pool.end();
  }
}

(stage ? runChild() : runParent()).catch(async e => {
  console.error('AUTH_RESTART_ERROR=' + (e.message || e));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
