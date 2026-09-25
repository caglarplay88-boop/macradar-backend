const { execFileSync } = require('child_process');
const { pool } = require('./db');
const { ensureDroppingSchema } = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

const stage = process.env.AD69_STAGE || '';
const alertId = Number(process.env.AD69_ALERT_ID || 0);
const deviceA = Number(process.env.AD69_DEVICE_A || 0);
const deviceB = Number(process.env.AD69_DEVICE_B || 0);

async function childRun() {
  await ensureDroppingSchema();

  if (stage === 'fail') {
    const calls = { A: 0, B: 0 };
    const result = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert, device) => {
        if (Number(alert.id) !== alertId) throw new Error('unexpected alert in fail stage');
        if (String(device.id) === String(deviceA)) {
          calls.A++;
          return 'ok';
        }
        if (String(device.id) === String(deviceB)) {
          calls.B++;
          throw new Error('synthetic 503');
        }
        throw new Error('unexpected device in fail stage');
      }
    });

    if (calls.A !== 1 || calls.B !== 1 ||
        result.sentAlerts !== 0 || result.sentDevices !== 1 ||
        result.failedDevices !== 1) {
      throw new Error('stage1 mismatch ' + JSON.stringify({ calls, result }));
    }

    const q = await pool.query(
      `SELECT
         a.push_attempt_count,
         a.push_sent_at,
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
    const r = q.rows[0];

    if (Number(r.push_attempt_count) !== 1 ||
        r.push_sent_at !== null ||
        Number(r.a_attempts) !== 1 || !r.a_sent || r.a_error !== null ||
        Number(r.b_attempts) !== 1 || r.b_sent !== null ||
        !String(r.b_error || '').includes('synthetic 503')) {
      throw new Error('stage1 persistence mismatch ' + JSON.stringify(r));
    }

    console.log('PARTIAL_503_RESTART_STAGE1=OK A_CALLS=1 B_CALLS=1 A_SENT=true B_PENDING=true');
    await pool.end();
    return;
  }

  if (stage === 'recover') {
    const calls = { A: 0, B: 0 };
    const result = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert, device) => {
        if (Number(alert.id) !== alertId) throw new Error('unexpected alert in recover stage');
        if (String(device.id) === String(deviceA)) calls.A++;
        else if (String(device.id) === String(deviceB)) calls.B++;
        else throw new Error('unexpected device in recover stage');
        return 'ok';
      }
    });

    if (calls.A !== 0 || calls.B !== 1 ||
        result.pending !== 1 || result.sentAlerts !== 1 ||
        result.sentDevices !== 1 || result.failedDevices !== 0) {
      throw new Error('stage2 mismatch ' + JSON.stringify({ calls, result }));
    }

    const q = await pool.query(
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
    const r = q.rows[0];

    if (Number(r.push_attempt_count) !== 2 ||
        !r.push_sent_at || r.push_last_error !== null ||
        Number(r.a_attempts) !== 1 || !r.a_sent ||
        Number(r.b_attempts) !== 2 || !r.b_sent || r.b_error !== null) {
      throw new Error('stage2 persistence mismatch ' + JSON.stringify(r));
    }

    console.log('PARTIAL_503_RESTART_STAGE2=OK A_CALLS=0 B_CALLS=1 A_ATTEMPTS=1 B_ATTEMPTS=2');
    await pool.end();
    return;
  }

  if (stage === 'verify') {
    let calls = 0;
    const result = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async () => {
        calls++;
        return 'ok';
      }
    });

    if (calls !== 0 || result.pending !== 0 ||
        result.sentAlerts !== 0 || result.sentDevices !== 0) {
      throw new Error('stage3 replay mismatch ' + JSON.stringify({ calls, result }));
    }

    console.log('PARTIAL_503_RESTART_STAGE3=OK CALLS=0 PENDING=0');
    await pool.end();
    return;
  }

  throw new Error('unknown stage');
}

async function parentRun() {
  await ensureDroppingSchema();

  const stamp = Date.now().toString();
  const prefix = 'TEST_PARTIAL_503_RESTART_' + stamp + '_';
  const tokenA = 'TEST_PARTIAL_503_RESTART_A_' + stamp;
  const tokenB = 'TEST_PARTIAL_503_RESTART_B_' + stamp;
  let aId = null;
  let bId = null;
  let alert = null;

  try {
    const b = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [tokenB, 'partial-503-b-' + stamp]
    );
    bId = Number(b.rows[0].id);

    await new Promise(resolve => setTimeout(resolve, 5));

    const a = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [tokenA, 'partial-503-a-' + stamp]
    );
    aId = Number(a.rows[0].id);

    const q = await pool.query(
      "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME','Partial 503 Restart','1','new',1.90,TRUE) RETURNING id",
      [prefix + 'ALERT|OUTCOME', prefix + 'ALERT']
    );
    alert = Number(q.rows[0].id);

    const order = await pool.query(
      "SELECT id FROM dropping_push_devices WHERE id=ANY($1::bigint[]) AND enabled=TRUE ORDER BY updated_at DESC",
      [[aId, bId]]
    );
    if (order.rows.length !== 2 ||
        Number(order.rows[0].id) !== aId ||
        Number(order.rows[1].id) !== bId) {
      throw new Error('device order is not A then B');
    }

    const baseEnv = {
      ...process.env,
      AD69_ALERT_ID: String(alert),
      AD69_DEVICE_A: String(aId),
      AD69_DEVICE_B: String(bId)
    };

    for (const childStage of ['fail', 'recover', 'verify']) {
      const out = execFileSync(process.execPath, [__filename], {
        env: { ...baseEnv, AD69_STAGE: childStage },
        encoding: 'utf8'
      });
      process.stdout.write(out);
    }

    console.log('PARTIAL_503_RESTART=OK PROCESSES=3 A_TOTAL_CALLS=1 B_TOTAL_CALLS=2 DUPLICATES=0');
  } finally {
    if (alert) await pool.query('DELETE FROM dropping_alerts WHERE id=$1', [alert]);
    await pool.query(
      'DELETE FROM dropping_push_devices WHERE token=ANY($1::text[])',
      [[tokenA, tokenB]]
    );

    const c = await pool.query(
      "SELECT (SELECT count(*)::int FROM dropping_alerts WHERE item_key LIKE $1) alerts,(SELECT count(*)::int FROM dropping_push_devices WHERE token=ANY($2::text[])) devices,(SELECT count(*)::int FROM dropping_alerts WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending",
      [prefix + '%', [tokenA, tokenB]]
    );

    if (Number(c.rows[0].alerts) !== 0 || Number(c.rows[0].devices) !== 0) {
      throw new Error('synthetic cleanup failed');
    }

    console.log('PARTIAL_503_RESTART_CLEANUP=OK PENDING=' + c.rows[0].pending);
    await pool.end();
  }
}

(stage ? childRun() : parentRun()).catch(async e => {
  console.error('PARTIAL_503_RESTART_ERROR=' + (e.message || e));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
