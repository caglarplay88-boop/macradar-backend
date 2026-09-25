const fs = require('fs');
const { spawn } = require('child_process');
const { pool } = require('./db');
const {
  ensureDroppingSchema,
  tryAcquireDroppingPushAlertLock
} = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

const stage = process.env.AD75_STAGE || '';
const alertId = Number(process.env.AD75_ALERT_ID || 0);
const readyFile = process.env.AD75_READY_FILE || '';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function childRun() {
  await ensureDroppingSchema();

  const lock = await tryAcquireDroppingPushAlertLock(alertId);
  if (!lock) throw new Error('child could not acquire alert lock');

  fs.writeFileSync(readyFile, String(process.pid));

  // Intentionally never release the lock. Parent will SIGKILL this process.
  await new Promise(() => {});
}

function spawnLockHolder(envBase) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename], {
      env: { ...envBase, AD75_STAGE: 'child' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);

    resolve({
      child,
      getOutput: () => ({ stdout, stderr })
    });
  });
}

async function waitForFile(file) {
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(file)) return;
    await sleep(10);
  }
  throw new Error('ready file timeout');
}

async function advisoryLockCount() {
  const q = await pool.query(
    "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND granted"
  );
  return Number(q.rows[0].n);
}

async function waitForLockCount(target, comparator) {
  for (let i = 0; i < 200; i++) {
    const n = await advisoryLockCount();
    if (comparator(n, target)) return n;
    await sleep(10);
  }
  return advisoryLockCount();
}

async function parentRun() {
  await ensureDroppingSchema();

  const stamp = Date.now().toString();
  const prefix = 'TEST_LOCK_CRASH_' + stamp + '_';
  const token = 'TEST_LOCK_CRASH_DEVICE_' + stamp;
  const ready = '/tmp/adim75_lock_ready_' + stamp;
  let deviceId = null;
  let currentAlertId = null;
  let holder = null;

  try {
    try { fs.unlinkSync(ready); } catch {}

    const d = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'lock-crash-' + stamp]
    );
    deviceId = Number(d.rows[0].id);

    const a = await pool.query(
      "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME','Lock Crash Recovery','1','new',1.87,TRUE) RETURNING id",
      [prefix + 'ALERT|OUTCOME', prefix + 'ALERT']
    );
    currentAlertId = Number(a.rows[0].id);

    const baselineLocks = await advisoryLockCount();

    holder = await spawnLockHolder({
      ...process.env,
      AD75_ALERT_ID: String(currentAlertId),
      AD75_READY_FILE: ready
    });

    await waitForFile(ready);

    const heldLocks = await waitForLockCount(
      baselineLocks + 1,
      (value, target) => value >= target
    );

    if (heldLocks < baselineLocks + 1) {
      throw new Error(
        'advisory lock was not visible baseline=' +
        baselineLocks + ' held=' + heldLocks
      );
    }

    const lockedAttempt = await tryAcquireDroppingPushAlertLock(currentAlertId);
    if (lockedAttempt !== null) {
      await lockedAttempt.release();
      throw new Error('second connection acquired lock while child held it');
    }

    holder.child.kill('SIGKILL');

    const exit = await new Promise(resolve => {
      holder.child.once('close', (code, signal) => resolve({ code, signal }));
    });

    if (exit.signal !== 'SIGKILL') {
      const out = holder.getOutput();
      throw new Error(
        'child did not die by SIGKILL ' +
        JSON.stringify(exit) +
        ' stderr=' + out.stderr.slice(-300)
      );
    }

    const afterKillLocks = await waitForLockCount(
      baselineLocks,
      (value, target) => value <= target
    );

    if (afterKillLocks !== baselineLocks) {
      throw new Error(
        'advisory lock leaked after SIGKILL baseline=' +
        baselineLocks + ' after=' + afterKillLocks
      );
    }

    const pending = await pool.query(
      'SELECT push_sent_at,push_attempt_count,push_eligible FROM dropping_alerts WHERE id=$1',
      [currentAlertId]
    );
    const p = pending.rows[0];

    if (p.push_eligible !== true ||
        p.push_sent_at !== null ||
        Number(p.push_attempt_count) !== 0) {
      throw new Error('pending alert changed while only lock was held ' + JSON.stringify(p));
    }

    let sends = 0;
    const recovered = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert, device) => {
        if (Number(alert.id) !== currentAlertId) {
          throw new Error('unexpected recovery alert');
        }
        if (String(device.id) !== String(deviceId)) {
          throw new Error('unexpected recovery device');
        }
        sends++;
        return 'ok';
      }
    });

    if (sends !== 1 ||
        recovered.pending !== 1 ||
        recovered.sentAlerts !== 1 ||
        recovered.sentDevices !== 1 ||
        recovered.failedDevices !== 0) {
      throw new Error('recovery flush mismatch ' + JSON.stringify({ sends, recovered }));
    }

    const after = await pool.query(
      `SELECT
         a.push_sent_at,
         a.push_attempt_count,
         a.push_last_error,
         d.attempt_count AS d_attempts,
         d.sent_at AS d_sent,
         d.last_error AS d_error
       FROM dropping_alerts a
       LEFT JOIN dropping_push_deliveries d
         ON d.alert_id=a.id AND d.device_id=$2
       WHERE a.id=$1`,
      [currentAlertId, deviceId]
    );
    const r = after.rows[0];

    if (!r.push_sent_at ||
        Number(r.push_attempt_count) !== 1 ||
        r.push_last_error !== null ||
        Number(r.d_attempts) !== 1 ||
        !r.d_sent ||
        r.d_error !== null) {
      throw new Error('recovery persistence mismatch ' + JSON.stringify(r));
    }

    let duplicateCalls = 0;
    const verify = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async () => {
        duplicateCalls++;
        return 'ok';
      }
    });

    if (verify.pending !== 0 ||
        verify.sentAlerts !== 0 ||
        verify.sentDevices !== 0 ||
        duplicateCalls !== 0) {
      throw new Error('completed alert replayed');
    }

    console.log(
      'LOCK_CRASH_RECOVERY=OK ' +
      'BASE_LOCKS=' + baselineLocks +
      ' HELD_LOCKS=' + heldLocks +
      ' AFTER_SIGKILL_LOCKS=' + afterKillLocks +
      ' SECOND_ACQUIRE_WHILE_HELD=false ' +
      'RECOVERY_SENDS=1 VERIFY_SENDS=0 DUPLICATES=0'
    );
  } finally {
    if (holder && holder.child && !holder.child.killed) {
      try { holder.child.kill('SIGKILL'); } catch {}
    }

    try { fs.unlinkSync(ready); } catch {}

    if (currentAlertId) {
      await pool.query('DELETE FROM dropping_alerts WHERE id=$1', [currentAlertId]);
    }

    if (deviceId) {
      await pool.query('DELETE FROM dropping_push_devices WHERE id=$1', [deviceId]);
    } else {
      await pool.query('DELETE FROM dropping_push_devices WHERE token=$1', [token]);
    }

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
      'LOCK_CRASH_CLEANUP=' +
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
  console.error('LOCK_CRASH_ERROR=' + (error.message || error));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
