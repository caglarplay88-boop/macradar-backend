const {
  ensureDroppingSchema,
  markDroppingPushAttempt,
  markDroppingPushSent
} = require('./dropping-store');
const { pool } = require('./db');

(async () => {
  await ensureDroppingSchema();

  const key = 'TEST_PUSH_ATTEMPT|TEST_OUTCOME';
  await pool.query('DELETE FROM dropping_alerts WHERE item_key=$1', [key]);

  const inserted = await pool.query(
    `INSERT INTO dropping_alerts(
      item_key, match_id, outcome_id, match_name, selection,
      event_type, current_odd, push_eligible
    ) VALUES($1,$2,$3,$4,$5,$6,$7,TRUE)
    RETURNING id`,
    [key, 'TEST_PUSH_ATTEMPT', 'TEST_OUTCOME', 'Test Push Attempt', '1', 'new', 2.00]
  );

  const id = inserted.rows[0].id;

  const first = await markDroppingPushAttempt(id, 'FCM HTTP 503: synthetic');
  const second = await markDroppingPushAttempt(id, null);
  const sent = await markDroppingPushSent(id);

  const final = await pool.query(
    `SELECT push_attempt_count, push_last_attempt_at, push_last_error, push_sent_at
     FROM dropping_alerts WHERE id=$1`,
    [id]
  );

  const row = final.rows[0];

  if (Number(first.push_attempt_count) !== 1) {
    throw new Error('first attempt count mismatch');
  }
  if (Number(second.push_attempt_count) !== 2) {
    throw new Error('second attempt count mismatch');
  }
  if (Number(row.push_attempt_count) !== 2) {
    throw new Error('final attempt count mismatch');
  }
  if (!row.push_last_attempt_at) {
    throw new Error('last attempt time missing');
  }
  if (row.push_last_error !== null) {
    throw new Error('last error should be cleared after successful attempt');
  }
  if (!row.push_sent_at || !sent.push_sent_at) {
    throw new Error('sent timestamp missing');
  }

  console.log(
    'PUSH_ATTEMPT_TRACKING=OK COUNT=' + row.push_attempt_count +
    ' ERROR_CLEARED=' + (row.push_last_error === null) +
    ' SENT=' + Boolean(row.push_sent_at)
  );

  await pool.query('DELETE FROM dropping_alerts WHERE id=$1', [id]);
  await pool.end();
})().catch(async error => {
  console.error('PUSH_ATTEMPT_TEST_ERROR=' + (error.message || error));
  try { await pool.query("DELETE FROM dropping_alerts WHERE item_key='TEST_PUSH_ATTEMPT|TEST_OUTCOME'"); } catch {}
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
