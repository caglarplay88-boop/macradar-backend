const puppeteer = require('puppeteer');

const UA = 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';
const CACHE_MS = Number(process.env.PERFORMANCE_CACHE_MS || 20 * 60 * 1000);
const cache = new Map();

const sleep = ms => new Promise(r => setTimeout(r, ms));

function normalizeName(v) {
  return String(v || '').trim().toLowerCase();
}

function text(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  return String(v.name ?? v.shortName ?? v.teamName ?? v.participantName ?? v.title ?? '');
}

function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') {
    for (const x of [v.value, v.current, v.score, v.total]) {
      const n = num(x);
      if (n != null) return n;
    }
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dateValue(obj) {
  const v = obj?.startTime ?? obj?.timeTS ?? obj?.utcTime ?? obj?.status?.utcTime ?? obj?.date ?? '';
  if (typeof v === 'object') return v.utcTime ?? v.time ?? v.date ?? v.startTime ?? '';
  return String(v || '');
}

function normalizeFotMobUrl(v) {
  if (!v) return '';
  let u = String(v);
  if (u.startsWith('/')) u = 'https://www.fotmob.com' + u;
  if (!u.startsWith('http') && u.includes('/matches/')) u = 'https://www.fotmob.com/' + u.replace(/^\/+/, '');
  try {
    const x = new URL(u);
    if (!/(^|\.)fotmob\.com$/i.test(x.hostname)) return '';
    return x.toString();
  } catch {
    return '';
  }
}

function scoreFrom(obj, side) {
  if (side === 'home') {
    return num(obj?.home?.score) ?? num(obj?.homeTeam?.score) ?? num(obj?.homeScore) ?? num(obj?.score?.home);
  }
  return num(obj?.away?.score) ?? num(obj?.awayTeam?.score) ?? num(obj?.awayScore) ?? num(obj?.score?.away);
}

function matchStatus(obj) {
  return String(
    obj?.status?.reason?.short ??
    obj?.status?.reason?.long ??
    obj?.status?.status ??
    obj?.status?.finished ??
    obj?.status ??
    ''
  );
}

function scanMatches(obj, target, out, path = 'root') {
  if (!obj || typeof obj !== 'object') return;
  const homeObj = obj.home ?? obj.homeTeam ?? obj.team1 ?? obj.participants?.[0];
  const awayObj = obj.away ?? obj.awayTeam ?? obj.team2 ?? obj.participants?.[1];
  const home = text(homeObj);
  const away = text(awayObj);

  if (home && away) {
    const h = normalizeName(home);
    const a = normalizeName(away);
    if (teamNameMatches(home, target) || teamNameMatches(away, target)) {
      const url = normalizeFotMobUrl(obj.pageUrl ?? obj.matchUrl ?? obj.url ?? obj.href ?? '');
      const date = dateValue(obj);
      const homeScore = scoreFrom(obj, 'home');
      const awayScore = scoreFrom(obj, 'away');
      const status = matchStatus(obj);
      out.push({
        home, away, url, date, homeScore, awayScore, status, path,
        id: obj.id ?? obj.matchId ?? obj.match_id ?? obj.eventId ?? null
      });
    }
  }

  if (Array.isArray(obj)) {
    obj.forEach((v, i) => scanMatches(v, target, out, path + '[' + i + ']'));
  } else {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') scanMatches(v, target, out, path + '.' + k);
    }
  }
}

function dedupeMatches(rows) {
  const map = new Map();
  for (const m of rows) {
    const day = Number.isFinite(Date.parse(m.date)) ? new Date(m.date).toISOString() : m.date;
    const key = [m.id || '', day, m.home, m.away, m.homeScore ?? '', m.awayScore ?? '', m.url].join('|');
    if (!map.has(key)) map.set(key, m);
  }
  return [...map.values()];
}

function isFinished(m, now = Date.now()) {
  const s = String(m.status || '').toLowerCase();
  if (/\b(ft|aet|pen|finished|true)\b/.test(s)) return true;
  const t = Date.parse(m.date);
  return Number.isFinite(t) && t < now - 3 * 60 * 60 * 1000 && m.homeScore != null && m.awayScore != null;
}

function collectJsonScripts() {
  return [...document.querySelectorAll('script[type="application/json"],script#__NEXT_DATA__')]
    .map(s => s.textContent)
    .filter(Boolean);
}

