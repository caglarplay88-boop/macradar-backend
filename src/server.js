const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { initDb, upsertMatch, listMatches, getMatch, setActive, getWorkerStatus, listAlerts, getLatestAlertId, setSetting, getRefreshMinutes, purgePostKickoffSnapshots, archiveStartedMatch, finishMatch, pool, getPerformanceCache, markPerformancePreparing, savePerformanceCache, failPerformanceCache } = require('./db');
const { getBulletin } = require('./bulletin');
const { pullAndSave } = require('./puller');
const { parseBetExplorerUrl, currentIsoTurkey, sleep } = require('./util');
const { seed } = require('./seed');
const { runWorkerOnce } = require('./run-worker');
const { buildPerformancePackage } = require('./performance');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.API_KEY || '');
const MOBILE_CODE_HASH = 'ee3a321e49e949c5ac27dc2a5504ba55a59b11eae7ab1f7b5357cd305b6e8968';

const performanceBuilds = new Map();

function performanceCacheEnvelope(row) {
  return {
    status: row?.status || 'missing',
    updated_at: row?.updated_at || null,
    error: row?.error || null,
    has_data: Boolean(row?.payload)
  };
}

function startPerformanceBuild(eventId, matchRow, names) {
  if (performanceBuilds.has(eventId)) return performanceBuilds.get(eventId);

  const task = (async () => {
    try {
      const data = await buildPerformancePackage({
        home: { name: names.home },
        away: { name: names.away }
      });

      const payload = {
        event_id: eventId,
        display_name: matchRow.display_name,
        ...data
      };

      await savePerformanceCache(eventId, payload);
      return payload;
    } catch (e) {
      await failPerformanceCache(eventId, e?.message || String(e)).catch(() => {});
      throw e;
    } finally {
      performanceBuilds.delete(eventId);
    }
  })();

  performanceBuilds.set(eventId, task);
  task.catch(err => {
    console.error('Performance build failed:', eventId, err);
  });

  return task;
}


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
  const supplied = String(req.headers['x-api-key'] || '');
  if (!API_KEY && !MOBILE_CODE_HASH) return true;
  if (API_KEY && supplied === API_KEY) return true;
  if (supplied && MOBILE_CODE_HASH) {
    const hash = crypto.createHash('sha256').update(supplied).digest('hex');
    if (hash === MOBILE_CODE_HASH) return true;
  }
  return false;
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

