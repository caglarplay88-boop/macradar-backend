const fs = require('fs');
const { spawn } = require('child_process');
const { pool } = require('./db');
const {
  ensureDroppingSchema,
  primeDroppingRows,
  recordDroppingAlert
} = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

const stage = process.env.AD74_STAGE || '';
const stamp = process.env.AD74_STAMP || '';
const matchId = 'TEST_MULTI_WORKER_MATCH_' + stamp;
const outcomeId = 'OUTCOME_1';
const itemKey = matchId + '|' + outcomeId;
const token = 'TEST_MULTI_WORKER_DEVICE_' + stamp;
const readyPrefix = '/tmp/adim74_' + stamp + '_ready_';
const sendLog = '/tmp/adim74_' + stamp + '_sends.log';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeRows() {
  const baseline = {
    matchId,
    outcomeId,
    match: 'Multi Worker Race Test',
    selection: '1',
    league: 'TEST',
    date: '2026-09-25',
    time: '22:00',
    oldOdd: 2.20,
    currentOdd: 2.10,
    dropPct: 4.55,
    bookiesPct: 30,
    bookiesDown: 3,
    bookiesTotal: 10
  };

  const changed = {
    ...baseline,
    oldOdd: 2.10,
    currentOdd: 2.00,
    dropPct: 4.76
  };

  return { baseline, changed };
}

async function waitForTwoReady() {
  for (let i = 0; i < 200; i++) {
    const files = fs.readdirSync('/tmp').filter(name =>
      name.startsWith('adim74_' + stamp + '_ready_')
    );
    if (files.length >= 2) return;
    await sleep(10);
  }
  throw new Error('worker barrier timeout');
}

async function childRun() {
  await ensureDroppingSchema();
  const { baseline, changed } = makeRows();

  await recordDroppingAlert(
    {
      type: 'changed',
      before: baseline,
      after: changed
    },
    { pushEligible: true }
  );

  const readyFile = readyPrefix + process.pid;
  fs.writeFileSync(readyFile, 'ready\n');

  await waitForTwoReady();

  const result = await flushDroppingPushes({
    limit: 25,
    accountOverride: { projectId: 'test-project' },
    accessTokenOverride: 'test-access',
    sendImpl: async (account, accessToken, alert, device) => {
      if (alert.item_key !== itemKey) {
        throw new Error('unexpected alert ' + alert.item_key);
      }
      if (device.token !== token) {
        throw new Error('unexpected device token');
      }

      fs.appendFileSync(
        sendLog,
        String(process.pid) + '|' + String(alert.id) + '|' + String(device.id) + '\n'
      );

      // Keep the external-send window open so a second process can reach
      // the same delivery before this one persists success.
      await sleep(800);
      return 'ok';
    }
  });

  console.log(
    'MULTI_WORKER_CHILD=OK PID=' + process.pid +
    ' PENDING=' + String(result.pending ?? 0) +
    ' SENT_ALERTS=' + result.sentAlerts +
    ' SENT_DEVICES=' + result.sentDevices
  );

  await pool.end();
}

