const fs = require('fs');
const { spawn } = require('child_process');
const { pool } = require('./db');
const { ensureDroppingSchema } = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

const stage = process.env.AD76_STAGE || '';
const stamp = process.env.AD76_STAMP || '';
const token = 'TEST_PARALLEL_WORKERS_DEVICE_' + stamp;
const prefix = 'TEST_PARALLEL_WORKERS_ALERT_' + stamp + '_';
const sendLog = '/tmp/adim76_' + stamp + '_sends.log';
const readyPrefix = '/tmp/adim76_' + stamp + '_ready_';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForTwoReady() {
  for (let i = 0; i < 300; i++) {
    const count = fs.readdirSync('/tmp')
      .filter(name => name.startsWith('adim76_' + stamp + '_ready_'))
      .length;
    if (count >= 2) return;
    await sleep(10);
  }
  throw new Error('worker barrier timeout');
}

async function childRun() {
  await ensureDroppingSchema();

  const readyFile = readyPrefix + process.pid;
  fs.writeFileSync(readyFile, 'ready\n');
  await waitForTwoReady();

  const result = await flushDroppingPushes({
    limit: 25,
    accountOverride: { projectId: 'test-project' },
    accessTokenOverride: 'test-access',
    sendImpl: async (account, accessToken, alert, device) => {
      if (!String(alert.item_key || '').startsWith(prefix)) {
        throw new Error('unexpected alert ' + String(alert.item_key));
      }
      if (device.token !== token) {
        throw new Error('unexpected device token');
      }

      fs.appendFileSync(
        sendLog,
        String(process.pid) + '|' + String(alert.id) + '|' + String(device.id) + '\n'
      );

      await sleep(450);
      return 'ok';
    }
  });

  console.log(
    'PARALLEL_WORKER_CHILD=OK PID=' + process.pid +
    ' PENDING=' + String(result.pending ?? 0) +
    ' SENT_ALERTS=' + result.sentAlerts +
    ' SENT_DEVICES=' + result.sentDevices
  );

  await pool.end();
}

function spawnChild(envBase) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename], {
      env: { ...envBase, AD76_STAGE: 'child' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(
          'child exit=' + code +
          ' stdout=' + stdout.slice(-600) +
          ' stderr=' + stderr.slice(-600)
        ));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function parentRun() {
  await ensureDroppingSchema();

  const alertIds = [];
  let deviceId = null;

  try {
    for (const name of fs.readdirSync('/tmp')) {
      if (name.startsWith('adim76_' + stamp + '_ready_')) {
        try { fs.unlinkSync('/tmp/' + name); } catch {}
      }
    }
    try { fs.unlinkSync(sendLog); } catch {}

    const d = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'parallel-workers-' + stamp]
    );
    deviceId = Number(d.rows[0].id);

    for (let i = 1; i <= 6; i++) {
      const itemKey = prefix + i + '|OUTCOME';
      const a = await pool.query(
        "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME',$3,'1','new',$4,TRUE) RETURNING id",
        [itemKey, prefix + i, 'Parallel Worker Alert ' + i, 2 - i / 100]
      );
      alertIds.push(Number(a.rows[0].id));
    }

    const envBase = {
      ...process.env,
      AD76_STAMP: stamp
    };

    const children = await Promise.all([
      spawnChild(envBase),
      spawnChild(envBase)
    ]);

    for (const child of children) {
      process.stdout.write(child.stdout);
      process.stderr.write(child.stderr);
    }

    const lines = fs.existsSync(sendLog)
      ? fs.readFileSync(sendLog, 'utf8').split('\n').filter(Boolean)
      : [];

    const parsed = lines.map(line => {
      const [pid, alertId, dId] = line.split('|');
      return {
        pid,
        alertId: Number(alertId),
        deviceId: Number(dId)
      };
    });

    const uniqueAlertIds = new Set(parsed.map(row => row.alertId));
    const workerPids = new Set(parsed.map(row => row.pid));
    const perWorker = new Map();

    for (const row of parsed) {
      perWorker.set(row.pid, (perWorker.get(row.pid) || 0) + 1);
    }

    if (parsed.length !== 6) {
      throw new Error('send call count=' + parsed.length + ' rows=' + JSON.stringify(parsed));
    }

    if (uniqueAlertIds.size !== 6) {
      throw new Error('duplicate/missing alert sends ' + JSON.stringify(parsed));
    }

    if (workerPids.size !== 2) {
      throw new Error(
        'parallelism lost worker_count=' + workerPids.size +
        ' distribution=' + JSON.stringify(Object.fromEntries(perWorker))
      );
    }

    if ([...perWorker.values()].some(count => count < 1)) {
      throw new Error('one worker did no useful work');
    }

    const db = await pool.query(
      `SELECT
         count(*)::int AS alerts,
         count(*) FILTER (WHERE push_sent_at IS NOT NULL)::int AS sent_alerts,
         count(*) FILTER (WHERE push_attempt_count=1)::int AS one_attempt,
         (SELECT count(*)::int
            FROM dropping_push_deliveries
           WHERE alert_id = ANY($1::bigint[])
             AND attempt_count=1
             AND sent_at IS NOT NULL
             AND last_error IS NULL) AS deliveries
       FROM dropping_alerts
       WHERE id = ANY($1::bigint[])`,
      [alertIds]
    );

    const r = db.rows[0];

    if (Number(r.alerts) !== 6 ||
        Number(r.sent_alerts) !== 6 ||
        Number(r.one_attempt) !== 6 ||
        Number(r.deliveries) !== 6) {
      throw new Error('DB persistence mismatch ' + JSON.stringify(r));
    }

    let replayCalls = 0;
    const verify = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async () => {
        replayCalls++;
        return 'ok';
      }
    });

    if (verify.pending !== 0 ||
        verify.sentAlerts !== 0 ||
        verify.sentDevices !== 0 ||
        replayCalls !== 0) {
      throw new Error('completed alerts replayed');
    }

    console.log(
      'PARALLEL_WORKER_DISTRIBUTION=OK WORKERS=2 ALERTS=6 ' +
      'SEND_CALLS=6 UNIQUE_ALERTS=6 DELIVERIES=6 ' +
      'DISTRIBUTION=' + JSON.stringify(Object.fromEntries(perWorker)) +
      ' VERIFY_SENDS=0 DUPLICATES=0'
    );
  } finally {
    if (alertIds.length) {
      await pool.query(
        'DELETE FROM dropping_alerts WHERE id = ANY($1::bigint[])',
        [alertIds]
      );
    }

    if (deviceId) {
      await pool.query('DELETE FROM dropping_push_devices WHERE id=$1', [deviceId]);
    } else {
      await pool.query('DELETE FROM dropping_push_devices WHERE token=$1', [token]);
    }

    for (const name of fs.readdirSync('/tmp')) {
      if (name.startsWith('adim76_' + stamp + '_ready_')) {
        try { fs.unlinkSync('/tmp/' + name); } catch {}
      }
    }
    try { fs.unlinkSync(sendLog); } catch {}

    const cleanup = await pool.query(
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
      'PARALLEL_WORKER_CLEANUP=' +
      (
        Number(cleanup.rows[0].alerts) === 0 &&
        Number(cleanup.rows[0].devices) === 0
          ? 'OK'
          : 'FAIL'
      ) +
      ' PENDING=' + cleanup.rows[0].pending +
      ' ADVISORY_LOCKS=' + cleanup.rows[0].advisory_locks
    );

    await pool.end();
  }
}

(stage === 'child' ? childRun() : parentRun()).catch(async error => {
  console.error('PARALLEL_WORKER_ERROR=' + (error.message || error));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
