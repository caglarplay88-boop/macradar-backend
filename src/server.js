const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const {
  initDb, upsertMatch, listMatches, setActive, archiveStartedMatch, finishMatch,
  pool, getTrackingSettings, updateTrackingSettings, getLatestOdds1x2Batch,
  listOdds1x2History,
  getPerformanceCache, markPerformancePreparing, savePerformanceCache,
  failPerformanceCache
} = require('./db');
const { captureInitial1x2 } = require('./odds1x2Capture');
const {
  pull1x2WithFailover,
  pullOpening1x2WithFailover
} = require('./odds1x2');
const { startOdds1x2Worker } = require('./odds1x2Worker');
const { latestLiveOddsBatch } = require('./odds1x2View');
const { getBulletin } = require('./bulletin');
const { parseBetExplorerUrl, currentIsoTurkey, sleep } = require('./util');
const { buildPerformancePackage } = require('./performance');
const { ensureDroppingSchema, listDroppingCurrent, listDroppingAlerts, getDroppingHealth, getDroppingSettings, updateDroppingSettings, registerDroppingPushDevice, disableDroppingPushDevice } = require('./dropping-store');


const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.API_KEY || '');
const HTTP_ONLY = String(process.env.MACRADAR_HTTP_ONLY || '') === '1';
const MOBILE_CODE_HASH = 'ee3a321e49e949c5ac27dc2a5504ba55a59b11eae7ab1f7b5357cd305b6e8968';
const ODDS_SOURCE_SECRET = String(
  process.env.ODDS_SOURCE_HMAC_SECRET ||
  API_KEY ||
  MOBILE_CODE_HASH
);

const performanceBuilds = new Map();
const PERFORMANCE_ENGINE_VERSION = 84;

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

function oddsHmac(secret, value) {
  return crypto.createHmac('sha256', secret)
    .update(String(value))
    .digest('hex');
}

function oddsEqualHex(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length === 32 &&
    b.length === 32 &&
    crypto.timingSafeEqual(a, b);
}

function oddsSourceAuthorized(req, u) {
  if (!ODDS_SOURCE_SECRET) return false;

  const timestamp = String(req.headers['x-odds-ts'] || '').trim();
  const signature = String(
    req.headers['x-odds-signature'] || ''
  ).trim();
  const timestampMs = Number(timestamp);

  if (
    !Number.isFinite(timestampMs) ||
    Math.abs(Date.now() - timestampMs) > 30000
  ) {
    return false;
  }

  const capture = String(u.searchParams.get('capture') || '').trim();
  const rawUrl = String(u.searchParams.get('url') || '').trim();
  if (!['opening', 'current'].includes(capture) || !rawUrl) {
    return false;
  }

  const expected = oddsHmac(
    ODDS_SOURCE_SECRET,
    timestamp + '\n' + capture + '\n' + rawUrl
  );
  return oddsEqualHex(signature, expected);
}

function oddsSourceJson(res, status, data, timestamp) {
  const body = JSON.stringify(data);
  const signature = oddsHmac(
    ODDS_SOURCE_SECRET,
    String(timestamp) + '\n' + body
  );
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-odds-response-signature': signature,
    'cache-control': 'no-store'
  });
  res.end(body);
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

const ALLOWED_ODDS_REFRESH_MINUTES = new Set([5, 15, 30, 60, 120]);

function oddsEventFromPath(pathname) {
  const match = String(pathname || '').match(
    /^\/api\/matches\/([^/]+)\/odds\/1x2$/
  );
  return match ? decodeURIComponent(match[1]) : '';
}

function oddsHistoryEventFromPath(pathname) {
  const match = String(pathname || '').match(
    /^\/api\/matches\/([^/]+)\/odds\/1x2\/history$/
  );
  return match ? decodeURIComponent(match[1]) : '';
}

