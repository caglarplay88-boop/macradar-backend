const { pool } = require('./db');
const {
  ensureDroppingSchema,
  registerDroppingPushDevice
} = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

(async () => {
  await ensureDroppingSchema();
  const stamp = Date.now().toString();
  const token = 'TEST_REREG_' + stamp;
  const prefix = 'TEST_REREG_' + stamp + '_';
  let deviceId = null;
  let oldId = null;
  let newId = null;
  let oldCalls = 0;
  let newCalls = 0;

  try {
    const firstReg = await registerDroppingPushDevice({
      token,
      platform: 'android',
      deviceId: 'rereg-' + stamp
    });
    deviceId = Number(firstReg.id);
    if (firstReg.enabled !== true) throw new Error('initial register not enabled');

    const old = await pool.query(
      "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME','Old Before Reregister','1','new',1.95,TRUE) RETURNING id",
      [prefix + 'OLD|OUTCOME', prefix + 'OLD']
    );
    oldId = Number(old.rows[0].id);

    const firstFlush = await flushDroppingPushes({
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (a, t, alert) => {
        if (Number(alert.id) === oldId) oldCalls++;
        const e = new Error('UNREGISTERED');
        e.unregistered = true;
        throw e;
      }
    });

    const disabled = await pool.query(
      'SELECT enabled FROM dropping_push_devices WHERE id=$1',
      [deviceId]
    );
    if (disabled.rows[0]?.enabled !== false) throw new Error('device not disabled after UNREGISTERED');

    const reReg = await registerDroppingPushDevice({
      token,
      platform: 'android',
      deviceId: 'rereg-' + stamp
    });
    if (Number(reReg.id) !== deviceId) throw new Error('re-register created a new device row');
    if (reReg.enabled !== true) throw new Error('re-register did not re-enable token');

    const fresh = await pool.query(
      "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME','New After Reregister','1','new',1.90,TRUE) RETURNING id",
      [prefix + 'NEW|OUTCOME', prefix + 'NEW']
    );
    newId = Number(fresh.rows[0].id);

    const secondFlush = await flushDroppingPushes({
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: async (a, t, alert) => {
        if (Number(alert.id) === oldId) oldCalls++;
        if (Number(alert.id) === newId) newCalls++;
        return 'ok';
      }
    });

    const states = await pool.query(
      'SELECT id,push_eligible,push_sent_at,push_attempt_count FROM dropping_alerts WHERE id = ANY($1::bigint[]) ORDER BY id',
      [[oldId,newId]]
    );
    const oldRow = states.rows.find(x => Number(x.id) === oldId);
    const newRow = states.rows.find(x => Number(x.id) === newId);

    if (oldCalls !== 1) throw new Error('old alert was replayed after re-register oldCalls=' + oldCalls);
    if (newCalls !== 1) throw new Error('new alert not sent exactly once newCalls=' + newCalls);
    if (oldRow.push_eligible !== false) throw new Error('old alert remained eligible after terminal UNREGISTERED');
    if (!newRow.push_sent_at) throw new Error('new alert not marked sent');
    if (secondFlush.sentAlerts !== 1 || secondFlush.sentDevices !== 1) {
      throw new Error('second flush result mismatch ' + JSON.stringify(secondFlush));
    }

    console.log('REREGISTER=OK SAME_DEVICE_ID=true REENABLED=true OLD_REPLAY=0 NEW_SENDS=1');
  } finally {
    if (oldId || newId) {
      await pool.query('DELETE FROM dropping_alerts WHERE id = ANY($1::bigint[])', [[oldId,newId].filter(Boolean)]);
    }
    await pool.query('DELETE FROM dropping_push_devices WHERE token=$1', [token]);
    const c = await pool.query(
      "SELECT (SELECT count(*)::int FROM dropping_alerts WHERE item_key LIKE $1) alerts,(SELECT count(*)::int FROM dropping_push_devices WHERE token=$2) devices,(SELECT count(*)::int FROM dropping_alerts WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending",
      [prefix + '%', token]
    );
    console.log('REREGISTER_CLEANUP=' + (Number(c.rows[0].alerts)===0 && Number(c.rows[0].devices)===0 ? 'OK' : 'FAIL') + ' PENDING=' + c.rows[0].pending);
    await pool.end();
  }
})().catch(e => {
  console.error('REREGISTER_ERROR=' + (e.message || e));
  process.exitCode = 1;
});
