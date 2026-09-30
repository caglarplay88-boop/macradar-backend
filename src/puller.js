const { pullOpeningOdds } = require('./odds');
const { pullCurrent1x2, closeBrowser } = require('./odds-v2');
const { saveSnapshot, saveOpeningOdds, getOpeningFetchMeta, saveOpeningFetchMeta, saveOdds1x2Batch } = require('./db');
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

async function pullOpeningRemote(url) {
  const parsed = parseBetExplorerUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const r = await fetch(SCRAPER_URL + '/scrape-opening', {
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
    catch { throw new Error('Opening scraper returned invalid JSON.'); }
    if (!r.ok || !data?.ok) {
      throw new Error(data?.error || ('Opening scraper HTTP ' + r.status));
    }
    return {
      ...parsed,
      meta: data.meta || {},
      rows: Array.isArray(data.rows) ? data.rows : []
    };
  } finally {
    clearTimeout(timer);
  }
}

function groupOpening1x2(rows) {
  const byBookmaker = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.market !== 'MS') continue;
    const bookmaker = String(row?.bookmaker || '').trim();
    if (!bookmaker) continue;
    if (!byBookmaker.has(bookmaker)) byBookmaker.set(bookmaker, { bookmaker });
    const target = byBookmaker.get(bookmaker);
    if (row.outcome_key === 'ms1') target.ms1 = Number(row.opening_odd);
    if (row.outcome_key === 'msx') target.msx = Number(row.opening_odd);
    if (row.outcome_key === 'ms2') target.ms2 = Number(row.opening_odd);
  }
  return [...byBookmaker.values()].filter(row =>
    [row.ms1,row.msx,row.ms2].every(v => Number.isFinite(v) && v > 1)
  );
}

async function pullAndSave(url, { attempts = 3, captureType = 'periodic' } = {}) {
  let last;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const data = SCRAPER_URL ? await pullRemote(url) : await pullCurrent1x2(url);

      if (!Array.isArray(data.rows) || !data.rows.length) {
        throw new Error('Ayrıştırılabilir oran bulunamadı.');
      }

      await saveSnapshot({
        eventId: data.eventId,
        url: data.url,
        slug: data.slug,
        rows: data.rows,
        capturedAt: data.capturedAt,
        meta: data.meta || null
      });

      const saved1x2 = await saveOdds1x2Batch({
        eventId: data.eventId,
        rows: data.rows,
        capturedAt: data.capturedAt,
        captureType,
        sourceName: [data.meta?.source || 'betexplorer-1x2', data.meta?.torSource]
          .filter(Boolean).join(':'),
        sourceRegion: data.meta?.torCountry || null
      });

      return {
        ok: true,
        eventId: data.eventId,
        rows: data.rows.length,
        capturedAt: data.capturedAt,
        meta: data.meta,
        captureType,
        captureSequence: saved1x2.sequence,
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


async function pullOpeningAndSave(url) {
  const parsed = parseBetExplorerUrl(url);

  const fetchMeta = await getOpeningFetchMeta(parsed.eventId);

  if (fetchMeta?.status === 'complete') {
    return {
      ok: true,
      eventId: parsed.eventId,
      skipped: true,
      reason: 'opening_already_complete',
      rows: Number(fetchMeta.found || 0)
    };
  }

  try {
    const data = SCRAPER_URL ? await pullOpeningRemote(parsed.url) : await pullOpeningOdds(parsed.url);

    if (!Array.isArray(data.rows) || !data.rows.length) {
      throw new Error('Doğrulanmış opening odds bulunamadı.');
    }

    const requested = Number(data.meta?.requested || 0);
    const found = Number(data.meta?.found || data.rows.length);

    const saved = await saveOpeningOdds(
      parsed.eventId,
      data.rows
    );

    const openingRows = groupOpening1x2(data.rows);
    const savedBatch = await saveOdds1x2Batch({
      eventId: parsed.eventId,
      rows: openingRows,
      capturedAt: new Date(),
      captureType: 'opening',
      sourceName: [data.meta?.source || 'betexplorer-opening', data.meta?.torSource]
        .filter(Boolean).join(':'),
      sourceRegion: data.meta?.torCountry || null
    });

    const complete =
      requested > 0 &&
      found === requested;

    await saveOpeningFetchMeta(parsed.eventId, {
      status: complete ? 'complete' : 'partial',
      requested,
      found,
      torSource: data.meta?.torSource || null,
      torCountry: data.meta?.torCountry || null
    });

    return {
      ok: true,
      eventId: parsed.eventId,
      rows: saved,
      openingBookmakers: openingRows.length,
      captureSequence: savedBatch.sequence,
      complete,
      meta: data.meta || null
    };
  } catch (error) {
    await saveOpeningFetchMeta(parsed.eventId, {
      status: 'failed',
      requested: 0,
      found: 0
    }).catch(() => {});

    return {
      ok: false,
      eventId: parsed.eventId,
      error: String(error?.message || error)
    };
  }
}

module.exports = { pullAndSave, pullOpeningAndSave };
