const { initDb, listMatches, pool } = require('./db');
const { pullAndSave } = require('./puller');
const { sleep } = require('./util');
const { seed } = require('./seed');

(async () => {
  await initDb();
  await seed();
  const matches = await listMatches({ activeOnly: true });
  console.log(`Saatlik tur başladı. Maç sayısı: ${matches.length}`);
  let ok = 0, fail = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    console.log(`[${i + 1}/${matches.length}] ${m.match_slug || m.event_id}`);
    const r = await pullAndSave(m.url, { attempts: 3 });
    if (r.ok) { ok++; console.log(`OK ${m.event_id}: ${r.rows} bookmaker`); }
    else { fail++; console.log(`HATA ${m.event_id}: ${r.error}`); }
    if (i < matches.length - 1) await sleep(15000);
  }
  console.log(`Tur bitti. OK=${ok} HATA=${fail}`);
  await pool.end();
  process.exit(fail && !ok ? 1 : 0);
})().catch(async e => {
  console.error(e);
  try { await pool.end(); } catch {}
  process.exit(1);
});
