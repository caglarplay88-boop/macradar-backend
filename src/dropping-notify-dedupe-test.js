const {
  ensureDroppingSchema,
  primeDroppingRows,
  upsertDroppingRows,
  recordDroppingAlert,
  keyOf
} = require('./dropping-store');
const { pool } = require('./db');

(async () => {
  await ensureDroppingSchema();

  const base = {
    matchId: 'TESTDROP',
    outcomeId: 'TESTOUTCOME',
    match: 'Test Home - Test Away',
    selection: '1',
    league: 'Test League',
    date: '25.09.2026',
    time: '12:00',
    oldOdd: 2.40,
    currentOdd: 2.10,
    dropPct: 12.5,
    bookiesPct: 80,
    bookiesDown: 8,
    bookiesTotal: 10
  };

  const key = keyOf(base);

  await pool.query('DELETE FROM dropping_alerts WHERE item_key=$1', [key]);
  await pool.query('DELETE FROM dropping_state WHERE item_key=$1', [key]);

  await primeDroppingRows([base]);

  const baseline = await recordDroppingAlert({
    type: 'new',
    before: null,
    after: base
  });

  const changed = {
    ...base,
    oldOdd: 2.10,
    currentOdd: 1.95,
    dropPct: 18.8
  };

  await upsertDroppingRows([changed]);

  const firstChanged = await recordDroppingAlert({
    type: 'odd_changed',
    before: base,
    after: changed
  });

  const duplicateChanged = await recordDroppingAlert({
    type: 'odd_changed',
    before: base,
    after: changed
  });

  console.log(
    'BASELINE_ALERT=' + Boolean(baseline) +
    ' FIRST_CHANGED_ALERT=' + Boolean(firstChanged) +
    ' DUPLICATE_ALERT=' + Boolean(duplicateChanged)
  );

  await pool.query('DELETE FROM dropping_alerts WHERE item_key=$1', [key]);
  await pool.query('DELETE FROM dropping_state WHERE item_key=$1', [key]);
  await pool.end();

  if (baseline || !firstChanged || duplicateChanged) process.exitCode = 2;
})().catch(async error => {
  console.error('NOTIFY_DEDUPE_TEST_ERROR=' + (error.message || error));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