function oddsBatchEnvelope(batch) {
  if (!batch) return null;

  return {
    captured_at: batch.captured_at,
    capture_type: batch.capture_type,
    capture_sequence: batch.capture_sequence,
    source_name: batch.source_name,
    source_region: batch.source_region,
    rows: batch.rows.map(row => ({
      bookmaker_id: row.bookmaker_id,
      bookmaker_name: row.bookmaker_name,
      home_odd: Number(row.home_odd),
      draw_odd: Number(row.draw_odd),
      away_odd: Number(row.away_odd)
    }))
  };
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
    if (req.method === 'POST' && u.pathname === '/api/dropping/device-token') {
      await ensureDroppingSchema();
      const body = await readJson(req);
      const token = String(body.token || '').trim();
      const platform = String(body.platform || 'android').trim().toLowerCase();
      const deviceId = body.device_id == null ? null : String(body.device_id).trim();

      if (token.length < 20 || token.length > 4096) {
        return json(res, 400, { error: 'Gecersiz FCM token.' });
      }
      if (!['android'].includes(platform)) {
        return json(res, 400, { error: 'Gecersiz platform.' });
      }
      if (deviceId && deviceId.length > 200) {
        return json(res, 400, { error: 'Gecersiz device_id.' });
      }

      const device = await registerDroppingPushDevice({
        token,
        platform,
        deviceId: deviceId || null
      });

      return json(res, 200, {
        ok: true,
        device: {
          id: device.id,
          platform: device.platform,
          device_id: device.device_id,
          enabled: device.enabled,
          updated_at: device.updated_at
        }
      });
    }

    if (req.method === 'POST' && u.pathname === '/api/dropping/device-token/disable') {
      await ensureDroppingSchema();
      const body = await readJson(req);
      const token = String(body.token || '').trim();

      if (token.length < 20 || token.length > 4096) {
        return json(res, 400, { error: 'Gecersiz FCM token.' });
      }

      const device = await disableDroppingPushDevice(token);
      return json(res, 200, { ok: true, disabled: Boolean(device) });
    }

    if (req.method === 'GET' && u.pathname === '/api/dropping/settings') {
      await ensureDroppingSchema();
      const settings = await getDroppingSettings();
      return json(res, 200, {
        ...settings,
        allowed_drops_in_last_hours: [1, 2, 12, 24, 48],
        allowed_matches_for: ['today', 'today_tomorrow', '7d', 'anytime'],
        allowed_bookies_pct: [30, 40, 50, 60, 70],
        allowed_poll_seconds: [15, 30, 60, 120, 300]
      });
    }

    if (req.method === 'POST' && u.pathname === '/api/dropping/settings') {
      await ensureDroppingSchema();
      const current = await getDroppingSettings();
      const body = await readJson(req);

      const next = {
        drops_in_last_hours:
          body.drops_in_last_hours === undefined
            ? Number(current.drops_in_last_hours)
            : Number(body.drops_in_last_hours),
        matches_for:
          body.matches_for === undefined
            ? String(current.matches_for)
            : String(body.matches_for),
        bookies_pct:
          body.bookies_pct === undefined
            ? Number(current.bookies_pct)
            : Number(body.bookies_pct),
        poll_seconds:
          body.poll_seconds === undefined
            ? Number(current.poll_seconds)
            : Number(body.poll_seconds),
        notifications_enabled:
          body.notifications_enabled === undefined
            ? current.notifications_enabled === true
            : body.notifications_enabled === true
      };

      if (![1, 2, 12, 24, 48].includes(next.drops_in_last_hours)) {
        return json(res, 400, { error: 'Gecersiz drops_in_last_hours.' });
      }
      if (!['today', 'today_tomorrow', '7d', 'anytime'].includes(next.matches_for)) {
        return json(res, 400, { error: 'Gecersiz matches_for.' });
      }
      if (![30, 40, 50, 60, 70].includes(next.bookies_pct)) {
        return json(res, 400, { error: 'Gecersiz bookies_pct.' });
      }
      if (![15, 30, 60, 120, 300].includes(next.poll_seconds)) {
        return json(res, 400, { error: 'Gecersiz poll_seconds.' });
      }
      if (
        body.notifications_enabled !== undefined &&
        typeof body.notifications_enabled !== 'boolean'
      ) {
        return json(res, 400, { error: 'notifications_enabled boolean olmali.' });
      }

      return json(res, 200, {
        ok: true,
        settings: await updateDroppingSettings(next)
      });
    }

    if (req.method === 'GET' && u.pathname === '/api/dropping/current') {
      await ensureDroppingSchema();
      return json(res, 200, { items: await listDroppingCurrent() });
    }

    if (req.method === 'GET' && u.pathname === '/api/dropping/alerts') {
      await ensureDroppingSchema();
      const afterId = Number(u.searchParams.get('after_id') || 0);
      const limit = Number(u.searchParams.get('limit') || 50);
      const alerts = await listDroppingAlerts({ afterId, limit });
      return json(res, 200, { alerts });
    }

    if (req.method === 'GET' && u.pathname === '/api/dropping/status') {
      await ensureDroppingSchema();
      return json(res, 200, await getDroppingHealth());
    }

    if (req.method === 'GET' && u.pathname === '/api/matches') {
      return json(res, 200, { matches: await listMatches() });
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

      const cachedVersion = Number(
        cached?.payload?.meta?.engineVersion || 0
      );

      if (
        cached?.payload &&
        cachedVersion < PERFORMANCE_ENGINE_VERSION
      ) {
        return json(res, 409, {
          status: 'stale',
          error: 'Performance cache is stale. Rebuild required.',
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

    if (
      req.method === 'GET' &&
      u.pathname === '/api/internal/odds-source/1x2'
    ) {
      const timestamp = String(req.headers['x-odds-ts'] || '').trim();
      if (!oddsSourceAuthorized(req, u)) {
        return json(res, 401, {
          error: 'Invalid odds source signature.'
        });
      }

      const capture = String(
        u.searchParams.get('capture') || ''
      ).trim();
      const rawUrl = String(u.searchParams.get('url') || '').trim();
      parseBetExplorerUrl(rawUrl);

      const pulled = capture === 'opening'
        ? await pullOpening1x2WithFailover(rawUrl)
        : await pull1x2WithFailover(rawUrl);

      return oddsSourceJson(res, 200, {
        event_id: pulled.eventId,
        market: pulled.market,
        source_name: pulled.sourceName,
        source_region: pulled.sourceRegion,
        fallback_used: pulled.fallbackUsed === true,
        attempts: Array.isArray(pulled.attempts)
          ? pulled.attempts
          : [],
        captured_at: pulled.capturedAt || null,
        rows: pulled.rows.map(row => ({
          bookmaker_id: row.bookmakerId || null,
          bookmaker_name: row.bookmakerName,
          home_odd: Number(row.homeOdd),
          draw_odd: Number(row.drawOdd),
          away_odd: Number(row.awayOdd),
          captured_at: row.capturedAt || null
        }))
      }, timestamp);
    }

    if (!authorized(req)) return json(res, 401, { error: 'Yetkisiz.' });

    if (req.method === 'GET' && /^\/api\/matches\/[^/]+\/odds\/1x2\/history$/.test(u.pathname)) {
      const eventId = oddsHistoryEventFromPath(u.pathname);
      const match = (await pool.query(
        'SELECT event_id FROM matches WHERE event_id=$1',
        [eventId]
      )).rows[0];
      if (!match) return json(res, 404, { error: 'Mac bulunamadi.' });

      const pageRaw = Number.parseInt(
        u.searchParams.get('page') || '1',
        10
      );
      const page = Number.isFinite(pageRaw)
        ? Math.max(1, Math.min(100000, pageRaw))
        : 1;
      const bookmakerRaw = String(
        u.searchParams.get('bookmaker') || ''
      ).trim();

      if (bookmakerRaw.length > 160) {
        return json(res, 400, {
          error: 'Bookmaker filtresi cok uzun.'
        });
      }

      const history = await listOdds1x2History({
        eventId,
        bookmaker: bookmakerRaw || null,
        page,
        pageSize: 50
      });

      return json(res, 200, {
        event_id: eventId,
        bookmaker_key: history.bookmaker_key,
        page: history.page,
        page_size: history.page_size,
        total_records: history.total_records,
        total_pages: history.total_pages,
        has_previous: history.has_previous,
        has_next: history.has_next,
        rows: history.rows.map(row => ({
          id: String(row.id),
          bookmaker_id: row.bookmaker_id,
          bookmaker_key: row.bookmaker_key,
          bookmaker_name: row.bookmaker_name,
          market: row.market,
          home_odd: Number(row.home_odd),
          draw_odd: Number(row.draw_odd),
          away_odd: Number(row.away_odd),
          captured_at: row.captured_at,
          capture_sequence: String(row.capture_sequence),
          capture_type: row.capture_type,
          source_name: row.source_name,
          source_region: row.source_region
        }))
      });
    }

    if (req.method === 'GET' && /^\/api\/matches\/[^/]+\/odds\/1x2$/.test(u.pathname)) {
      const eventId = oddsEventFromPath(u.pathname);
      const match = (await pool.query(
        'SELECT event_id,url,active,archived,lifecycle FROM matches WHERE event_id=$1',
        [eventId]
      )).rows[0];

      if (!match) return json(res, 404, { error: 'Maç bulunamadı.' });

      const settings = await getTrackingSettings(eventId);
      const [opening, initialCurrent, periodic] = await Promise.all([
        getLatestOdds1x2Batch(eventId, 'opening'),
        getLatestOdds1x2Batch(eventId, 'current'),
        getLatestOdds1x2Batch(eventId, 'periodic')
      ]);
      const liveCurrent = latestLiveOddsBatch(initialCurrent, periodic);

      return json(res, 200, {
        event_id: eventId,
        tracking_enabled: settings?.tracking_enabled === true,
        refresh_minutes: Number(settings?.refresh_minutes || 60),
        allowed_refresh_minutes: [5, 15, 30, 60, 120],
        opening: oddsBatchEnvelope(opening),
        current: oddsBatchEnvelope(liveCurrent)
      });
    }

    if (req.method === 'POST' && /^\/api\/matches\/[^/]+\/tracking$/.test(u.pathname)) {
      const eventId = eventFromPath(u.pathname, 'tracking');
      const body = await readJson(req);
      const enabled = body?.enabled;
      const minutes = Number(body?.minutes);

      if (typeof enabled !== 'boolean') {
        return json(res, 400, { error: 'enabled boolean olmalı.' });
      }
      if (!ALLOWED_ODDS_REFRESH_MINUTES.has(minutes)) {
        return json(res, 400, { error: 'Geçersiz çekim aralığı.' });
      }

      const match = (await pool.query(
        `SELECT event_id,url,active,archived,lifecycle
         FROM matches
         WHERE event_id=$1`,
        [eventId]
      )).rows[0];

      if (!match) return json(res, 404, { error: 'Maç bulunamadı.' });
      if (
        enabled &&
        (match.active !== true || match.archived === true ||
         ['started', 'finished', 'removed'].includes(String(match.lifecycle || '')))
      ) {
        return json(res, 409, { error: 'Bu maç için oran takibi başlatılamaz.' });
      }

      let initialCapture = null;
      if (enabled) {
        const [opening, current] = await Promise.all([
          getLatestOdds1x2Batch(eventId, 'opening'),
          getLatestOdds1x2Batch(eventId, 'current')
        ]);

        if (!opening || !current) {
          initialCapture = await captureInitial1x2(match.url, eventId);
        }
      }

      const scheduleFrom =
        enabled && initialCapture?.current?.capturedAt
          ? initialCapture.current.capturedAt
          : null;
      const settings = await updateTrackingSettings(
        eventId,
        enabled,
        minutes,
        scheduleFrom
      );
      if (!settings) return json(res, 404, { error: 'Maç bulunamadı.' });

      return json(res, 200, {
        ok: true,
        event_id: eventId,
        tracking_enabled: settings.tracking_enabled === true,
        refresh_minutes: Number(settings.refresh_minutes),
        initial_capture: initialCapture
          ? {
              opening_inserted: initialCapture.opening.inserted,
              current_inserted: initialCapture.current.inserted,
              opening_source: initialCapture.opening.sourceName,
              current_source: initialCapture.current.sourceName
            }
          : null
      });
    }

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

      const cachedVersion = Number(
        cached?.payload?.meta?.engineVersion || 0
      );

      if (
        !force &&
        cached?.payload &&
        cachedVersion >= PERFORMANCE_ENGINE_VERSION
      ) {
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

      return json(res, 200, {
        results
      });
    }

    if (req.method === 'DELETE' && /^\/api\/matches\/[^/]+$/.test(u.pathname)) {
      const eventId = eventFromPath(u.pathname);
      const m = await setActive(eventId, false);
      return m ? json(res, 200, { ok: true, match: m }) : json(res, 404, { error: 'Maç bulunamadı.' });
    }

    return json(res, 404, { error: 'Bulunamadı.' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e.message || String(e) });
  }
});

(async () => {
  if (HTTP_ONLY) {
    console.log('[http-only] initDb/seed skipped.');
  } else {
    await initDb();
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`MacRadar backend ${PORT} portunda.`);
    if (HTTP_ONLY) return;
    setTimeout(() => enrichActiveSchedules(), 1000);
    startOdds1x2Worker();
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
