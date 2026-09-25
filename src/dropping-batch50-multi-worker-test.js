const fs = require('fs');
const { spawn } = require('child_process');
const { pool } = require('./db');
const { ensureDroppingSchema } = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

const stage = process.env.AD77_STAGE || '';
const stamp = process.env.AD77_STAMP || '';
const token = 'TEST_BATCH50_DEVICE_' + stamp;
const prefix = 'TEST_BATCH50_ALERT_' + stamp + '_';
const sendLog = '/tmp/adim77_' + stamp + '_sends.log';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function barrierFile(kind, round, pid) {
  return '/tmp/adim77_' + stamp + '_' + kind + '_r' + round + '_' + pid;
}

function barrierPrefix(kind, round) {
  return 'adim77_' + stamp + '_' + kind + '_r' + round + '_';
}

async function waitForBarrier(kind, round, count = 2) {
  const prefixName = barrierPrefix(kind, round);
  for (let i = 0; i < 400; i++) {
    const current = fs.readdirSync('/tmp')
      .filter(name => name.startsWith(prefixName))
      .length;
    if (current >= count) return;
    await sleep(10);
  }
  throw new Error(kind + ' barrier timeout round=' + round);
}

async function childRun() {
  await ensureDroppingSchema();

  for (let round = 1; round <= 2; round++) {
    fs.writeFileSync(barrierFile('ready', round, process.pid), 'ready\n');
    await waitForBarrier('ready', round);

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
          [
            round,
            process.pid,
            alert.id,
            device.id
          ].join('|') + '\n'
        );

        await sleep(120);
        return 'ok';
      }
    });

    fs.writeFileSync(
      barrierFile('done', round, process.pid),
      JSON.stringify({
        pending: result.pending,
        sentAlerts: result.sentAlerts,
        sentDevices: result.sentDevices,
        failedDevices: result.failedDevices
      }) + '\n'
    );

    await waitForBarrier('done', round);

    console.log(
      'BATCH50_CHILD_ROUND=OK PID=' + process.pid +
      ' ROUND=' + round +
      ' FETCHED=' + String(result.pending ?? 0) +
      ' SENT_ALERTS=' + result.sentAlerts +
      ' SENT_DEVICES=' + result.sentDevices
    );
  }

  await pool.end();
}

function spawnChild(envBase) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename], {
      env: { ...envBase, AD77_STAGE: 'child' },
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
          ' stdout=' + stdout.slice(-800) +
          ' stderr=' + stderr.slice(-800)
        ));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function cleanupTmp() {
  for (const name of fs.readdirSync('/tmp')) {
    if (name.startsWith('adim77_' + stamp + '_')) {
      try { fs.unlinkSync('/tmp/' + name); } catch {}
    }
  }
}

async function parentRun() {
  await ensureDroppingSchema();

  const alertIds = [];
  let deviceId = null;

  try {
    cleanupTmp();

    const d = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'batch50-' + stamp]
    );
    deviceId = Number(d.rows[0].id);

    for (let i = 1; i <= 50; i++) {
      const itemKey = prefix + String(i).padStart(2, '0') + '|OUTCOME';
      const a = await pool.query(
        "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME',$3,'1','new',$4,TRUE) RETURNING id",
        [
          itemKey,
          prefix + String(i).padStart(2, '0'),
          'Batch 50 Alert ' + i,
          2.50 - i / 1000
        ]
      );
      alertIds.push(Number(a.rows[0].id));
    }

    const envBase = {
      ...process.env,
      AD77_STAMP: stamp
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
      const [round, pid, alertId, dId] = line.split('|');
      return {
        round: Number(round),
        pid,
        alertId: Number(alertId),
        deviceId: Number(dId)
      };
    });

    const uniqueAlerts = new Set(parsed.map(row => row.alertId));
    const allWorkers = new Set(parsed.map(row => row.pid));
    const round1 = parsed.filter(row => row.round === 1);
    const round2 = parsed.filter(row => row.round === 2);
    const round1Alerts = new Set(round1.map(row => row.alertId));
    const round2Alerts = new Set(round2.map(row => row.alertId));

    if (parsed.length !== 50) {
      throw new Error('total send calls=' + parsed.length);
    }
    if (uniqueAlerts.size !== 50) {
      throw new Error('unique alert sends=' + uniqueAlerts.size);
    }
    if (allWorkers.size !== 2) {
      throw new Error('worker count=' + allWorkers.size);
    }
    if (round1.length !== 25 || round1Alerts.size !== 25) {
      throw new Error(
        'round1 mismatch sends=' + round1.length +
        ' unique=' + round1Alerts.size
      );
    }
    if (round2.length !== 25 || round2Alerts.size !== 25) {
      throw new Error(
        'round2 mismatch sends=' + round2.length +
        ' unique=' + round2Alerts.size
      );
    }

    const overlap = [...round1Alerts]
      .filter(id => round2Alerts.has(id));

    if (overlap.length !== 0) {
      throw new Error('round overlap=' + JSON.stringify(overlap));
    }

    const db = await pool.query(
      `SELECT
         count(*)::int AS alerts,
         count(*) FILTER (WHERE push_sent_at IS NOT NULL)::int AS sent_alerts,
         count(*) FILTER (WHERE push_attempt_count=1)::int AS one_attempt,
         count(*) FILTER (WHERE push_attempt_count>1)::int AS over_attempt,
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

    if (Number(r.alerts) !== 50 ||
        Number(r.sent_alerts) !== 50 ||
        Number(r.one_attempt) !== 50 ||
        Number(r.over_attempt) !== 0 ||
        Number(r.deliveries) !== 50) {
      throw new Error('DB persistence mismatch ' + JSON.stringify(r));
    }

    const pending = await pool.query(
      `SELECT count(*)::int AS n
       FROM dropping_alerts
       WHERE id = ANY($1::bigint[])
         AND push_eligible=TRUE
         AND push_sent_at IS NULL`,
      [alertIds]
    );

    if (Number(pending.rows[0].n) !== 0) {
      throw new Error('starved pending alerts=' + pending.rows[0].n);
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
      throw new Error('verify replayed completed queue');
    }

    console.log(
      'BATCH50_MULTI_WORKER=OK WORKERS=2 LIMIT=25 ' +
      'ROUND1_SENDS=25 ROUND2_SENDS=25 TOTAL_SENDS=50 ' +
      'UNIQUE_ALERTS=50 DELIVERIES=50 ATTEMPT_GT1=0 ' +
      'STARVED=0 VERIFY_SENDS=0 DUPLICATES=0'
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

    cleanupTmp();

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
      'BATCH50_CLEANUP=' +
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
  console.error('BATCH50_ERROR=' + (error.message || error));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