function turkeyKickoffMs(date, time) {
  const dm = String(date || '').match(/(\d{4}-\d{2}-\d{2})/);
  const tm = String(time || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!dm || !tm) return null;

  const hh = String(Number(tm[1])).padStart(2, '0');
  const mm = String(Number(tm[2])).padStart(2, '0');
  const ms = new Date(`${dm[1]}T${hh}:${mm}:00+03:00`).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function matchHasStarted(date, time, now = Date.now()) {
  const ms = turkeyKickoffMs(date, time);
  return ms !== null && now >= ms;
}

function teamNamesFromMatch(m) {
  const display = String(m?.display_name || '').trim();

  for (const sep of [' - ', ' – ', ' — ', ' vs ', ' VS ']) {
    const p = display.indexOf(sep);
    if (p > 0) {
      const home = display.slice(0, p).trim();
      const away = display.slice(p + sep.length).trim();
      if (home && away) return { home, away };
    }
  }

  throw new Error('Maç takım adları bulunamadı. Bülten kaydını yenile.');
}

const pendingTargetRefreshes = new Set();
const inFlightTargetRefreshes = new Set();
let targetDrainRunning = false;

function queueTargetRefresh(eventIds, label = 'queued') {
  const ids = [...new Set((eventIds || []).map(String).filter(Boolean))];
  for (const id of ids) {
    if (!inFlightTargetRefreshes.has(id)) pendingTargetRefreshes.add(id);
  }

  if (!targetDrainRunning) {
    targetDrainRunning = true;
    setTimeout(() => drainTargetRefreshQueue(label), 50);
  }
}

async function enrichActiveSchedules() {
  try {
    const all = await listMatches();
    const tracked = all.filter(m => m.active === true || m.archived === true);
    const wanted = new Map(tracked.map(m => [m.url, m]));
    if (!wanted.size) return;

    const baseIso = currentIsoTurkey();
    const base = new Date(baseIso + 'T00:00:00Z');
    let updated = 0;
    let finished = 0;
    let locked = 0;

    for (let offset = -2; offset <= 7; offset++) {
      const d = new Date(base.getTime() + offset * 86400000);
      const iso = d.toISOString().slice(0, 10);

      try {
        const daily = await getBulletin(iso, { force: true });
        for (const m of daily.matches) {
          if (!wanted.has(m.url)) continue;

          const parsed = parseBetExplorerUrl(m.url);
          const existing = wanted.get(m.url);
          const scheduleTime = /^\d{1,2}:\d{2}$/.test(String(m.time || ''))
            ? m.time
            : (existing?.kickoff_time || null);
          const scheduleDate = m.date || existing?.match_date || iso;

          await upsertMatch({
            eventId: parsed.eventId,
            url: parsed.url,
            slug: parsed.slug,
            active: existing?.active ?? true,
            displayName: m.name || null,
            league: m.league || null,
            matchDate: scheduleDate,
            kickoffTime: scheduleTime
          });

          if (m.status === 'finished') {
            await finishMatch(parsed.eventId, m.homeScore, m.awayScore);
            finished++;
          } else if (
            existing?.lifecycle !== 'removed' &&
            matchHasStarted(scheduleDate, scheduleTime)
          ) {
            await archiveStartedMatch(parsed.eventId);
            locked++;
          }

          updated++;
        }
      } catch (e) {
        console.log('[schedule] ' + iso + ' atlandı: ' + (e.message || e));
      }

      await sleep(250);
    }

    console.log(
      '[schedule] güncellenen=' + updated +
      ' kilitlenen=' + locked +
      ' biten=' + finished
    );
  } catch (e) {
    console.error('[schedule] hata:', e);
  }
}

async function drainTargetRefreshQueue(label = 'queued') {
  try {
    while (pendingTargetRefreshes.size) {
      const ids = [...pendingTargetRefreshes];
      pendingTargetRefreshes.clear();
      ids.forEach(id => inFlightTargetRefreshes.add(id));

      try {
        const r = await runWorkerOnce({ force: true, eventIds: ids });

        if (r?.skipped && r?.reason === 'worker_already_running') {
          ids.forEach(id => pendingTargetRefreshes.add(id));
          await sleep(5000);
        } else {
          console.log(label + ' worker:', JSON.stringify(r));
        }
      } catch (e) {
        console.error(label + ' worker error:', e);
      } finally {
        ids.forEach(id => inFlightTargetRefreshes.delete(id));
      }
    }
  } finally {
    targetDrainRunning = false;
    if (pendingTargetRefreshes.size) {
      targetDrainRunning = true;
      setTimeout(() => drainTargetRefreshQueue(label), 50);
    }
  }
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
      const tracked = await listMatches();
      const active = new Set(tracked.filter(m => m.active === true).map(m => m.url));
      const archived = new Set(tracked.filter(m => m.archived === true).map(m => m.url));
      return json(res, 200, {
        ...data,
        matches: data.matches.map(m => ({
          ...m,
          followed: active.has(m.url),
          archived: archived.has(m.url)
        }))
      });
    }
    if (req.method === 'GET' && u.pathname === '/api/system/status') {
      return json(res, 200, await getWorkerStatus());
    }
    if (req.method === 'GET' && u.pathname === '/api/settings') {
      return json(res, 200, {
        refresh_minutes: await getRefreshMinutes(),
        allowed_refresh_minutes: [15, 30, 45, 60]
      });
    }

    if (req.method === 'GET' && u.pathname === '/api/alerts') {
      const afterId = Number(u.searchParams.get('after_id') || 0);
      const limit = Number(u.searchParams.get('limit') || 30);
      const alerts = await listAlerts({ afterId, limit });
      const latestId = await getLatestAlertId();
      return json(res, 200, { alerts, latest_id: latestId });
    }
    if (req.method === 'GET' && u.pathname === '/api/matches') {
      return json(res, 200, { matches: await listMatches() });
    }
    if (req.method === 'GET' && /^\/api\/matches\/[^/]+$/.test(u.pathname)) {
      const eventId = eventFromPath(u.pathname);
      const m = await getMatch(eventId);
      return m ? json(res, 200, m) : json(res, 404, { error: 'Maç bulunamadı.' });
    }

    if (req.method === 'GET' && /^\/api\/matches\/[^/]+\/performance$/.test(u.pathname)) {
      const eventId = eventFromPath(u.pathname, 'performance');
      const cached = await getPerformanceCache(eventId);

      if (cached?.status === 'preparing') {
        return json(res, 202, {
          status: 'preparing',
          performance_cache: performanceCacheEnvelope(cached)
        });
      }

      if (cached?.payload) {
        return json(res, 200, {
          ...cached.payload,
          performance_cache: performanceCacheEnvelope(cached)
        });
      }

      if (cached?.status === 'failed') {
        return json(res, 503, {
          status: 'failed',
          error: cached.error || 'Performans verisi hazırlanamadı.',
          performance_cache: performanceCacheEnvelope(cached)
        });
      }

      return json(res, 404, {
        status: 'missing',
        error: 'Performans verisi henüz hazırlanmadı.'
      });
    }

    if (!authorized(req)) return json(res, 401, { error: 'Yetkisiz.' });

    if (req.method === 'POST' && /^\/api\/matches\/[^/]+\/performance$/.test(u.pathname)) {
      const eventId = eventFromPath(u.pathname, 'performance');
      const body = await readJson(req);
      const force = body?.force === true;

      const row = (await pool.query(
        'SELECT event_id,display_name,match_slug,match_date,kickoff_time FROM matches WHERE event_id=$1',
        [eventId]
      )).rows[0];

      if (!row) return json(res, 404, { error: 'Maç bulunamadı.' });

      const cached = await getPerformanceCache(eventId);

      if (!force && cached?.payload) {
        return json(res, 200, {
          ...cached.payload,
          performance_cache: performanceCacheEnvelope(cached)
        });
      }

      const updatedMs = cached?.updated_at ? new Date(cached.updated_at).getTime() : 0;
      const preparingFresh =
        cached?.status === 'preparing' &&
        Number.isFinite(updatedMs) &&
        Date.now() - updatedMs < 10 * 60 * 1000;

      if (preparingFresh && performanceBuilds.has(eventId)) {
        return json(res, 202, {
          status: 'preparing',
          performance_cache: performanceCacheEnvelope(cached)
        });
      }

      const names = teamNamesFromMatch(row);
      const marked = await markPerformancePreparing(eventId);
      startPerformanceBuild(eventId, row, names);

      return json(res, 202, {
        status: 'preparing',
        performance_cache: performanceCacheEnvelope(marked)
      });
    }


    if (req.method === 'POST' && u.pathname === '/api/performance') {
      const body = await readJson(req);
      const data = await buildPerformancePackage({
        home: body.home,
        away: body.away
      });
      return json(res, 200, data);
    }

    if (req.method === 'POST' && u.pathname === '/api/follow') {
      const body = await readJson(req);

      let items = [];
      if (Array.isArray(body.matches)) {
        items = body.matches;
      } else {
        const urls = Array.isArray(body.urls) ? body.urls : body.url ? [body.url] : [];
        items = urls.map(url => ({ url }));
      }

      if (!items.length) {
        return json(res, 400, { error: 'matches veya urls gerekli.' });
      }

      const results = [];
      const eventIds = [];

      for (const item of items) {
        const raw = typeof item === 'string' ? item : item?.url;
        try {
          const parsed = parseBetExplorerUrl(String(raw));
          const itemDate = item?.date || null;
          const itemTime = item?.time || null;
          const itemStatus = String(item?.status || '').toLowerCase();
          const isFinished = itemStatus === 'finished' || /^(?:FIN|FT|AET|PEN)$/i.test(String(itemTime || ''));
          const started = isFinished || matchHasStarted(itemDate, itemTime);

          await upsertMatch({
            eventId: parsed.eventId,
            url: parsed.url,
            slug: parsed.slug,
            active: !started,
            displayName: item?.name || null,
            league: item?.league || null,
            matchDate: itemDate,
            kickoffTime: /^\d{1,2}:\d{2}$/.test(String(itemTime || '')) ? itemTime : null
          });

          if (isFinished) {
            await finishMatch(
              parsed.eventId,
              Number.isFinite(Number(item?.homeScore)) ? Number(item.homeScore) : null,
              Number.isFinite(Number(item?.awayScore)) ? Number(item.awayScore) : null
            );
          } else if (started) {
            await archiveStartedMatch(parsed.eventId);
          } else {
            await setActive(parsed.eventId, true);
            eventIds.push(parsed.eventId);
          }

          results.push({
            url: parsed.url,
            eventId: parsed.eventId,
            ok: true,
            queued: !started,
            locked: started,
            status: isFinished ? 'finished' : (started ? 'started' : 'tracking')
          });
        } catch (e) {
          results.push({ url: raw, ok: false, error: e.message });
        }
      }

      queueTargetRefresh(eventIds, 'Follow');

      return json(res, 200, {
        results,
        initial_refresh_queued: eventIds.length > 0
      });
    }

    if (req.method === 'POST' && u.pathname === '/api/settings/refresh-interval') {
      const body = await readJson(req);
      const minutes = Number(body.minutes);
      const allowed = new Set([15, 30, 45, 60]);

      if (!allowed.has(minutes)) {
        return json(res, 400, {
          error: 'Aralık 15, 30, 45 veya 60 dakika olmalı.'
        });
      }

      await setSetting('refresh_minutes', String(minutes));

      setTimeout(() => runWorkerOnce().then(
        r => console.log('Settings worker:', JSON.stringify(r)),
        e => console.error('Settings worker error:', e)
      ), 100);

      return json(res, 200, {
        ok: true,
        refresh_minutes: minutes
      });
    }

    if (req.method === 'POST' && /^\/api\/matches\/[^/]+\/refresh$/.test(u.pathname)) {
      const eventId = eventFromPath(u.pathname, 'refresh');
      const m = await getMatch(eventId);
      if (!m) return json(res, 404, { error: 'Maç bulunamadı.' });
      if (m.active !== true) {
        return json(res, 409, {
          error: 'Maç başladı veya bitti. Oran geçmişi kilitlendi; yeni oran çekilmiyor.'
        });
      }

      queueTargetRefresh([eventId], 'Manual');
      return json(res, 202, { ok: true, queued: true, eventId });
    }

    if (req.method === 'DELETE' && /^\/api\/matches\/[^/]+$/.test(u.pathname)) {
      const eventId = eventFromPath(u.pathname);
      const m = await setActive(eventId, false);
      return m ? json(res, 200, { ok: true, match: m }) : json(res, 404, { error: 'Maç bulunamadı.' });
    }

    if (req.method === 'POST' && /^\/api\/matches\/[^/]+\/resume$/.test(u.pathname)) {
      const eventId = eventFromPath(u.pathname, 'resume');
      const current = await getMatch(eventId);
      if (!current) return json(res, 404, { error: 'Maç bulunamadı.' });
      if (
        current.lifecycle === 'finished' ||
        current.archived === true ||
        matchHasStarted(current.match_date, current.kickoff_time)
      ) {
        return json(res, 409, {
          error: 'Başlamış veya bitmiş maç yeniden oran takibine alınamaz.'
        });
      }
      const m = await setActive(eventId, true);
      return json(res, 200, { ok: true, match: m });
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
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`MacRadar backend ${PORT} portunda.`);
    setTimeout(async () => {
      await enrichActiveSchedules();
      const cleanup = await purgePostKickoffSnapshots();
      console.log('[cleanup] post-kickoff oran temizliği:', cleanup);
      runWorkerOnce().then(
        r => console.log('Startup worker:', JSON.stringify(r)),
        e => console.error('Startup worker error:', e)
      );
    }, 1000);
    setInterval(() => runWorkerOnce().then(
      r => console.log('Periodic worker:', JSON.stringify(r)),
      e => console.error('Periodic worker error:', e)
    ), 5 * 60 * 1000);

    // Hafif bülten kontrolü: başlayan maçları kilitler, FIN olunca sonucu arşive yazar.
    setInterval(() => enrichActiveSchedules(), 10 * 60 * 1000);
  });
})().catch(e => {
  console.error(e);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  server.close(async () => { await pool.end(); process.exit(0); });
});
