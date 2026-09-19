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
    if (h.includes(target) || a.includes(target)) {
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
      scanMatches(json, target, matches);
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
          scanMatches(json, target, matches);
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

async function getMatchXg(browser, url) {
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      const scripts = await page.evaluate(collectJsonScripts);
      for (const body of scripts) {
        try { inspect(JSON.parse(body)); } catch {}
        if (settled) break;
      }
    } catch {}
    return await Promise.race([found, sleep(5000).then(() => null)]);
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

function teamPerspective(match, teamName, pair) {
  if (!pair) return { xG: null, xGA: null };
  const target = normalizeName(teamName);
  const home = normalizeName(match.home).includes(target);
  return home ? { xG: pair.home, xGA: pair.away } : { xG: pair.away, xGA: pair.home };
}

function resultSummary(matches, teamName) {
  const target = normalizeName(teamName);
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
    const isHome = normalizeName(m.home).includes(target);
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
  const target = normalizeName(teamName);
  const candidates = [];
  const walk = obj => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj) && obj.length >= 4) {
      const rows = obj.map((r,i) => normalizeTableRow(r,i)).filter(Boolean);
      const usable = rows.filter(r => r.takim && r.puan != null);
      if (usable.length >= 4 && usable.some(r => normalizeName(r.takim).includes(target))) candidates.push(usable);
    }
    if (Array.isArray(obj)) obj.forEach(walk);
    else Object.values(obj).forEach(v => { if (v && typeof v === 'object') walk(v); });
  };
  jsons.forEach(walk);
  if (!candidates.length) return null;
  candidates.sort((a,b) => {
    const ar = a.find(r => normalizeName(r.takim).includes(target));
    const br = b.find(r => normalizeName(r.takim).includes(target));
    const ap = ar?.oynadi ?? -1;
    const bp = br?.oynadi ?? -1;
    if (bp !== ap) return bp - ap;
    return Math.abs(a.length - 16) - Math.abs(b.length - 16);
  });
  const rows = candidates[0].sort((a,b) => a.sira - b.sira);
  const me = rows.find(r => normalizeName(r.takim).includes(target));
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

async function getUnavailable(browser, matchUrl) {
  if (!matchUrl) return { home: [], away: [] };
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
    await page.goto(matchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3500);
    try {
      const scripts = await page.evaluate(collectJsonScripts);
      for (const body of scripts) {
        try { findUnavailable(JSON.parse(body), groups); } catch {}
      }
    } catch {}
  } catch {}
  finally { await page.close().catch(() => {}); }

  const home = [], away = [];
  groups.forEach(g => { home.push(...g.home); away.push(...g.away); });
  return { home: cleanUnavailable(home), away: cleanUnavailable(away) };
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
  const A = normalizeName(a), B = normalizeName(b);
  return matches
    .filter(m => {
      const h = normalizeName(m.home), aw = normalizeName(m.away);
      return (h.includes(A) && aw.includes(B)) || (h.includes(B) && aw.includes(A));
    })
    .filter(isFinished)
    .sort((x,y) => Date.parse(y.date) - Date.parse(x.date))
    .slice(0,4);
}

async function buildTeam(browser, info, opponentName) {
  const { matches, jsons } = await collectTeamData(browser, info.url, info.name);
  const finished = matches.filter(isFinished).sort((a,b) => Date.parse(b.date) - Date.parse(a.date)).slice(0,10);
  const upcoming = upcomingFrom(matches);

  const rows = [];
  for (const m of finished) {
    const pair = await getMatchXg(browser, m.url);
    const px = teamPerspective(m, info.name, pair);
    rows.push({ ...m, ...px });
    await sleep(350);
  }

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
      url: m.url
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
    _allMatches: matches
  };
}

