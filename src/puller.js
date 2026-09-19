const { pullOdds, closeBrowser } = require('./odds');
const { saveSnapshot } = require('./db');
const { sleep, parseBetExplorerUrl } = require('./util');

const SCRAPER_URL = String(process.env.SCRAPER_URL || '').replace(/\/$/, '');
const SCRAPER_KEY = String(process.env.SCRAPER_KEY || '');

function shouldRecycleBrowser(error) {
  const s = String(error?.message || error || '');
  return /Target|Protocol|browser|closed|disconnected|Navigation|ERR_|timeout|timed out/i.test(s);
}

async function pullRemote(url) {
  const parsed = parseBetExplorerUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);

  try {
    const r = await fetch(SCRAPER_URL + '/scrape', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(SCRAPER_KEY ? { 'x-scraper-key': SCRAPER_KEY } : {})
      },
      body: JSON.stringify({ url: parsed.url })
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); }
    catch { throw new Error('Singapore scraper JSON değil'); }

    if (!r.ok || !data?.ok) {
      throw new Error(data?.error || ('Singapore scraper HTTP ' + r.status));
    }

    return {
      ...parsed,
      meta: data.meta || {},
      rows: Array.isArray(data.rows) ? data.rows : [],
      capturedAt: data.capturedAt ? new Date(data.capturedAt) : new Date()
    };
  } finally {
    clearTimeout(timer);
  }
}

async function pullAndSave(url, { attempts = 3 } = {}) {
  let last;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const data = SCRAPER_URL ? await pullRemote(url) : await pullOdds(url);

      if (!Array.isArray(data.rows) || !data.rows.length) {
        throw new Error('Ayrıştırılabilir oran bulunamadı.');
      }

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

      if (!SCRAPER_URL && shouldRecycleBrowser(e)) {
        await closeBrowser();
      }

      if (attempt < attempts) {
        const waitMs = attempt === 1 ? 6000 : 12000;
        await sleep(waitMs);
      }
    }
  }

  return {
    ok: false,
    error: last?.message || String(last),
    attempts
  };
}

module.exports = { pullAndSave };
