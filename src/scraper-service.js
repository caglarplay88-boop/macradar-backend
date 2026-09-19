const http = require('http');
const { pullOdds, closeBrowser } = require('./odds');
const { sleep } = require('./util');

const PORT = Number(process.env.PORT || 3000);
const SCRAPER_KEY = String(process.env.SCRAPER_KEY || '');

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error('İstek çok büyük.');
  }
  return body ? JSON.parse(body) : {};
}

function authorized(req) {
  if (!SCRAPER_KEY) return true;
  return String(req.headers['x-scraper-key'] || '') === SCRAPER_KEY;
}

async function scrapeWithRetry(url, attempts = 3) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const data = await pullOdds(url);
      return {
        ok: true,
        attempt,
        eventId: data.eventId,
        url: data.url,
        slug: data.slug,
        meta: data.meta,
        rows: data.rows,
        capturedAt: data.capturedAt
      };
    } catch (e) {
      last = e;
      await closeBrowser().catch(() => {});
      if (attempt < attempts) await sleep(attempt === 1 ? 5000 : 12000);
    }
  }
  return { ok: false, error: last?.message || String(last), attempts };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, 200, { ok: true, region: 'scraper' });
    }

    if (!authorized(req)) return json(res, 401, { error: 'Yetkisiz.' });

    if (req.method === 'POST' && req.url === '/scrape') {
      const body = await readJson(req);
      if (!body.url) return json(res, 400, { error: 'url gerekli.' });

      const result = await scrapeWithRetry(String(body.url), 3);
      return json(res, result.ok ? 200 : 502, result);
    }

    return json(res, 404, { error: 'Bulunamadı.' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e.message || String(e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('MacRadar scraper service', PORT);
});

process.on('SIGTERM', async () => {
  await closeBrowser().catch(() => {});
  server.close(() => process.exit(0));
});