function matchBetweenUpcoming(matches, a, b) {
  const A = normalizeName(a), B = normalizeName(b);
  return matches
    .filter(m => {
      const h = normalizeName(m.home), aw = normalizeName(m.away);
      return (h.includes(A) && aw.includes(B)) || (h.includes(B) && aw.includes(A));
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

async function resolveTeamUrl(browser, teamName) {
  const page = await newPage(browser);
  const candidates = [];

  page.on('response', async response => {
    try {
      const type = response.headers()['content-type'] || '';
      if (!/json|javascript/i.test(type)) return;
      const body = await response.text();
      if (!foldName(body).includes(foldName(teamName))) return;

      const re = /(?:https?:\\/\\/www\\.fotmob\\.com)?(\\/(?:[a-z]{2}\\/)?teams\\/\\d+\\/(?:overview|fixtures|table|squad|stats)?\\/?[^"'\\s<]*)/gi;
      let m;
      while ((m = re.exec(body))) {
        candidates.push({
          href: 'https://www.fotmob.com' + m[1].replace(/^\\/[a-z]{2}(?=\\/teams\\/)/, ''),
          text: teamName,
        });
      }
    } catch {}
  });

  try {
    const searchUrl = 'https://www.fotmob.com/search?q=' + encodeURIComponent(teamName);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);

    const dom = await page.evaluate(() => {
      return [...document.querySelectorAll('a[href*="/teams/"]')].map(a => ({
        href: a.getAttribute('href') || '',
        text: (a.textContent || '').trim(),
      }));
    }).catch(() => []);

    for (const x of dom) {
      let href = String(x.href || '');
      if (!href) continue;
      if (href.startsWith('/')) href = 'https://www.fotmob.com' + href;
      try {
        const u = new URL(href);
        if (!/(^|\\.)fotmob\\.com$/i.test(u.hostname)) continue;
        const mm = u.pathname.match(/\\/teams\\/(\\d+)(?:\\/[^/]+)?(?:\\/([^/?#]+))?/i);
        if (!mm) continue;
        const id = mm[1];
        const slug = mm[2] || foldName(teamName).replace(/\\s+/g, '-');
        candidates.push({
          href: 'https://www.fotmob.com/teams/' + id + '/fixtures/' + slug,
          text: x.text || '',
        });
      } catch {}
    }

    candidates.sort((a, b) => scoreTeamCandidate(b, teamName) - scoreTeamCandidate(a, teamName));
    const best = candidates.find(x => scoreTeamCandidate(x, teamName) >= 24);
    if (!best) throw new Error('FotMob takım sayfası bulunamadı: ' + teamName);

    const u = new URL(best.href);
    const mm = u.pathname.match(/\\/teams\\/(\\d+)(?:\\/[^/]+)?(?:\\/([^/?#]+))?/i);
    if (!mm) throw new Error('FotMob takım adresi çözülemedi: ' + teamName);

    return 'https://www.fotmob.com/teams/' + mm[1] + '/fixtures/' +
      (mm[2] || foldName(teamName).replace(/\\s+/g, '-'));
  } finally {
    await page.close().catch(() => {});
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

    const homePack = await buildTeam(browser, homeInfo, awayInfo.name);
    const awayPack = await buildTeam(browser, awayInfo, homeInfo.name);

    const targetMatch =
      matchBetweenUpcoming(homePack._allMatches, homeInfo.name, awayInfo.name) ||
      matchBetweenUpcoming(awayPack._allMatches, homeInfo.name, awayInfo.name);

    const unavailable = await getUnavailable(browser, targetMatch?.url);

    const homeIsMatchHome = targetMatch
      ? normalizeName(targetMatch.home).includes(normalizeName(homeInfo.name))
      : true;

    homePack.eksikler = homeIsMatchHome ? unavailable.home : unavailable.away;
    awayPack.eksikler = homeIsMatchHome ? unavailable.away : unavailable.home;

    delete homePack._allMatches;
    delete awayPack._allMatches;

    const h2h = homePack.h2h?.length ? homePack.h2h : awayPack.h2h;

    const data = {
      mac: targetMatch ? {
        ev: targetMatch.home,
        deplasman: targetMatch.away,
        tarih: targetMatch.date,
        url: targetMatch.url
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
