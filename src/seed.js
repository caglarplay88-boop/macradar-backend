const fs = require('fs');
const path = require('path');
const { pool, initDb } = require('./db');

async function seed() {
  await initDb();
  const count = Number((await pool.query('SELECT COUNT(*)::int AS c FROM matches')).rows[0].c);
  const snapCount = Number((await pool.query('SELECT COUNT(*)::int AS c FROM snapshots')).rows[0].c);
  if (count || snapCount) return { skipped: true, count, snapCount };

  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seed-data.json'), 'utf8'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const m of data.matches || []) {
      await client.query(`
        INSERT INTO matches(event_id,url,match_slug,active,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(event_id) DO NOTHING
      `, [m.event_id, m.url, m.match_slug, Boolean(m.active), m.created_at, m.updated_at]);
    }
    for (const s of data.snapshots || []) {
      await client.query(`
        INSERT INTO snapshots(event_id,captured_at,bookmaker,ms1,msx,ms2,ou15_over,ou15_under,ou25_over,ou25_under,btts_yes,btts_no)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [s.event_id,s.captured_at,s.bookmaker,s.ms1,s.msx,s.ms2,s.ou15_over,s.ou15_under,s.ou25_over,s.ou25_under,s.btts_yes,s.btts_no]);
    }
    await client.query('COMMIT');
    return { skipped: false, matches: data.matches?.length || 0, snapshots: data.snapshots?.length || 0 };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seed().then(async r => { console.log(r); await pool.end(); }).catch(async e => { console.error(e); await pool.end(); process.exit(1); });
}

module.exports = { seed };
