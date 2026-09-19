const puppeteer = require('puppeteer');
const { parseBetExplorerUrl, sleep } = require('./util');

let browserPromise = null;

function bookmakerKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '');
}

function uniqueInPageOrder(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = bookmakerKey(r.bookmaker);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function firstThreeBookmakers(oneXtwo) {
  const ordered = uniqueInPageOrder(oneXtwo);
  const oneXbetIndex = ordered.findIndex(r =>
    /(^|[^a-z0-9])1xbet([^a-z0-9]|$)/i.test(String(r.bookmaker || '')) ||
    bookmakerKey(r.bookmaker).startsWith('1xbet')
  );

  if (oneXbetIndex > 0) {
    const [oneXbet] = ordered.splice(oneXbetIndex, 1);
    ordered.unshift(oneXbet);
  }

  return ordered.slice(0, 3);
}

function findBookmaker(rows, bookmaker) {
  const target = bookmakerKey(bookmaker);
  if (!target) return null;

  const exact = rows.find(r => bookmakerKey(r.bookmaker) === target);
  if (exact) return exact;

  const bare = target.replace(/\.(de|com|tr|eu|net|org)$/i, '');
  return rows.find(r => {
    const k = bookmakerKey(r.bookmaker);
    const kb = k.replace(/\.(de|com|tr|eu|net|org)$/i, '');
    return kb === bare;
  }) || null;
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
    try {
      await page.goto(parsed.url, { waitUntil: 'domcontentloaded', timeout: 22000 });
    } catch (e) {
      if (!/timeout/i.test(String(e?.message || e))) throw e;
      console.log('[odds] navigation timeout, market endpointleri yine denenecek:', parsed.eventId);
    }

    if (!String(page.url()).startsWith('https://www.betexplorer.com/')) {
      try {
        await page.goto('https://www.betexplorer.com/', {
          waitUntil: 'domcontentloaded',
          timeout: 12000
        });
      } catch (e) {
        console.log('[odds] ana sayfa navigation uyarısı:', parsed.eventId, String(e?.message || e));
      }
    }

    await sleep(800);

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
      let lastError = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          return await page.evaluate(async ({ eventId, type }) => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 18000);
            try {
              const url = `https://www.betexplorer.com/match-odds/${eventId}/0/${type}/odds/?lang=en`;
              const r = await fetch(url, {
                credentials: 'include',
                signal: controller.signal,
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
              if (!data.odds) throw new Error(`${type} odds boş`);
              return data.odds;
            } finally {
              clearTimeout(timer);
            }
          }, { eventId: parsed.eventId, type });
        } catch (e) {
          lastError = e;
          if (attempt < 2) await sleep(1200);
        }
      }

      throw lastError || new Error(type + ' market alınamadı');
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

    const selectedBooks = firstThreeBookmakers(oneXtwo);
    console.log(
      '[odds] ' + parsed.eventId + ' bookmakers=' +
      selectedBooks.map(x => x.bookmaker).join(' | ')
    );
    const ou15Rows = uniqueInPageOrder(ou.filter(r => r.total === '1.5'));
    const ou25Rows = uniqueInPageOrder(ou.filter(r => r.total === '2.5'));
    const btsRows = uniqueInPageOrder(bts);

    const rows = selectedBooks.map(ms => {
      const r = {
        bookmaker: ms.bookmaker,
        ms1: ms.values[0],
        msx: ms.values[1],
        ms2: ms.values[2]
      };

      const a15 = findBookmaker(ou15Rows, ms.bookmaker);
      const a25 = findBookmaker(ou25Rows, ms.bookmaker);
      const kg = findBookmaker(btsRows, ms.bookmaker);

      if (a15) Object.assign(r, {
        ou15_over: a15.values[0],
        ou15_under: a15.values[1]
      });

      if (a25) Object.assign(r, {
        ou25_over: a25.values[0],
        ou25_under: a25.values[1]
      });

      if (kg) Object.assign(r, {
        btts_yes: kg.values[0],
        btts_no: kg.values[1]
      });

      return r;
    }).filter(r =>
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
