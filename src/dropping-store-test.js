const { fetchDropping } = require('./dropping-source');
const {
  ensureDroppingSchema,
  upsertDroppingRows,
  loadDroppingState
} = require('./dropping-store');
const { pool } = require('./db');

(async () => {
  await ensureDroppingSchema();
  const rows = await fetchDropping();
  await upsertDroppingRows(rows);
  const saved = await loadDroppingState();
  console.log('FETCHED=' + rows.length + ' SAVED=' + saved.length);
  await pool.end();
})().catch(async error => {
  console.error('STORE_TEST_ERROR=' + (error.message || error));
  try { await pool.end(); } catch {}
  process.exitCode = 1;
});