async function launchBrowser() {
  return puppeteer.launch({
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
}

async function newPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setRequestInterception(true);
  page.on('request', req => {
    const t = req.resourceType();
    if (['image','media','font'].includes(t)) req.abort();
    else req.continue();
  });
  return page;
}

async function collectTeamData(browser, url, teamName) {
  const target = normalizeName(teamName);
  const matches = [];
  const jsons = [];
  const page = await newPage(browser);

  const onJson = async response => {
    try {
      const type = response.headers()['content-type'] || '';
      if (!/json|javascript/i.test(type)) return;
      const body = await response.text();
      if (!body.toLowerCase().includes(target)) return;
      const json = JSON.parse(body);
      jsons.push(json);
      scanMatches(json, teamName, matches);
    } catch {}
  };
  page.on('response', onJson);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await sleep(3200);
    try {
      const scripts = await page.evaluate(collectJsonScripts);
      for (const body of scripts) {
        try {
          if (!String(body).toLowerCase().includes(target)) continue;
          const json = JSON.parse(body);
          jsons.push(json);
          scanMatches(json, teamName, matches);
        } catch {}
      }
    } catch {}
  } finally {
    await page.close().catch(() => {});
  }

  return { matches: dedupeMatches(matches), jsons };
}

function pairFromValue(v) {
  if (Array.isArray(v) && v.length >= 2) {
    const a = num(v[0]);
    const b = num(v[1]);
    if (a != null && b != null) return { home: a, away: b };
  }
  if (v && typeof v === 'object') {
    const home = num(v.home) ?? num(v[0]);
    const away = num(v.away) ?? num(v[1]);
    if (home != null && away != null) return { home, away };
  }
  return null;
}

function findExpectedGoals(obj, path = 'root', out = []) {
  if (!obj || typeof obj !== 'object') return out;

  const key = String(obj.key ?? obj.statKey ?? '').toLowerCase();
  const title = String(obj.title ?? obj.name ?? obj.label ?? '').toLowerCase();
  const likely = key === 'expected_goals' || title.includes('expected goals') || title === 'xg';

  if (likely && /periods\.all/i.test(path)) {
    for (const v of [obj.stats, obj.values, obj.value, obj]) {
      const pair = pairFromValue(v);
      if (pair) out.push({ ...pair, path });
    }
  }

  if (Array.isArray(obj)) {
    obj.forEach((v, i) => findExpectedGoals(v, path + '[' + i + ']', out));
  } else {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') findExpectedGoals(v, path + '.' + k, out);
    }
  }
  return out;
}