function spawnChild(envBase) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename], {
      env: { ...envBase, AD74_STAGE: 'child' },
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
          ' stdout=' + stdout.slice(-500) +
          ' stderr=' + stderr.slice(-500)
        ));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function parentRun() {
  await ensureDroppingSchema();
  const { baseline } = makeRows();

  let deviceId = null;
  let alertIds = [];

  try {
    for (const name of fs.readdirSync('/tmp')) {
      if (name.startsWith('adim74_' + stamp + '_ready_')) {
        try { fs.unlinkSync('/tmp/' + name); } catch {}
      }
    }
    try { fs.unlinkSync(sendLog); } catch {}

    await primeDroppingRows([baseline]);

    const device = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'multi-worker-' + stamp]
    );
    deviceId = Number(device.rows[0].id);

    const envBase = {
      ...process.env,
      AD74_STAMP: stamp
    };

    const children = await Promise.all([
      spawnChild(envBase),
      spawnChild(envBase)
    ]);

    for (const child of children) {
      process.stdout.write(child.stdout);
      process.stderr.write(child.stderr);
    }

    const alerts = await pool.query(
      `SELECT id,current_odd,push_sent_at,push_attempt_count
       FROM dropping_alerts
       WHERE item_key=$1
       ORDER BY id`,
      [itemKey]
    );

    alertIds = alerts.rows.map(row => Number(row.id));

    const lines = fs.existsSync(sendLog)
      ? fs.readFileSync(sendLog, 'utf8')
          .split('\n')
          .filter(Boolean)
      : [];

    const delivery = alertIds.length
      ? await pool.query(
          `SELECT alert_id,device_id,attempt_count,sent_at,last_error
           FROM dropping_push_deliveries
           WHERE alert_id = ANY($1::bigint[])`,
          [alertIds]
        )
      : { rows: [] };

    if (alerts.rows.length !== 1) {
      throw new Error('DB alert count=' + alerts.rows.length);
    }

    if (lines.length !== 1) {
      throw new Error(
        'MULTI_WORKER_DUPLICATE_SEND send_calls=' + lines.length +
        ' lines=' + JSON.stringify(lines)
      );
    }

    if (delivery.rows.length !== 1 ||
        Number(delivery.rows[0].attempt_count) !== 1 ||
        !delivery.rows[0].sent_at ||
        delivery.rows[0].last_error !== null) {
      throw new Error(
        'delivery persistence mismatch ' +
        JSON.stringify(delivery.rows)
      );
    }

    if (!alerts.rows[0].push_sent_at ||
        Number(alerts.rows[0].push_attempt_count) !== 1) {
      throw new Error(
        'alert persistence mismatch ' +
        JSON.stringify(alerts.rows[0])
      );
    }

    console.log(
      'MULTI_WORKER_RACE=OK WORKERS=2 DB_ALERTS=1 SEND_CALLS=1 ' +
      'DELIVERIES=1 ALERT_ATTEMPTS=1 DUPLICATES=0'
    );
  } finally {
    if (alertIds.length) {
      await pool.query(
        'DELETE FROM dropping_alerts WHERE id = ANY($1::bigint[])',
        [alertIds]
      );
    } else {
      await pool.query(
        'DELETE FROM dropping_alerts WHERE item_key=$1',
        [itemKey]
      );
    }

    if (deviceId) {
      await pool.query(
        'DELETE FROM dropping_push_devices WHERE id=$1',
        [deviceId]
      );
    } else {
      await pool.query(
        'DELETE FROM dropping_push_devices WHERE token=$1',
        [token]
      );
    }

    await pool.query(
      'DELETE FROM dropping_state WHERE item_key=$1',
      [itemKey]
    );

    for (const name of fs.readdirSync('/tmp')) {
      if (name.startsWith('adim74_' + stamp + '_ready_')) {
        try { fs.unlinkSync('/tmp/' + name); } catch {}
      }
    }
    try { fs.unlinkSync(sendLog); } catch {}

    const cleanup = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM dropping_alerts WHERE item_key=$1) alerts,
         (SELECT count(*)::int FROM dropping_state WHERE item_key=$1) states,
         (SELECT count(*)::int FROM dropping_push_devices WHERE token=$2) devices,
         (SELECT count(*)::int FROM dropping_alerts
           WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending`,
      [itemKey, token]
    );

    console.log(
      'MULTI_WORKER_RACE_CLEANUP=' +
      (
        Number(cleanup.rows[0].alerts) === 0 &&
        Number(cleanup.rows[0].states) === 0 &&
        Number(cleanup.rows[0].devices) === 0
          ? 'OK'
          : 'FAIL'
      ) +
      ' PENDING=' + cleanup.rows[0].pending
    );

    await pool.end();
  }
}

(stage === 'child' ? childRun() : parentRun()).catch(async error => {
  console.error('MULTI_WORKER_RACE_ERROR=' + (error.message || error));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
