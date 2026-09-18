const http = require('http');
const { URL } = require('url');
const { initDb, listMatches, getMatch, setActive, pool } = require('./db');
const { getBulletin } = require('./bulletin');
const { pullAndSave } = require('./puller');
const { parseBetExplorerUrl, currentIsoTurkey } = require('./util');
const { seed } = require('./seed');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.API_KEY || '');

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS'
  });
  res.end(body);
}

function authorized(req) {
  if (!API_KEY) return true;
  return req.headers['x-api-key'] === API_KEY;
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new Error('İstek çok büyük.');
  }
  if (!body) return {};
  return JSON.parse(body);
}

function eventFromPath(pathname, suffix = '') {
  const p = pathname.split('/').filter(Boolean);
  const i = p.indexOf('matches');
  if (i < 0 || !p[i + 1]) return '';
  if (suffix && p[i + 2] !== suffix) return '';
  return decodeURIComponent(p[i + 1]);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && u.pathname === '/') {
      return json(res, 200, { service: 'macradar-backend', ok: true });
    }
    if (req.method === 'GET' && u.pathname === '/health') {
      await pool.query('SELECT 1');
      return json(res, 200, { ok: true, time: new Date().toISOString() });
    }
    if (req.method === 'GET' && u.pathname === '/api/bulletin') {
      const date = u.searchParams.get('date') || currentIsoTurkey();
      const force = u.searchParams.get('force') === '1';
      const data = await getBulletin(date, { force });
      const active = new Set((await listMatches({ activeOnly: true })).map(m => m.url));
      return json(res, 200, { ...data, matches: data.matches.map(m => ({ ...m, followed: active.has(m.url) })) });
    }
    if (req.method === 'GET' && u.pathname === '/api/matches') {
      return json(res, 200, { matches: await listMatches() });
    }
    if (req.method === 'GET' && /^\/api\/matches\/[^/]+$/.test(u.pathname)) {
      const eventId = eventFromPath(u.pathname);
      const m = await getMatch(eventId);
      return m ? json(res, 200, m) : json(res, 404, { error: 'Maç bulunamadı.' });
    }

    if (!authorized(req)) return json(res, 401, { error: 'Yetkisiz.' });

    if (req.method === 'POST' && u.pathname === '/api/follow') {
      const body = await readJson(req);
      const urls = Array.isArray(body.urls) ? body.urls : body.url ? [body.url] : [];
      if (!urls.length) return json(res, 400, { error: 'url veya urls gerekli.' });
      const results = [];
      for (const raw of urls) {
        let parsed;
        try { parsed = parseBetExplorerUrl(String(raw)); }
        catch (e) { results.push({ url: raw, ok: false, error: e.message }); continue; }
        const r = await pullAndSave(parsed.url, { attempts: 3 });
        results.push({ url: parsed.url, ...r });
      }
      return json(res, 200, { results });
    }

    if (req.method === 'POST' && /^\/api\/matches\/[^/]+\/refresh$/.test(u.pathname)) {
      const eventId = eventFromPath(u.pathname, 'refresh');
      const m = await getMatch(eventId);
      if (!m) return json(res, 404, { error: 'Maç bulunamadı.' });
      const r = await pullAndSave(m.url, { attempts: 3 });
      return json(res, r.ok ? 200 : 502, r);
    }

    if (req.method === 'DELETE' && /^\/api\/matches\/[^/]+$/.test(u.pathname)) {
      const eventId = eventFromPath(u.pathname);
      const m = await setActive(eventId, false);
      return m ? json(res, 200, { ok: true, match: m }) : json(res, 404, { error: 'Maç bulunamadı.' });
    }

    if (req.method === 'POST' && /^\/api\/matches\/[^/]+\/resume$/.test(u.pathname)) {
      const eventId = eventFromPath(u.pathname, 'resume');
      const m = await setActive(eventId, true);
      return m ? json(res, 200, { ok: true, match: m }) : json(res, 404, { error: 'Maç bulunamadı.' });
    }

    return json(res, 404, { error: 'Bulunamadı.' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e.message || String(e) });
  }
});

(async () => {
  await initDb();
  const seedResult = await seed();
  console.log('Seed:', seedResult);
  server.listen(PORT, '0.0.0.0', () => console.log(`MacRadar backend ${PORT} portunda.`));
})().catch(e => {
  console.error(e);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  server.close(async () => { await pool.end(); process.exit(0); });
});