async function fetchFotMobMatchDetails(matchId) {
  if (matchId == null || matchId === '') return null;

  const urls = [
    'https://www.fotmob.com/api/data/matchDetails?matchId=' + encodeURIComponent(matchId),
    'https://www.fotmob.com/api/matchDetails?matchId=' + encodeURIComponent(matchId),
  ];

  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    try {
      const r = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': UA,
          'accept': 'application/json,text/plain,*/*',
          'referer': 'https://www.fotmob.com/',
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      if (!r.ok) continue;
      return await r.json();
    } catch {
      // Try the next FotMob route, then browser fallback.
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

async function getMatchXg(browser, url, matchId) {
  const direct = await fetchFotMobMatchDetails(matchId);
  if (direct) {
    const rows = findExpectedGoals(direct);
    if (rows.length) return rows[0];
  }

  if (!url) return null;

  const page = await newPage(browser);
  let done;
  const found = new Promise(resolve => { done = resolve; });
  let settled = false;

  const inspect = json => {
    if (settled) return;
    const rows = findExpectedGoals(json);
    if (rows.length) {
      settled = true;
      done(rows[0]);
    }
  };

  page.on('response', async response => {
    try {
      const type = response.headers()['content-type'] || '';
      if (!/json|javascript/i.test(type)) return;
      const body = await response.text();
      if (!/expected_goals|Expected goals/i.test(body)) return;
      inspect(JSON.parse(body));
    } catch {}
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    try {
      const scripts = await page.evaluate(collectJsonScripts);
      for (const body of scripts) {
        try { inspect(JSON.parse(body)); } catch {}
        if (settled) break;
      }
    } catch {}

    return await Promise.race([
      found,
      sleep(2200).then(() => null),
    ]);
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }

  const count = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({ length: count }, () => worker()));
  return out;
}

function teamPerspective(match, teamName, pair) {
  if (!pair) return { xG: null, xGA: null };
  const home = teamNameMatches(match.home, teamName);
  return home
    ? { xG: pair.home, xGA: pair.away }
    : { xG: pair.away, xGA: pair.home };
}

function resultSummary(matches, teamName) {
  const out = {
    mac: matches.length,
    galibiyet: 0,
    beraberlik: 0,
    maglubiyet: 0,
    attigiGol: 0,
    yedigiGol: 0,
    ev: { mac: 0, G: 0, B: 0, M: 0, attigi: 0, yedigi: 0 },
    deplasman: { mac: 0, G: 0, B: 0, M: 0, attigi: 0, yedigi: 0 }
  };
  for (const m of matches) {
    const isHome = teamNameMatches(m.home, teamName);
    const gf = Number(isHome ? m.homeScore : m.awayScore);
    const ga = Number(isHome ? m.awayScore : m.homeScore);
    if (!Number.isFinite(gf) || !Number.isFinite(ga)) continue;
    const loc = isHome ? out.ev : out.deplasman;
    loc.mac++;
    loc.attigi += gf;
    loc.yedigi += ga;
    out.attigiGol += gf;
    out.yedigiGol += ga;
    if (gf > ga) { out.galibiyet++; loc.G++; }
    else if (gf === ga) { out.beraberlik++; loc.B++; }
    else { out.maglubiyet++; loc.M++; }
  }
  out.macBasiGol = out.mac ? Number((out.attigiGol / out.mac).toFixed(2)) : null;
  out.macBasiYedigi = out.mac ? Number((out.yedigiGol / out.mac).toFixed(2)) : null;
  return out;
}

function avg(rows, key) {
  const vals = rows.map(x => num(x[key])).filter(x => x != null);
  if (!vals.length) return null;
  return Number((vals.reduce((a,b) => a + b, 0) / vals.length).toFixed(2));
}

function normalizeTableRow(r, i) {
  if (!r || typeof r !== 'object') return null;
  const name = text(r.name ?? r.teamName ?? r.team ?? r.participant ?? r.club);
  if (!name) return null;
  let gf = num(r.goalsFor ?? r.gf ?? r.scoreFor);
  let ga = num(r.goalsAgainst ?? r.ga ?? r.scoreAgainst);
  const scoreStr = r.scoresStr ?? r.scoreStr ?? r.goals;
  if ((gf == null || ga == null) && typeof scoreStr === 'string') {
    const m = scoreStr.match(/(\d+)\s*[-:]\s*(\d+)/);
    if (m) { gf = Number(m[1]); ga = Number(m[2]); }
  }
  return {
    sira: num(r.rank ?? r.position ?? r.pos ?? r.place ?? r.idx) ?? (i + 1),
    takim: name,
    oynadi: num(r.played ?? r.matchesPlayed ?? r.playedGames ?? r.games ?? r.mp),
    G: num(r.wins ?? r.win ?? r.w),
    B: num(r.draws ?? r.draw ?? r.d),
    M: num(r.losses ?? r.loss ?? r.l),
    attigiGol: gf,
    yedigiGol: ga,
    averaj: num(r.goalDifference ?? r.goalDiff ?? r.goalConDiff ?? r.gd),
    puan: num(r.points ?? r.pts ?? r.point)
  };
}

function leagueFromJsons(jsons, teamName) {
  const candidates = [];
  const walk = obj => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj) && obj.length >= 4) {
      const rows = obj.map((r,i) => normalizeTableRow(r,i)).filter(Boolean);
      const usable = rows.filter(r => r.takim && r.puan != null);
      if (usable.length >= 4 && usable.some(r => teamNameMatches(r.takim, teamName))) candidates.push(usable);
    }
    if (Array.isArray(obj)) obj.forEach(walk);
    else Object.values(obj).forEach(v => { if (v && typeof v === 'object') walk(v); });
  };
  jsons.forEach(walk);
  if (!candidates.length) return null;
  candidates.sort((a,b) => {
    const ar = a.find(r => teamNameMatches(r.takim, teamName));
    const br = b.find(r => teamNameMatches(r.takim, teamName));
    const ap = ar?.oynadi ?? -1;
    const bp = br?.oynadi ?? -1;
    if (bp !== ap) return bp - ap;
    return Math.abs(a.length - 16) - Math.abs(b.length - 16);
  });
  const rows = candidates[0].sort((a,b) => a.sira - b.sira);
  const me = rows.find(r => teamNameMatches(r.takim, teamName));
  const leader = rows[0];
  return {
    takim: me?.takim ?? teamName,
    sira: me?.sira ?? null,
    puan: me?.puan ?? null,
    oynadi: me?.oynadi ?? null,
    galibiyet: me?.G ?? null,
    beraberlik: me?.B ?? null,
    maglubiyet: me?.M ?? null,
    attigiGol: me?.attigiGol ?? null,
    yedigiGol: me?.yedigiGol ?? null,
    averaj: me?.averaj ?? null,
    lider: leader?.takim ?? null,
    liderPuan: leader?.puan ?? null,
    liderleFark: me?.puan != null && leader?.puan != null ? leader.puan - me.puan : null
  };
}

