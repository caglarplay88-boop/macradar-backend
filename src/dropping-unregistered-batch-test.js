const { pool } = require('./db');
const { ensureDroppingSchema } = require('./dropping-store');
const { flushDroppingPushes } = require('./dropping-push');

(async () => {
  await ensureDroppingSchema();

  const stamp = Date.now().toString();
  const prefix = 'TEST_UNREG_BATCH_' + stamp + '_';
  const tokens = {
    A: 'TEST_UNREG_A_' + stamp,
    B: 'TEST_UNREG_B_' + stamp,
    C: 'TEST_UNREG_C_' + stamp
  };
  const ids = {};
  const alertIds = [];
  const calls = { A: 0, B: 0, C: 0 };

  try {
    for (const name of ['A','B','C']) {
      const q = await pool.query(
        "INSERT INTO dropping_push_devices(token,platform,device_id,enabled) VALUES($1,'android',$2,TRUE) RETURNING id",
        [tokens[name], 'unreg-' + name.toLowerCase() + '-' + stamp]
      );
      ids[name] = Number(q.rows[0].id);
    }

    for (let i = 1; i <= 5; i++) {
      const item = prefix + i + '|OUTCOME';
      const a = await pool.query(
        "INSERT INTO dropping_alerts(item_key,match_id,outcome_id,match_name,selection,event_type,current_odd,push_eligible) VALUES($1,$2,'OUTCOME',$3,'1','new',$4,TRUE) RETURNING id",
        [item, prefix + i, 'Unregistered Batch ' + i, 2 - i / 100]
      );
      alertIds.push(Number(a.rows[0].id));
    }

    async function fakeSend(account, accessToken, alert, device) {
      let name = null;
      for (const n of ['A','B','C']) {
        if (String(device.id) === String(ids[n])) name = n;
      }
      if (!name) throw new Error('unexpected device');
      calls[name]++;

      if (name === 'B') {
        const e = new Error('UNREGISTERED');
        e.unregistered = true;
        throw e;
      }
      return 'ok';
    }

    const opts = {
      limit: 25,
      accountOverride: { projectId: 'test-project' },
      accessTokenOverride: 'test-access',
      sendImpl: fakeSend
    };

    const first = await flushDroppingPushes(opts);

    const deviceRows = await pool.query(
      'SELECT id,enabled FROM dropping_push_devices WHERE id = ANY($1::bigint[]) ORDER BY id',
      [[ids.A, ids.B, ids.C]]
    );
    const b = deviceRows.rows.find(x => String(x.id) === String(ids.B));
    if (!b || b.enabled !== false) throw new Error('B was not disabled');

    const aState = await pool.query(
      `SELECT
         count(*) FILTER (WHERE push_sent_at IS NOT NULL)::int AS sent,
         count(*) FILTER (WHERE push_sent_at IS NULL)::int AS pending,
         count(*) FILTER (WHERE push_attempt_count=1)::int AS one_attempt
       FROM dropping_alerts WHERE id = ANY($1::bigint[])`,
      [alertIds]
    );
    const ar = aState.rows[0];

    if (first.sentAlerts !== 5) throw new Error('alerts not completed: ' + JSON.stringify(first));
    if (Number(ar.sent) !== 5 || Number(ar.pending) !== 0 || Number(ar.one_attempt) !== 5) {
      throw new Error('alert state mismatch ' + JSON.stringify(ar));
    }

    if (calls.A !== 5 || calls.C !== 5) {
      throw new Error('successful devices call mismatch A=' + calls.A + ' C=' + calls.C);
    }

    if (calls.B !== 1) {
      throw new Error('disabled B retried inside same batch calls=' + calls.B);
    }

    const second = await flushDroppingPushes(opts);
    if (second.pending !== 0 || second.sentAlerts !== 0 || second.sentDevices !== 0) {
      throw new Error('second flush should be empty ' + JSON.stringify(second));
    }
    if (calls.A !== 5 || calls.B !== 1 || calls.C !== 5) {
      throw new Error('duplicate calls after completion ' + JSON.stringify(calls));
    }

    const d = await pool.query(
      `SELECT
         count(*) FILTER (WHERE device_id=$2 AND sent_at IS NOT NULL)::int AS a_sent,
         count(*) FILTER (WHERE device_id=$3 AND last_error='UNREGISTERED')::int AS b_unreg,
         count(*) FILTER (WHERE device_id=$4 AND sent_at IS NOT NULL)::int AS c_sent
       FROM dropping_push_deliveries
       WHERE alert_id = ANY($1::bigint[])`,
      [alertIds, ids.A, ids.B, ids.C]
    );
    const dr = d.rows[0];
    if (Number(dr.a_sent) !== 5 || Number(dr.b_unreg) !== 1 || Number(dr.c_sent) !== 5) {
      throw new Error('delivery persistence mismatch ' + JSON.stringify(dr));
    }

    console.log('UNREGISTERED_BATCH=OK A_CALLS=5 B_CALLS=1 C_CALLS=5 ALERTS_SENT=5 SECOND_FLUSH=0 B_DISABLED=true');
  } finally {
    if (alertIds.length) {
      await pool.query('DELETE FROM dropping_alerts WHERE id = ANY($1::bigint[])', [alertIds]);
    }
    await pool.query('DELETE FROM dropping_push_devices WHERE token = ANY($1::text[])', [[tokens.A, tokens.B, tokens.C]]);

    const c = await pool.query(
      "SELECT (SELECT count(*)::int FROM dropping_alerts WHERE item_key LIKE $1) alerts,(SELECT count(*)::int FROM dropping_push_devices WHERE token = ANY($2::text[])) devices,(SELECT count(*)::int FROM dropping_alerts WHERE push_eligible=TRUE AND push_sent_at IS NULL) pending",
      [prefix + '%', [tokens.A, tokens.B, tokens.C]]
    );
    console.log('UNREGISTERED_BATCH_CLEANUP=' + (Number(c.rows[0].alerts) === 0 && Number(c.rows[0].devices) === 0 ? 'OK' : 'FAIL') + ' PENDING=' + c.rows[0].pending);
    await pool.end();
  }
})().catch(e => {
  console.error('UNREGISTERED_BATCH_ERROR=' + (e.message || e));
  process.exitCode = 1;
});
