const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pool } = require('./db');
const { ensureDroppingSchema } = require('./dropping-store');
const { flushDroppingPushes, buildMessage } = require('./dropping-push');

const stage = process.env.AD70_STAGE || '';
const alertId = Number(process.env.AD70_ALERT_ID || 0);
const deviceId = Number(process.env.AD70_DEVICE_ID || 0);

async function childRun() {
  await ensureDroppingSchema();

  if (stage === 'crash') {
    await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert, device) => {
        if (Number(alert.id) !== alertId || Number(device.id) !== deviceId) {
          process.exit(78);
        }

        // Simulate: external FCM accepted the message, then the process died
        // before markDroppingPushDeviceResult() could persist success.
        process.exit(77);
      }
    });

    process.exit(79);
  }

  if (stage === 'recover') {
    let sends = 0;
    const result = await flushDroppingPushes({
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (account, accessToken, alert, device) => {
        if (Number(alert.id) !== alertId || Number(device.id) !== deviceId) {
          throw new Error('unexpected recovery target');
        }
        sends++;
        return 'ok';
      }
    });

    if (sends !== 1 ||
        result.pending !== 1 ||
        result.sentAlerts !== 1 ||
        result.sentDevices !== 1 ||
        result.failedDevices !== 0) {
      throw new Error('recovery mismatch ' + JSON.stringify({ sends, result }));
    }

    console.log('POST_SEND_CRASH_RECOVERY=OK SENDS=1');
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

    if (sends !== 0 ||
        result.pending !== 0 ||
        result.sentAlerts !== 0 ||
        result.sentDevices !== 0) {
      throw new Error('verify replay mismatch ' + JSON.stringify({ sends, result }));
    }

    console.log('POST_SEND_CRASH_VERIFY=OK SENDS=0 PENDING=0');
    await pool.end();
    return;
  }

  throw new Error('unknown child stage');
}

async function parentRun() {
  await ensureDroppingSchema();

  const stamp = Date.now().toString();
  const prefix = 'TEST_POST_SEND_CRASH_' + stamp + '_';
  const token = 'TEST_POST_SEND_CRASH_DEVICE_' + stamp;
  let device = null;
  let alert = null;

  try {
    const d = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'post-send-crash-' + stamp]
    );
    device = Number(d.rows[0].id);

    const a = await pool.query(
      "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME','Post Send Crash','1','new',1.88,TRUE) RETURNING *",
      [prefix + 'ALERT|OUTCOME', prefix + 'ALERT']
    );
    alert = Number(a.rows[0].id);

    const message1 = buildMessage(a.rows[0], token);
    const message2 = buildMessage(a.rows[0], token);
    const expectedTag = 'dropping_alert_' + String(alert);

    if (message1.message.android.notification.tag !== expectedTag ||
        message2.message.android.notification.tag !== expectedTag ||
        message1.message.android.collapse_key !== expectedTag ||
        message2.message.android.collapse_key !== expectedTag) {
      throw new Error('stable Android dedupe identity mismatch');
    }

    const mobileSource = fs.readFileSync(
      path.join(__dirname, '..', 'mobile', 'lib', 'main.dart'),
      'utf8'
    );

    if (!mobileSource.includes('onlyAlertOnce: true')) {
      throw new Error('mobile onlyAlertOnce protection missing');
    }
    if (!mobileSource.includes("int.tryParse(data['alert_id'] ?? '')")) {
      throw new Error('mobile stable alert_id notification id missing');
    }

    const envBase = {
      ...process.env,
      AD70_ALERT_ID: String(alert),
      AD70_DEVICE_ID: String(device)
    };

    const crashed = spawnSync(process.execPath, [__filename], {
      env: { ...envBase, AD70_STAGE: 'crash' },
      encoding: 'utf8'
    });

    if (crashed.status !== 77) {
      throw new Error(
        'crash stage did not stop at post-send window status=' +
        String(crashed.status) +
        ' stderr=' + String(crashed.stderr || '').slice(0, 200)
      );
    }

    const afterCrash = await pool.query(
      `SELECT
         a.push_eligible,
         a.push_sent_at,
         a.push_attempt_count,
         (SELECT count(*)::int FROM dropping_push_deliveries WHERE alert_id=a.id) AS deliveries
       FROM dropping_alerts a
       WHERE a.id=$1`,
      [alert]
    );
    const c = afterCrash.rows[0];

    if (c.push_eligible !== true ||
        c.push_sent_at !== null ||
        Number(c.push_attempt_count) !== 0 ||
        Number(c.deliveries) !== 0) {
      throw new Error('post-crash DB state mismatch ' + JSON.stringify(c));
    }

    console.log(
      'POST_SEND_CRASH_WINDOW=CONFIRMED ' +
      'FCM_ACCEPTED_SIMULATED=true DB_DELIVERIES=0 ALERT_ATTEMPTS=0'
    );

    for (const childStage of ['recover', 'verify']) {
      const out = spawnSync(process.execPath, [__filename], {
        env: { ...envBase, AD70_STAGE: childStage },
        encoding: 'utf8'
      });

      if (out.status !== 0) {
        throw new Error(
          childStage + ' stage failed status=' + String(out.status) +
          ' stderr=' + String(out.stderr || '').slice(0, 300)
        );
      }
      process.stdout.write(out.stdout || '');
    }

    const final = await pool.query(
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
      [alert, device]
    );
    const f = final.rows[0];

    if (!f.push_sent_at ||
        Number(f.push_attempt_count) !== 1 ||
        f.push_last_error !== null ||
        Number(f.d_attempts) !== 1 ||
        !f.d_sent ||
        f.d_error !== null) {
      throw new Error('final persistence mismatch ' + JSON.stringify(f));
    }

    console.log(
      'POST_SEND_CRASH_MITIGATION=OK ' +
      'SERVER_RETRY_UNAVOIDABLE=true STABLE_TAG=' + expectedTag +
      ' COLLAPSE_KEY=true MOBILE_ONLY_ALERT_ONCE=true'
    );
  } finally {
    if (alert) await pool.query('DELETE FROM dropping_alerts WHERE id=$1', [alert]);
    if (device) await pool.query('DELETE FROM dropping_push_devices WHERE id=$1', [device]);
    else await pool.query('DELETE FROM dropping_push_devices WHERE token=$1', [token]);

    const q = await pool.query(
      "SELECT (SELECT count(*)::int FROM dropping_alerts WHERE item_key LIKE $1) alerts,(SELECT count(*)::int FROM dropping_push_devices WHERE token=$2) devices,(SELECT count(*)::int FROM dropping_alerts WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending",
      [prefix + '%', token]
    );

    if (Number(q.rows[0].alerts) !== 0 || Number(q.rows[0].devices) !== 0) {
      throw new Error('synthetic cleanup failed');
    }

    console.log('POST_SEND_CRASH_CLEANUP=OK PENDING=' + q.rows[0].pending);
    await pool.end();
  }
}

(stage ? childRun() : parentRun()).catch(async e => {
  console.error('POST_SEND_CRASH_ERROR=' + (e.message || e));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