function findUnavailable(obj, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj.homeTeam?.unavailable) || Array.isArray(obj.awayTeam?.unavailable)) {
    out.push({
      home: Array.isArray(obj.homeTeam?.unavailable) ? obj.homeTeam.unavailable : [],
      away: Array.isArray(obj.awayTeam?.unavailable) ? obj.awayTeam.unavailable : []
    });
  }
  if (Array.isArray(obj)) obj.forEach(v => findUnavailable(v, out));
  else Object.values(obj).forEach(v => { if (v && typeof v === 'object') findUnavailable(v, out); });
  return out;
}

function cleanUnavailable(players) {
  const map = new Map();
  for (const p of players || []) {
    const key = String(p.id ?? p.name ?? '');
    if (!key || map.has(key)) continue;
    const type = p.unavailability?.type ?? p.type ?? '-';
    const low = String(type).toLowerCase();
    const durum = low.includes('injur') ? 'SAKAT' : low.includes('suspens') ? 'CEZALI' : low.includes('doubt') ? 'SUPHELI' : String(type).toUpperCase();
    map.set(key, {
      id: p.id ?? null,
      ad: p.name ?? '',
      yas: p.age ?? null,
      durum,
      donus: p.unavailability?.expectedReturn ?? p.expectedReturn ?? '-',
      rating: p.performance?.seasonRating ?? null,
      pozisyon: p.positionDescription ?? p.position ?? '-'
    });
  }
  return [...map.values()];
}

async function getUnavailable(browser, matchUrl, matchId) {
  const direct = await fetchFotMobMatchDetails(matchId);
  if (direct) {
    const groups = [];
    findUnavailable(direct, groups);

    if (groups.length) {
      const home = [];
      const away = [];
      groups.forEach(g => {
        home.push(...g.home);
        away.push(...g.away);
      });

      return {
        home: cleanUnavailable(home),
        away: cleanUnavailable(away),
        available: true,
      };
    }
  }

  if (!matchUrl) return { home: [], away: [], available: false };

  const page = await newPage(browser);
  const groups = [];

  page.on('response', async response => {
    try {
      const type = response.headers()['content-type'] || '';
      if (!/json|javascript/i.test(type)) return;
      const body = await response.text();
      if (!/unavailable|injury|suspension/i.test(body)) return;
      const json = JSON.parse(body);
      findUnavailable(json, groups);
    } catch {}
  });

  try {
    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(2200);

    try {
      const scripts = await page.evaluate(collectJsonScripts);
      for (const body of scripts) {
        try { findUnavailable(JSON.parse(body), groups); } catch {}
      }
    } catch {}
  } catch {
  } finally {
    await page.close().catch(() => {});
  }

  const home = [];
  const away = [];
  groups.forEach(g => {
    home.push(...g.home);
    away.push(...g.away);
  });

  return {
    home: cleanUnavailable(home),
    away: cleanUnavailable(away),
    available: groups.length > 0,
  };
}

