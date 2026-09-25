const { fetchDropping } = require('./dropping-source');
const { DroppingWatcher } = require('./dropping-watcher-core');
const {
  ensureDroppingSchema,
  upsertDroppingRows,
  loadDroppingState
} = require('./dropping-store');
const { pool } = require('./db');

(async () => {
  await ensureDroppingSchema();

  const first = await fetchDropping();
  await upsertDroppingRows(first);

  const restored = await loadDroppingState();
  const restarted = new DroppingWatcher(restored);

  const second = await fetchDropping();
  const result = restarted.compare(second);

  const duplicateNew = result.events.filter(x => x.type === 'new').length;
  const realChanged = result.events.filter(x => x.type === 'odd_changed').length;

  console.log(
    'RESTORED=' + restored.length +
    ' CURRENT=' + second.length +
    ' DUPLICATE_NEW=' + duplicateNew +
    ' REAL_CHANGED=' + realChanged
  );

  await upsertDroppingRows(second);
  await pool.end();

  if (duplicateNew !== 0) process.exitCode = 2;
})().catch(async error => {
  console.error('RESTART_TEST_ERROR=' + (error.message || error));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
