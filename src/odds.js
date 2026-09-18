const puppeteer = require('puppeteer');
const { parseBetExplorerUrl, sleep } = require('./util');

let browserPromise = null;

function clean(rows, n = 3) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = String(r.bookmaker || '').toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync'
    ]
  });
  browser.on('disconnected', () => {
    browserPromise = null;
  });
  return browser;
}

async function getBrowser() {
  if (!browserPromise) browserPromise = launchBrowser();
  let browser;
  try {
    browser = await browserPromise;
    if (!browser.connected) throw new Error('browser disconnected');
    return browser;
  } catch (e) {
    browserPromise = null;
    throw e;
  }
}

async function closeBrowser() {
  const p = browserPromise;
  browserPromise = null;
  if (!p) return;
  try {
    const browser = await p;
    if (browser.connected) await browser.close();
  } catch {}
}

async function newConfiguredPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 1 });
  await page.setUserAgent(
    'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36'
  );
  await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const t = req.resourceType();
    if (t === 'image' || t === 'media' || t === 'font') req.abort();
    else req.continue();
  });
  return page;
}

async function pullOdds(rawUrl) {
  const parsed = parseBetExplorerUrl(rawUrl);
  const browser = await getBrowser();
  const page = await newConfiguredPage(browser);

  try {
    await page.goto(parsed.url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await sleep(1600);

    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const b = buttons.find(x => /18|confirm|yes|sim/i.test((x.innerText || '').trim()));
      if (b) b.click();
    }).catch(() => {});
    await sleep(900);

    const meta = await page.evaluate(() => {
      const body = (document.body?.innerText || '').replace(/\r/g, '');
      const title = (document.querySelector('h1')?.innerText || '').trim();
      const datePatterns = [
        /(?:Today|Tomorrow|Yesterday),?\s+\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4},?\s+\d{1,2}:\d{2}/i,
        /\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4},?\s+\d{1,2}:\d{2}/i,
        /\d{1,2}\.\d{1,2}\.\d{4}\s+\d{1,2}:\d{2}/
      ];
      let dateTime = '';
      for (const re of datePatterns) {
        const m = body.match(re);
        if (m) { dateTime = m[0]; break; }
      }
      return { title, dateTime };
    });

    async function fetchMarket(type) {
      return page.evaluate(async ({ eventId, type }) => {
        const r = await fetch(`/match-odds/${eventId}/0/${type}/odds/?lang=en`, {
          credentials: 'include',
          headers: {
            'x-requested-with': 'XMLHttpRequest',
            'accept': 'application/json,text/javascript,*/*;q=0.01'
          }
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`${type} HTTP ${r.status}`);
        let data;
        try { data = JSON.parse(text); }
        catch { throw new Error(`${type} JSON değil`); }
        return data.odds || '';
      }, { eventId: parsed.eventId, type });
    }

    async function parseHtml(html, mode) {
      return page.evaluate(({ html, mode }) => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        function nameOf(tr) {
          const a = tr.querySelector('a');
          const title = (a?.getAttribute('title') || '').trim();
          const txt = (tr.querySelector('.table-main__participant')?.textContent || '').trim();
          const first = (tr.querySelector('td')?.textContent || '').trim();
          return txt || title || first || 'Bookmaker';
        }
        function oddsOf(tr) {
          return [...tr.querySelectorAll('[data-odd]')]
            .map(x => Number((x.getAttribute('data-odd') || '').replace(',', '.')))
            .filter(n => Number.isFinite(n) && n > 1);
        }
        const out = [];
        for (const tr of [...doc.querySelectorAll('tr')]) {
          const vals = oddsOf(tr);
          if (!vals.length) continue;
          if (mode === '1x2' && vals.length >= 3) {
            out.push({ bookmaker: nameOf(tr), values: vals.slice(0, 3) });
          } else if (mode === 'bts' && vals.length >= 2) {
            out.push({ bookmaker: nameOf(tr), values: vals.slice(0, 2) });
          } else if (mode === 'ou') {
            const total = (tr.querySelector('.table-main__doubleparameter')?.textContent || '').trim().replace(',', '.');
            if ((total === '1.5' || total === '2.5') && vals.length >= 2) {
              out.push({ bookmaker: nameOf(tr), total, values: vals.slice(0, 2) });
            }
          }
        }
        return out;
      }, { html, mode });
    }

    const [h1x2, hou, hbts] = await Promise.all([
      fetchMarket('1x2'),
      fetchMarket('ou'),
      fetchMarket('bts')
    ]);

    const [oneXtwo, ou, bts] = await Promise.all([
      parseHtml(h1x2, '1x2'),
      parseHtml(hou, 'ou'),
      parseHtml(hbts, 'bts')
    ]);

    const ms = clean(oneXtwo);
    const ou15 = clean(ou.filter(r => r.total === '1.5'));
    const ou25 = clean(ou.filter(r => r.total === '2.5'));
    const kg = clean(bts);

    const byBook = new Map();
    const row = bookmaker => {
      if (!byBook.has(bookmaker)) byBook.set(bookmaker, { bookmaker });
      return byBook.get(bookmaker);
    };

    for (const r of ms) Object.assign(row(r.bookmaker), { ms1: r.values[0], msx: r.values[1], ms2: r.values[2] });
    for (const r of ou15) Object.assign(row(r.bookmaker), { ou15_over: r.values[0], ou15_under: r.values[1] });
    for (const r of ou25) Object.assign(row(r.bookmaker), { ou25_over: r.values[0], ou25_under: r.values[1] });
    for (const r of kg) Object.assign(row(r.bookmaker), { btts_yes: r.values[0], btts_no: r.values[1] });

    const rows = [...byBook.values()].filter(r =>
      ['ms1','msx','ms2','ou15_over','ou15_under','ou25_over','ou25_under','btts_yes','btts_no']
        .some(k => Number.isFinite(r[k]))
    );

    if (!rows.length) throw new Error('Ayrıştırılabilir oran bulunamadı.');

    return { ...parsed, meta, rows, capturedAt: new Date() };
  } finally {
    try { await page.close(); } catch {}
  }
}

module.exports = { pullOdds, closeBrowser };
