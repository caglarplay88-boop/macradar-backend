const { pool } = require('./db');
const { ensureDroppingSchema } = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

(async () => {
  await ensureDroppingSchema();
  const stamp = Date.now().toString();
  const tokenA = 'TEST_MULTI_A_' + stamp;
  const tokenB = 'TEST_MULTI_B_' + stamp;
  const item = 'TEST_MULTI_' + stamp + '|OUTCOME';

  await pool.query(
    "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE),($3,'android',$4,TRUE)",
    [tokenA, 'test-a-' + stamp, tokenB, 'test-b-' + stamp]
  );
  await pool.query(
    "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME','Test Multi Push','1','new',2.0,TRUE)",
    [item, 'TEST_MULTI_' + stamp]
  );

  const calls = new Map([[tokenA, 0], [tokenB, 0]]);
  let failB = true;
  async function fakeSend(a, t, alert, device) {
    calls.set(device.token, (calls.get(device.token) || 0) + 1);
    if (device.token === tokenB && failB) throw new Error('synthetic 503');
    return 'ok';
  }
  const options = {
    accountOverride: { projectId: 'test-project' },
    accessTokenOverride: 'test-access',
    sendImpl: fakeSend
  };

  const first = await flushDroppingPushes(options);
  failB = false;
  const second = await flushDroppingPushes(options);
  const third = await flushDroppingPushes(options);

  if (first.sentAlerts !== 0) throw new Error('partial send marked complete');
  if (second.sentAlerts !== 1) throw new Error('retry did not complete');
  if (third.sentAlerts !== 0) throw new Error('completed alert resent');
  if (calls.get(tokenA) !== 1) throw new Error('device A duplicated');
  if (calls.get(tokenB) !== 2) throw new Error('device B retry mismatch');

  const result = await pool.query(
    "SELECT a.push_sent_at, count(*) FILTER (WHERE d.sent_at IS NOT NULL)::int AS delivered FROM dropping_alerts a LEFT JOIN dropping_push_deliveries d ON d.alert_id=a.id WHERE a.item_key=$1 GROUP BY a.id",
    [item]
  );
  if (!result.rows[0]?.push_sent_at || Number(result.rows[0]?.delivered) !== 2) {
    throw new Error('delivery persistence mismatch');
  }

  console.log('MULTI_DEVICE_RETRY=OK A_CALLS=1 B_CALLS=2 DELIVERED=2');

  await pool.query('DELETE FROM dropping_alerts WHERE item_key=$1', [item]);
  await pool.query(
    'DELETE FROM dropping_push_devices WHERE token = ANY($1::text[])',
    [[tokenA, tokenB]]
  );

  const cleanup = await pool.query(
    `SELECT
      (SELECT COUNT(*)::int FROM dropping_alerts WHERE item_key=$1) AS alerts,
      (SELECT COUNT(*)::int FROM dropping_push_devices WHERE token = ANY($2::text[])) AS devices`,
    [item, [tokenA, tokenB]]
  );
  if (Number(cleanup.rows[0].alerts) !== 0 || Number(cleanup.rows[0].devices) !== 0) {
    throw new Error('synthetic rows were not cleaned');
  }

  console.log('MULTI_DEVICE_CLEANUP=OK');
  await pool.end();
})().catch(async e => {
  console.error('MULTI_DEVICE_RETRY_ERROR=' + (e.message || e));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
