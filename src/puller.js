const { pullOdds, closeBrowser } = require('./odds');
const { saveSnapshot } = require('./db');
const { sleep } = require('./util');

function shouldRecycleBrowser(error) {
  const s = String(error?.message || error || '');
  return /Target|Protocol|browser|closed|disconnected|Navigation|ERR_|timeout|timed out/i.test(s);
}

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
      return {
        ok: true,
        eventId: data.eventId,
        rows: data.rows.length,
        capturedAt: data.capturedAt,
        meta: data.meta,
        attempt
      };
    } catch (e) {
      last = e;
      if (shouldRecycleBrowser(e)) await closeBrowser();
      if (attempt < attempts) {
        const waitMs = attempt === 1 ? 8000 : 18000;
        await sleep(waitMs);
      }
    }
  }
  return { ok: false, error: last?.message || String(last), attempts };
}

module.exports = { pullAndSave };
