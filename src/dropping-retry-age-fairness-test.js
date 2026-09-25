const { pool } = require('./db');
const { ensureDroppingSchema } = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

(async () => {
  await ensureDroppingSchema();

  const stamp = Date.now().toString();
  const prefix = 'TEST_RETRY_AGE_' + stamp + '_';
  const token = 'TEST_RETRY_AGE_DEVICE_' + stamp;
  const retryIds = [];
  const freshIds = [];
  let deviceId = null;
  let retryCalls = 0;
  let freshCalls = 0;

  async function insertAlerts(kind, count, offset) {
    const ids = [];
    for (let i = 1; i <= count; i++) {
      const n = offset + i;
      const itemKey = prefix + kind + '_' + String(n).padStart(3, '0') + '|OUTCOME';
      const q = await pool.query(
        "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME',$3,'1','new',$4,TRUE) RETURNING id",
        [itemKey, prefix + kind + '_' + n, kind + ' ' + n, 2.60 - n / 1000]
      );
      ids.push(Number(q.rows[0].id));
    }
    return ids;
  }

  try {
    const d = await pool.query(
      "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
      [token, 'retry-age-' + stamp]
    );
    deviceId = Number(d.rows[0].id);

    retryIds.push(...await insertAlerts('RETRY', 25, 0));
    const retrySet = new Set(retryIds);

    const sendImpl = async (account, accessToken, alert, device) => {
      if (String(device.id) !== String(deviceId)) {
        throw new Error('unexpected device');
      }

      const id = Number(alert.id);
      if (retrySet.has(id)) {
        retryCalls++;
        throw new Error('synthetic 503 aged retry');
      }

      if (freshIds.includes(id)) {
        freshCalls++;
        return 'ok';
      }

      throw new Error('unexpected alert id=' + id);
    };

    const options = {
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl
    };

    const first = await flushDroppingPushes(options);

    if (first.pending !== 25 ||
        first.failedDevices !== 25 ||
        first.sentAlerts !== 0 ||
        retryCalls !== 25 ||
        freshCalls !== 0) {
      throw new Error('initial retry seed mismatch ' + JSON.stringify({
        first, retryCalls, freshCalls
      }));
    }

    for (let round = 1; round <= 3; round++) {
      const ids = await insertAlerts('FRESH_R' + round, 25, round * 100);
      freshIds.push(...ids);

      const result = await flushDroppingPushes(options);
      console.log(
        'RETRY_AGE_ROUND=' + round +
        ' FETCHED=' + String(result.pending ?? 0) +
        ' RETRY_CALLS=' + retryCalls +
        ' FRESH_CALLS=' + freshCalls
      );
    }

    const retryDb = await pool.query(
      `SELECT
         min(push_attempt_count)::int AS min_attempt,
         max(push_attempt_count)::int AS max_attempt,
         count(*) FILTER (WHERE push_attempt_count >= 2)::int AS retried,
         count(*) FILTER (WHERE push_sent_at IS NULL)::int AS pending
       FROM dropping_alerts
       WHERE id=ANY($1::bigint[])`,
      [retryIds]
    );

    const freshDb = await pool.query(
      `SELECT
         count(*) FILTER (WHERE push_sent_at IS NOT NULL)::int AS sent,
         count(*) FILTER (WHERE push_attempt_count > 0)::int AS attempted
       FROM dropping_alerts
       WHERE id=ANY($1::bigint[])`,
      [freshIds]
    );

    const retry = retryDb.rows[0];
    const fresh = freshDb.rows[0];

    if (Number(retry.retried) !== 25 ||
        Number(retry.min_attempt) < 2 ||
        Number(retry.pending) !== 25) {
      throw new Error(
        'RETRY_STARVED min=' + retry.min_attempt +
        ' max=' + retry.max_attempt +
        ' retried=' + retry.retried
      );
    }

    if (Number(fresh.sent) < 25 ||
        Number(fresh.attempted) < 25) {
      throw new Error(
        'FRESH_STARVED sent=' + fresh.sent +
        ' attempted=' + fresh.attempted
      );
    }

    console.log(
      'RETRY_AGE_FAIRNESS=OK RETRIES=25 RETRIED=' + retry.retried +
      ' RETRY_ATTEMPT_RANGE=' + retry.min_attempt + '-' + retry.max_attempt +
      ' FRESH_SENT=' + fresh.sent +
      ' RETRY_STARVED=0 FRESH_STARVED=0'
    );
  } finally {
    const allIds = [...retryIds, ...freshIds];
    if (allIds.length) {
      await pool.query(
        'DELETE FROM dropping_alerts WHERE id=ANY($1::bigint[])',
        [allIds]
      );
    }

    if (deviceId) {
      await pool.query('DELETE FROM dropping_push_devices WHERE id=$1', [deviceId]);
    } else {
      await pool.query('DELETE FROM dropping_push_devices WHERE token=$1', [token]);
    }

    const c = await pool.query(
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
      'RETRY_AGE_CLEANUP=' +
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
})().catch(async error => {
  console.error('RETRY_AGE_ERROR=' + (error.message || error));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
