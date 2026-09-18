const { pullOdds } = require('./odds');
const { saveSnapshot } = require('./db');
const { sleep } = require('./util');

async function pullAndSave(url, { attempts = 3 } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const data = await pullOdds(url);
      await saveSnapshot({
        eventId: data.eventId,
        url: data.url,
        slug: data.slug,
        rows: data.rows,
        capturedAt: data.capturedAt
      });
      return { ok: true, eventId: data.eventId, rows: data.rows.length, capturedAt: data.capturedAt, meta: data.meta };
    } catch (e) {
      last = e;
      if (attempt < attempts) await sleep(20000);
    }
  }
  return { ok: false, error: last?.message || String(last) };
}

module.exports = { pullAndSave };
