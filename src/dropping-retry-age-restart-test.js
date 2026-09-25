const { spawnSync } = require('child_process');
const { pool } = require('./db');
const { ensureDroppingSchema } = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

const stage = process.env.AD80_STAGE || '';
const retryIds = String(process.env.AD80_RETRY_IDS || '')
  .split(',').filter(Boolean).map(Number);
const freshIds = String(process.env.AD80_FRESH_IDS || '')
  .split(',').filter(Boolean).map(Number);
const deviceId = Number(process.env.AD80_DEVICE_ID || 0);

function idSet(ids) {
  return new Set(ids.map(Number));
}

async function childRun() {
  await ensureDroppingSchema();

  const retries = idSet(retryIds);
  const fresh = idSet(freshIds);

  if (stage === 'seed-fail') {
    let retryCalls = 0;
    const result = await flushDroppingPushes({
      limit: 10,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert, device) => {
        if (String(device.id) !== String(deviceId)) {
          throw new Error('unexpected device in seed');
        }
        if (!retries.has(Number(alert.id))) {
          throw new Error('unexpected alert in seed ' + alert.id);
        }
        retryCalls++;
        throw new Error('synthetic 503 restart age');
      }
    });

    if (result.pending !== 10 ||
        result.sentAlerts !== 0 ||
        result.failedDevices !== 10 ||
        retryCalls !== 10) {
      throw new Error('seed flush mismatch ' + JSON.stringify({ result, retryCalls }));
    }

    const q = await pool.query(
      `SELECT
         count(*) FILTER (WHERE push_attempt_count=1)::int AS attempted,
         count(*) FILTER (WHERE push_last_attempt_at IS NOT NULL)::int AS stamped,
         count(*) FILTER (WHERE push_sent_at IS NULL)::int AS pending
       FROM dropping_alerts
       WHERE id=ANY($1::bigint[])`,
      [retryIds]
    );

    const r = q.rows[0];
    if (Number(r.attempted) !== 10 ||
        Number(r.stamped) !== 10 ||
        Number(r.pending) !== 10) {
      throw new Error('seed persistence mismatch ' + JSON.stringify(r));
    }

    console.log('AGE_RESTART_STAGE1=OK RETRIES=10 ATTEMPTED=10');
    await pool.end();
    return;
  }

  if (stage === 'recover-five') {
    const order = [];
    const result = await flushDroppingPushes({
      limit: 5,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert, device) => {
        if (String(device.id) !== String(deviceId)) {
          throw new Error('unexpected device in recover-five');
        }
        order.push(Number(alert.id));
        return 'ok';
      }
    });

    if (result.pending !== 5 ||
        result.sentAlerts !== 5 ||
        result.sentDevices !== 5 ||
        order.length !== 5 ||
        order.some(id => !retries.has(id)) ||
        order.some(id => fresh.has(id))) {
      throw new Error('recover-five ordering mismatch ' + JSON.stringify({ result, order }));
    }

    console.log('AGE_RESTART_STAGE2=OK SENT=5 ONLY_OLD_RETRY=true');
    await pool.end();
    return;
  }

  if (stage === 'recover-rest') {
    const order = [];
    const result = await flushDroppingPushes({
      limit: 10,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert, device) => {
        if (String(device.id) !== String(deviceId)) {
          throw new Error('unexpected device in recover-rest');
        }
        order.push(Number(alert.id));
        return 'ok';
      }
    });

    if (result.pending !== 10 ||
        result.sentAlerts !== 10 ||
        result.sentDevices !== 10 ||
        order.length !== 10) {
      throw new Error('recover-rest flush mismatch ' + JSON.stringify({ result, order }));
    }

    const firstFive = order.slice(0, 5);
    const lastFive = order.slice(5);

    if (firstFive.some(id => !retries.has(id)) ||
        lastFive.some(id => !fresh.has(id))) {
      throw new Error('recover-rest ordering mismatch ' + JSON.stringify(order));
    }

    console.log('AGE_RESTART_STAGE3=OK OLD_RETRY_FIRST=5 FRESH_AFTER=5');
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

    if (result.pending !== 0 ||
        result.sentAlerts !== 0 ||
        result.sentDevices !== 0 ||
        calls !== 0) {
      throw new Error('verify replay mismatch ' + JSON.stringify({ result, calls }));
    }

    console.log('AGE_RESTART_STAGE4=OK PENDING=0 SENDS=0');
    await pool.end();
    return;
  }

  throw new Error('unknown stage');
}

function runChild(stageName, envBase) {
  const out = spawnSync(process.execPath, [__filename], {
    env: { ...envBase, AD80_STAGE: stageName },
    encoding: 'utf8'
  });

  if (out.status !== 0) {
    throw new Error(
      stageName + ' failed status=' + out.status +
      ' stdout=' + String(out.stdout || '').slice(-700) +
      ' stderr=' + String(out.stderr || '').slice(-700)
    );
  }

  process.stdout.write(out.stdout || '');
  process.stderr.write(out.stderr || '');
}