function upcomingFrom(matches) {
  const now = Date.now();
  return matches
    .filter(m => Number.isFinite(Date.parse(m.date)) && Date.parse(m.date) > now)
    .sort((a,b) => Date.parse(a.date) - Date.parse(b.date))
    .filter((m,i,arr) => arr.findIndex(x => [x.home,x.away,new Date(x.date).toISOString().slice(0,10)].join('|') === [m.home,m.away,new Date(m.date).toISOString().slice(0,10)].join('|')) === i)
    .slice(0,5);
}

function h2hFrom(matches, a, b) {
  return matches
    .filter(m => {
      return (
        teamNameMatches(m.home, a) &&
        teamNameMatches(m.away, b)
      ) || (
        teamNameMatches(m.home, b) &&
        teamNameMatches(m.away, a)
      );
    })
    .filter(isFinished)
    .sort((x,y) => Date.parse(y.date) - Date.parse(x.date))
    .slice(0,4);
}

function teamIdFromUrl(url) {
  try {
    const m = String(url || '').match(/\/teams\/(\d+)/i);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function fetchFotMobTeamData(teamId) {
  if (!Number.isFinite(Number(teamId))) return null;

  const urls = [
    'https://www.fotmob.com/api/data/teams?id=' +
      encodeURIComponent(teamId) +
      '&ccode3=TUR',
    'https://www.fotmob.com/api/teams?id=' +
      encodeURIComponent(teamId),
  ];

  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const r = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': UA,
          'accept': 'application/json,text/plain,*/*',
          'referer': 'https://www.fotmob.com/',
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      if (!r.ok) continue;
      return await r.json();
    } catch {
      // Browser fallback below.
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

async function collectTeamDataSmart(browser, info) {
  const teamId = Number(info.id ?? teamIdFromUrl(info.url));

  if (Number.isFinite(teamId)) {
    const direct = await fetchFotMobTeamData(teamId);

    if (direct) {
      const matches = [];
      scanMatches(direct, info.name, matches);
      const clean = dedupeMatches(matches);

      if (clean.length >= 5) {
        return {
          matches: clean,
          jsons: [direct],
          source: 'direct',
        };
      }
    }
  }

  const fallback = await collectTeamData(browser, info.url, info.name);
  return { ...fallback, source: 'browser' };
}

async function buildTeam(browser, info, opponentName) {
  const { matches, jsons, source } = await collectTeamDataSmart(browser, info);
  const finished = matches.filter(isFinished).sort((a,b) => Date.parse(b.date) - Date.parse(a.date)).slice(0,10);
  const upcoming = upcomingFrom(matches);

  const rows = await mapLimit(finished, 4, async m => {
    const pair = await getMatchXg(browser, m.url, m.id);
    const px = teamPerspective(m, info.name, pair);
    return { ...m, ...px };
  });

  const last5 = rows.slice(0,5);
  const valid5 = last5.filter(x => x.xG != null && x.xGA != null);
  const valid10 = rows.filter(x => x.xG != null && x.xGA != null);

  return {
    takim: info.name,
    son5: {
      sonuc: resultSummary(last5, info.name),
      xGVerisi: valid5.length,
      xG: avg(valid5, 'xG'),
      xGA: avg(valid5, 'xGA')
    },
    son10: {
      sonuc: resultSummary(rows, info.name),
      xGVerisi: valid10.length,
      xG: avg(valid10, 'xG'),
      xGA: avg(valid10, 'xGA')
    },
    maclar: rows.map(m => ({
      tarih: m.date,
      ev: m.home,
      deplasman: m.away,
      evGol: m.homeScore,
      deplasmanGol: m.awayScore,
      xG: m.xG,
      xGA: m.xGA,
      url: m.url,
      id: m.id
    })),
    h2h: h2hFrom(matches, info.name, opponentName).map(m => ({
      tarih: m.date,
      ev: m.home,
      deplasman: m.away,
      evGol: m.homeScore,
      deplasmanGol: m.awayScore
    })),
    sonrakiMaclar: upcoming.map(m => ({
      tarih: m.date,
      ev: m.home,
      deplasman: m.away,
      url: m.url
    })),
    fiksturYogunlugu: {
      sonraki7Gun: upcoming.filter(m => Date.parse(m.date) <= Date.now() + 7 * 86400000).length,
      sonraki14Gun: upcoming.filter(m => Date.parse(m.date) <= Date.now() + 14 * 86400000).length
    },
    ligDurumu: leagueFromJsons(jsons, info.name),
    veriKaynagi: source,
    _allMatches: matches
  };
}

function matchBetweenUpcoming(matches, a, b) {
  return matches
    .filter(m => {
      return (
        teamNameMatches(m.home, a) &&
        teamNameMatches(m.away, b)
      ) || (
        teamNameMatches(m.home, b) &&
        teamNameMatches(m.away, a)
      );
    })
    .filter(m => Number.isFinite(Date.parse(m.date)) && Date.parse(m.date) > Date.now() - 4 * 60 * 60 * 1000)
    .sort((x,y) => Math.abs(Date.parse(x.date) - Date.now()) - Math.abs(Date.parse(y.date) - Date.now()))[0] || null;
}


function foldName(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/ø/g, 'o')
    .replace(/æ/g, 'ae')
    .replace(/å/g, 'a')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function teamNameMatches(a, b) {
  const A = foldName(a);
  const B = foldName(b);

  if (!A || !B) return false;
  if (A === B) return true;

  // FotMob sometimes shortens club names, e.g. Bayer Leverkusen -> Leverkusen.
  if (A.length >= 4 && B.length >= 4 && (A.includes(B) || B.includes(A))) {
    return true;
  }

  const stop = new Set([
    'fc','cf','sc','afc','fk','if','bk','sv','vfl','vfb','rb','ac','as','ssc',
    'club','football','futbol','calcio','united','city'
  ]);

  const ta = A.split(' ').filter(x => x.length > 2 && !stop.has(x));
  const tb = B.split(' ').filter(x => x.length > 2 && !stop.has(x));

  if (!ta.length || !tb.length) return false;

  const small = ta.length <= tb.length ? ta : tb;
  const large = ta.length <= tb.length ? tb : ta;
  const hits = small.filter(x => large.includes(x)).length;

  return hits >= Math.min(2, small.length);
}

function scoreTeamCandidate(candidate, teamName) {
  const target = foldName(teamName);
  const text = foldName(candidate.text);
  const href = foldName(candidate.href);
  if (!target) return 0;
  if (text === target) return 100;
  if (text.startsWith(target) || target.startsWith(text)) return 90;
  if (text.includes(target) || target.includes(text)) return 80;

  const targetParts = target.split(' ').filter(x => x.length > 2);
  const hits = targetParts.filter(x => text.includes(x) || href.includes(x)).length;
  if (targetParts.length && hits === targetParts.length) return 70;
  return hits * 12;
}

async function fotmobSearch(term) {
  const urls = [
    'https://www.fotmob.com/api/data/search/suggest?hits=30&lang=en&term=' + encodeURIComponent(term),
    'https://www.fotmob.com/api/searchData?term=' + encodeURIComponent(term),
  ];

  let lastError = null;

  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    try {
      const r = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': UA,
          'accept': 'application/json,text/plain,*/*',
          'referer': 'https://www.fotmob.com/',
          'accept-language': 'en-US,en;q=0.9',
        },
      });

      if (!r.ok) {
        lastError = new Error('FotMob arama HTTP ' + r.status);
        continue;
      }

      const data = await r.json();
      return data;
    } catch (e) {
      lastError = e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('FotMob arama başarısız.');
}

function collectTeamCandidates(obj, out = [], path = 'root') {
  if (obj == null) return out;

  if (Array.isArray(obj)) {
    obj.forEach((v, i) => collectTeamCandidates(v, out, path + '[' + i + ']'));
    return out;
  }

  if (typeof obj !== 'object') return out;

  const type = foldName(
    obj.type ??
    obj.entityType ??
    obj.suggestionType ??
    obj.category ??
    obj.kind ??
    ''
  );

  const name = String(
    obj.name ??
    obj.teamName ??
    obj.title ??
    obj.label ??
    obj.text ??
    obj.fullName ??
    ''
  ).trim();

  const id =
    num(obj.id) ??
    num(obj.teamId) ??
    num(obj.team_id) ??
    num(obj.entityId) ??
    num(obj.suggestionId);

  const rawUrl = String(
    obj.pageUrl ??
    obj.url ??
    obj.href ??
    obj.link ??
    ''
  );

  const urlTeamMatch = rawUrl.match(/\/teams\/(\d+)(?:\/[^/?#]+)?(?:\/([^/?#]+))?/i);
  const urlId = urlTeamMatch ? Number(urlTeamMatch[1]) : null;

  const teamLike =
    type.includes('team') ||
    Boolean(obj.teamName) ||
    /\/teams\//i.test(rawUrl) ||
    /team/i.test(path);

  if (teamLike && name && (id != null || urlId != null)) {
    out.push({
      id: Number(id ?? urlId),
      name,
      rawUrl,
      path,
    });
  }

  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') {
      collectTeamCandidates(v, out, path + '.' + k);
    }
  }

  return out;
}

function scoreSearchTeam(candidate, teamName) {
  const target = foldName(teamName);
  const name = foldName(candidate.name);
  const url = foldName(candidate.rawUrl);

  if (!target || !name) return -1;
  if (name === target) return 1000;
  if (name.startsWith(target) || target.startsWith(name)) return 900;
  if (name.includes(target) || target.includes(name)) return 800;

  const parts = target.split(' ').filter(x => x.length > 1);
  const hits = parts.filter(x => name.includes(x) || url.includes(x)).length;

  return hits * 100 - Math.abs(name.length - target.length);
}

async function resolveTeamUrl(browser, teamName) {
  const data = await fotmobSearch(teamName);
  const candidates = collectTeamCandidates(data);

  candidates.sort(
    (a, b) => scoreSearchTeam(b, teamName) - scoreSearchTeam(a, teamName)
  );

  const best = candidates.find(x => scoreSearchTeam(x, teamName) >= 100);
  if (!best) {
    throw new Error('FotMob takım sayfası bulunamadı: ' + teamName);
  }

  let slug = foldName(best.name).replace(/\s+/g, '-');

  if (best.rawUrl) {
    const m = best.rawUrl.match(/\/teams\/\d+(?:\/[^/?#]+)?(?:\/([^/?#]+))?/i);
    if (m?.[1]) slug = m[1];
  }

  return 'https://www.fotmob.com/teams/' + best.id + '/fixtures/' + slug;
}


function matchupRowsFromSearch(data, homeName, awayName, homeId, awayId) {
  const out = [];

  const walk = obj => {
    if (!obj || typeof obj !== 'object') return;

    if (obj.type === 'match') {
      const hId = num(obj.homeTeamId);
      const aId = num(obj.awayTeamId);
      const hName = String(obj.homeTeamName || '');
      const aName = String(obj.awayTeamName || '');

      const idsKnown =
        Number.isFinite(Number(homeId)) &&
        Number.isFinite(Number(awayId));

      const idsMatch = idsKnown && (
        (hId === Number(homeId) && aId === Number(awayId)) ||
        (hId === Number(awayId) && aId === Number(homeId))
      );

      const namesMatch = (
        teamNameMatches(hName, homeName) &&
        teamNameMatches(aName, awayName)
      ) || (
        teamNameMatches(hName, awayName) &&
        teamNameMatches(aName, homeName)
      );

      if (idsMatch || namesMatch) {
        const scoreStr = String(obj.status?.scoreStr || '');
        const sm = scoreStr.match(/(\d+)\s*[-:]\s*(\d+)/);
        out.push({
          id: num(obj.id),
          home: hName,
          away: aName,
          date: String(obj.matchDate ?? obj.status?.utcTime ?? ''),
          homeScore:
            num(obj.homeTeamScore) ??
            (sm ? Number(sm[1]) : null),
          awayScore:
            num(obj.awayTeamScore) ??
            (sm ? Number(sm[2]) : null),
          status: obj.status ?? null,
          url: null,
        });
      }
    }

    if (Array.isArray(obj)) {
      obj.forEach(walk);
    } else {
      Object.values(obj).forEach(v => {
        if (v && typeof v === 'object') walk(v);
      });
    }
  };

  walk(data);

  const seen = new Set();
  return out.filter(m => {
    const key = String(m.id ?? [m.home, m.away, m.date].join('|'));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchMatchupData(
  homeName,
  awayName,
  homeId,
  awayId,
) {
  try {
    const data = await fotmobSearch(homeName + ' ' + awayName);
    const rows = matchupRowsFromSearch(
      data,
      homeName,
      awayName,
      homeId,
      awayId,
    );

    const finished = rows
      .filter(m => {
        const done =
          m.status?.finished === true ||
          /^(?:FT|AET|PEN)$/i.test(
            String(m.status?.reason?.short || '')
          );
        return done && m.homeScore != null && m.awayScore != null;
      })
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, 4);

    const target = rows
      .filter(m =>
        Number.isFinite(Date.parse(m.date)) &&
        Date.parse(m.date) > Date.now() - 4 * 60 * 60 * 1000
      )
      .sort(
        (a, b) =>
          Math.abs(Date.parse(a.date) - Date.now()) -
          Math.abs(Date.parse(b.date) - Date.now())
      )[0] || null;

    return { finished, target };
  } catch {
    return { finished: [], target: null };
  }
}

async function buildPerformancePackage({ home, away }) {
  if (!home?.name || !away?.name) {
    throw new Error('home/away takım adı gerekli.');
  }

  const cacheKey = JSON.stringify([home.name, home.url || '', away.name, away.url || '']);
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.data, cache: true };

  const browser = await launchBrowser();
  try {
    const homeInfo = {
      name: home.name,
      url: home.url || await resolveTeamUrl(browser, home.name),
    };
    const awayInfo = {
      name: away.name,
      url: away.url || await resolveTeamUrl(browser, away.name),
    };

    for (const x of [homeInfo.url, awayInfo.url]) {
      const u = new URL(x);
      if (!/(^|\.)fotmob\.com$/i.test(u.hostname)) {
        throw new Error('Yalnız FotMob URL kabul edilir.');
      }
    }

    const resolvedCacheKey = JSON.stringify([homeInfo.name, homeInfo.url, awayInfo.name, awayInfo.url]);
    const resolvedHit = cache.get(resolvedCacheKey);
    if (resolvedHit && Date.now() - resolvedHit.at < CACHE_MS) {
      return { ...resolvedHit.data, cache: true };
    }

    const homeId = teamIdFromUrl(homeInfo.url);
    const awayId = teamIdFromUrl(awayInfo.url);

    const matchup = await fetchMatchupData(
      homeInfo.name,
      awayInfo.name,
      homeId,
      awayId,
    );

    const homePack = await buildTeam(browser, homeInfo, awayInfo.name);
    const awayPack = await buildTeam(browser, awayInfo, homeInfo.name);

    const targetMatch =
      matchBetweenUpcoming(homePack._allMatches, homeInfo.name, awayInfo.name) ||
      matchBetweenUpcoming(awayPack._allMatches, homeInfo.name, awayInfo.name) ||
      matchup.target;

    const unavailable = await getUnavailable(browser, targetMatch?.url, targetMatch?.id);

    const homeIsMatchHome = targetMatch
      ? teamNameMatches(targetMatch.home, homeInfo.name)
      : true;

    homePack.eksikler = homeIsMatchHome ? unavailable.home : unavailable.away;
    awayPack.eksikler = homeIsMatchHome ? unavailable.away : unavailable.home;
    homePack.eksikVerisi = unavailable.available === true;
    awayPack.eksikVerisi = unavailable.available === true;

    delete homePack._allMatches;
    delete awayPack._allMatches;

    const h2h = matchup.finished.length
      ? matchup.finished.map(m => ({
          tarih: m.date,
          ev: m.home,
          deplasman: m.away,
          evGol: m.homeScore,
          deplasmanGol: m.awayScore,
        }))
      : (homePack.h2h?.length ? homePack.h2h : awayPack.h2h);

    const data = {
      mac: targetMatch ? {
        ev: targetMatch.home,
        deplasman: targetMatch.away,
        tarih: targetMatch.date,
        url: targetMatch.url,
        id: targetMatch.id ?? null
      } : {
        ev: homeInfo.name,
        deplasman: awayInfo.name,
        tarih: null,
        url: null
      },
      evTakimi: homePack,
      deplasmanTakimi: awayPack,
      h2h: { bulunan: h2h.length, hedef: 4, maclar: h2h },
      meta: {
        kaynak: 'FotMob',
        olusturmaZamani: new Date().toISOString(),
        homeUrl: homeInfo.url,
        awayUrl: awayInfo.url,
        engineVersion: 3,
      },
      cache: false
    };

    cache.set(cacheKey, { at: Date.now(), data });
    cache.set(resolvedCacheKey, { at: Date.now(), data });
    return data;
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { buildPerformancePackage };