async function parentRun() {
  await ensureDroppingSchema();

  const baseline = await pool.query(
    "SELECT count(*)::int AS n FROM dropping_alerts WHERE push_eligible=TRUE AND push_sent_at IS NULL"
  );
  if (Number(baseline.rows[0].n) !== 0) {
    throw new Error('baseline pending queue not empty: ' + baseline.rows[0].n);
  }

  const stamp = Date.now().toString();
  const prefix = 'TEST_AGE_RESTART_' + stamp + '_';
  const token = 'TEST_AGE_RESTART_DEVICE_' + stamp;
  const retries = [];
  const fresh = [];
  let dId = null;

  try {
    const d = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'age-restart-' + stamp]
    );
    dId = Number(d.rows[0].id);

    for (let i = 1; i <= 10; i++) {
      const q = await pool.query(
        "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME',$3,'1','new',$4,TRUE) RETURNING id",
        [
          prefix + 'RETRY_' + i + '|OUTCOME',
          prefix + 'RETRY_' + i,
          'Age Restart Retry ' + i,
          2.30 - i / 1000
        ]
      );
      retries.push(Number(q.rows[0].id));
    }

    const envBase1 = {
      ...process.env,
      AD80_RETRY_IDS: retries.join(','),
      AD80_DEVICE_ID: String(dId)
    };
    runChild('seed-fail', envBase1);

    await new Promise(resolve => setTimeout(resolve, 80));

    for (let i = 1; i <= 5; i++) {
      const q = await pool.query(
        "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME',$3,'1','new',$4,TRUE) RETURNING id",
        [
          prefix + 'FRESH_' + i + '|OUTCOME',
          prefix + 'FRESH_' + i,
          'Age Restart Fresh ' + i,
          1.90 - i / 1000
        ]
      );
      fresh.push(Number(q.rows[0].id));
    }

    const timing = await pool.query(
      `SELECT
         max(push_last_attempt_at) FILTER (WHERE id=ANY($1::bigint[])) AS retry_max,
         min(created_at) FILTER (WHERE id=ANY($2::bigint[])) AS fresh_min
       FROM dropping_alerts
       WHERE id=ANY($3::bigint[])`,
      [retries, fresh, [...retries, ...fresh]]
    );

    if (!timing.rows[0].retry_max ||
        !timing.rows[0].fresh_min ||
        new Date(timing.rows[0].retry_max).getTime() >=
          new Date(timing.rows[0].fresh_min).getTime()) {
      throw new Error('test timestamp separation failed ' + JSON.stringify(timing.rows[0]));
    }

    const envBase = {
      ...process.env,
      AD80_RETRY_IDS: retries.join(','),
      AD80_FRESH_IDS: fresh.join(','),
      AD80_DEVICE_ID: String(dId)
    };

    runChild('recover-five', envBase);
    runChild('recover-rest', envBase);
    runChild('verify', envBase);

    const final = await pool.query(
      `SELECT
         count(*) FILTER (WHERE id=ANY($1::bigint[]) AND push_attempt_count=2 AND push_sent_at IS NOT NULL)::int AS retries_done,
         count(*) FILTER (WHERE id=ANY($2::bigint[]) AND push_attempt_count=1 AND push_sent_at IS NOT NULL)::int AS fresh_done,
         (SELECT count(*)::int FROM dropping_push_deliveries
          WHERE alert_id=ANY($3::bigint[]) AND sent_at IS NOT NULL) AS deliveries
       FROM dropping_alerts
       WHERE id=ANY($3::bigint[])`,
      [retries, fresh, [...retries, ...fresh]]
    );

    const r = final.rows[0];
    if (Number(r.retries_done) !== 10 ||
        Number(r.fresh_done) !== 5 ||
        Number(r.deliveries) !== 15) {
      throw new Error('final persistence mismatch ' + JSON.stringify(r));
    }

    console.log(
      'AGE_RESTART_PERSISTENCE=OK PROCESSES=4 OLD_RETRIES=10 FRESH=5 ' +
      'RESTART_ORDER_PRESERVED=true DELIVERIES=15 DUPLICATES=0'
    );
  } finally {
    const all = [...retries, ...fresh];
    if (all.length) {
      await pool.query(
        'DELETE FROM dropping_alerts WHERE id=ANY($1::bigint[])',
        [all]
      );
    }

    if (dId) {
      await pool.query('DELETE FROM dropping_push_devices WHERE id=$1', [dId]);
    } else {
      await pool.query('DELETE FROM dropping_push_devices WHERE token=$1', [token]);
    }

    const c = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM dropping_alerts WHERE item_key LIKE $1) alerts,
         (SELECT count(*)::int FROM dropping_push_devices WHERE token=$2) devices,
         (SELECT count(*)::int FROM dropping_alerts WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending,
         (SELECT count(*)::int FROM pg_locks WHERE locktype='advisory' AND granted) advisory_locks`,
      [prefix + '%', token]
    );

    console.log(
      'AGE_RESTART_CLEANUP=' +
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
}

(stage ? childRun() : parentRun()).catch(async error => {
  console.error('AGE_RESTART_ERROR=' + (error.message || error));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
