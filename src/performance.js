const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/snap/bin/chromium',
  '/data/data/com.termux/files/usr/bin/chromium-browser'
].filter(Boolean);

const CHROME = CHROME_CANDIDATES.find(candidate => {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}) || CHROME_CANDIDATES[0];

const UA = 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';
const CACHE_MS = Number(process.env.PERFORMANCE_CACHE_MS || 20 * 60 * 1000);
const MAX_CACHE_ENTRIES_RAW = Number(process.env.PERFORMANCE_CACHE_MAX_ENTRIES || 128);
const MAX_CACHE_ENTRIES = Number.isInteger(MAX_CACHE_ENTRIES_RAW) && MAX_CACHE_ENTRIES_RAW > 0
  ? MAX_CACHE_ENTRIES_RAW
  : 128;
const cache = new Map();

function performanceCacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= CACHE_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function performanceCacheSet(key, data) {
  const now = Date.now();
  for (const [existingKey, existing] of cache) {
    if (now - existing.at >= CACHE_MS) cache.delete(existingKey);
  }
  cache.delete(key);
  cache.set(key, { at: now, data });
  while (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

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

function scanMatches(obj, target, out, path = 'root', targetId = null) {
  if (!obj || typeof obj !== 'object') return;
  const homeObj = obj.home ?? obj.homeTeam ?? obj.team1 ?? obj.participants?.[0];
  const awayObj = obj.away ?? obj.awayTeam ?? obj.team2 ?? obj.participants?.[1];
  const home = text(homeObj);
  const away = text(awayObj);

  if (home && away) {
    const h = normalizeName(home);
    const a = normalizeName(away);
    const homeId = Number(
      homeObj?.id ?? obj.homeTeamId ?? obj.home_team_id ?? obj.homeId
    );
    const awayId = Number(
      awayObj?.id ?? obj.awayTeamId ?? obj.away_team_id ?? obj.awayId
    );
    const targetNum = Number(targetId);
    const idMatches =
      Number.isFinite(targetNum) &&
      (homeId === targetNum || awayId === targetNum);
    if (
      idMatches ||
      teamNameMatches(home, target) ||
      teamNameMatches(away, target)
    ) {
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
    obj.forEach((v, i) => scanMatches(v, target, out, path + '[' + i + ']', targetId));
  } else {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') scanMatches(v, target, out, path + '.' + k, targetId);
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
    executablePath: CHROME,
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


function statNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const m = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function normalizeStatKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findFotMobStatPair(details, aliases) {
  const groups =
    details?.content?.stats?.Periods?.All?.stats;
  if (!Array.isArray(groups)) return null;

  const wanted = new Set(aliases.map(normalizeStatKey));
  for (const group of groups) {
    for (const item of group?.stats || []) {
      const key = normalizeStatKey(item?.key);
      const title = normalizeStatKey(item?.title);
      if (!wanted.has(key) && !wanted.has(title)) continue;
      const values = item?.stats;
      if (!Array.isArray(values) || values.length < 2) continue;
      const pair = {
        home: statNumber(values[0]),
        away: statNumber(values[1])
      };
      if (pair.home == null && pair.away == null) continue;
      return pair;
    }
  }
  return null;
}

function extractFotMobStandardStats(details) {
  const definitions = {
    shots: ['total_shots', 'total shots'],
    shotsOnTarget: ['ShotsOnTarget', 'shots on target'],
    shotsInsideBox: ['shots_inside_box', 'shots inside box'],
    bigChances: ['big_chance', 'big chances'],
    corners: ['corners'],
    possession: ['BallPossesion', 'ball possession'],
    yellowCards: ['yellow_cards', 'yellow cards'],
    redCards: ['red_cards', 'red cards'],
    touchesOppBox: ['touches_opp_box', 'touches in opposition box'],
    passes: ['passes'],
    accuratePasses: ['accurate_passes', 'accurate passes'],
    ownHalfPasses: ['own_half_passes', 'own half'],
    oppositionHalfPasses: ['opposition_half_passes', 'opposition half'],
    tackles: ['matchstats.headers.tackles', 'tackles'],
    interceptions: ['interceptions'],
    shotBlocks: ['shot_blocks'],
    clearances: ['clearances'],
    duelsWon: ['duel_won', 'duels won'],
    groundDuelsWon: ['ground_duels_won', 'ground duels won'],
    aerialDuelsWon: ['aerials_won', 'aerial duels won'],
    successfulDribbles: ['dribbles_succeeded', 'successful dribbles'],
    accurateLongBalls: ['long_balls_accurate', 'accurate long balls'],
    accurateCrosses: ['accurate_crosses', 'accurate crosses'],
    keeperSaves: ['keeper_saves', 'keeper saves']
  };

  const out = {};
  let found = 0;
  for (const [key, aliases] of Object.entries(definitions)) {
    const pair = findFotMobStatPair(details, aliases);
    out[key] = pair;
    if (pair && (pair.home != null || pair.away != null)) found++;
  }
  return found ? out : null;
}


function compactLineupPlayer(player) {
  if (!player || typeof player !== 'object') return null;
  const performance = player.performance || {};
  return {
    id: player.id ?? null,
    name: player.name ?? null,
    shirtNumber: player.shirtNumber ?? null,
    positionId: player.positionId ?? null,
    usualPlayingPositionId: player.usualPlayingPositionId ?? null,
    age: num(player.age),
    country: player.countryName ?? null,
    marketValue: num(player.marketValue),
    rating: num(performance.rating),
    playerOfTheMatch: performance.playerOfTheMatch === true,
    substitutionEvents: Array.isArray(performance.substitutionEvents)
      ? performance.substitutionEvents.map(event => ({
          time: num(event?.time),
          type: event?.type ?? null,
          reason: event?.reason ?? null
        }))
      : []
  };
}

function compactUnavailablePlayer(player) {
  if (!player || typeof player !== 'object') return null;
  return {
    id: player.id ?? null,
    name: player.name ?? null,
    reason: player.reason ?? player.type ?? player.status ?? null,
    expectedReturn: player.expectedReturn ?? player.returnDate ?? null,
    positionId: player.positionId ?? player.usualPlayingPositionId ?? null
  };
}

function findFotMobPlayerStat(player, statKey) {
  for (const group of player?.stats || []) {
    const stats = group?.stats;
    if (!stats || typeof stats !== 'object') continue;
    for (const entry of Object.values(stats)) {
      if (!entry || typeof entry !== 'object') continue;
      if (String(entry.key || '') !== statKey) continue;
      const stat = entry.stat || {};
      return {
        found: true,
        value: num(stat.value)
      };
    }
  }
  return { found: false, value: null };
}

function extractFotMobPlayerProgression(details, info) {
  const playerStats = details?.content?.playerStats;
  if (!playerStats || typeof playerStats !== 'object') return null;

  const targetId = Number(info?.id ?? teamIdFromUrl(info?.url));
  const candidates = Object.values(playerStats).filter(player => {
    if (!player || typeof player !== 'object') return false;
    if (Number.isFinite(targetId) && Number(player.teamId) === targetId) return true;
    return !Number.isFinite(targetId) &&
      info?.name &&
      teamNameMatches(player.teamName, info.name);
  });

  const played = [];
  for (const player of candidates) {
    const minutes = findFotMobPlayerStat(player, 'minutes_played');
    if (!minutes.found || minutes.value == null || minutes.value <= 0) continue;

    const finalThird = findFotMobPlayerStat(player, 'passes_into_final_third');
    played.push({
      id: player.id ?? null,
      name: player.name ?? null,
      teamId: player.teamId ?? null,
      teamName: player.teamName ?? info?.name ?? null,
      minutesPlayed: minutes.value,
      passesIntoFinalThird:
        finalThird.found && finalThird.value != null ? finalThird.value : null
    });
  }

  if (played.length === 0) return null;

  const playersWithData = played.filter(
    player => player.passesIntoFinalThird != null
  ).length;
  const missingPlayedPlayers = played.length - playersWithData;
  const complete = missingPlayedPlayers === 0;
  const teamTotal = complete
    ? played.reduce((sum, player) => sum + player.passesIntoFinalThird, 0)
    : null;

  return {
    source: 'FotMob',
    basis: 'match-details-player-stats',
    teamId: Number.isFinite(targetId) ? targetId : (played[0]?.teamId ?? null),
    teamName: played[0]?.teamName ?? info?.name ?? null,
    playedPlayers: played.length,
    playersWithData,
    missingPlayedPlayers,
    complete,
    teamTotal,
    players: played,
    provenance: {
      minutesPlayed:
        'FotMob.matchDetails.content.playerStats.*.stats.minutes_played',
      passesIntoFinalThird:
        'FotMob.matchDetails.content.playerStats.*.stats.attack.passes_into_final_third'
    }
  };
}

function extractFotMobTeamLineup(details, info) {
  const lineup = details?.content?.lineup;
  if (!lineup || typeof lineup !== 'object') return null;

  const targetId = Number(info?.id ?? teamIdFromUrl(info?.url));
  const candidates = [lineup.homeTeam, lineup.awayTeam].filter(Boolean);
  let team = null;

  if (Number.isFinite(targetId)) {
    team = candidates.find(candidate => Number(candidate?.id) === targetId) || null;
  }
  if (!team && info?.name) {
    team = candidates.find(candidate =>
      teamNameMatches(candidate?.name, info.name)
    ) || null;
  }

  const starters = (team?.starters || [])
    .map(compactLineupPlayer)
    .filter(Boolean);
  if (!team || starters.length === 0) return null;

  const subs = (team.subs || [])
    .map(compactLineupPlayer)
    .filter(Boolean);
  const unavailable = (team.unavailable || [])
    .map(compactUnavailablePlayer)
    .filter(Boolean);
  const coach = team.coach && typeof team.coach === 'object'
    ? {
        id: team.coach.id ?? null,
        name: team.coach.name ?? null,
        age: num(team.coach.age),
        country: team.coach.countryName ?? null
      }
    : null;

  return {
    teamName: team.name ?? info?.name ?? null,
    formation: team.formation ?? null,
    teamRating: num(team.rating),
    averageStarterAge: num(team.averageStarterAge),
    totalStarterMarketValue: num(team.totalStarterMarketValue),
    coach,
    starters,
    subs,
    unavailable
  };
}


function fotMobEventMinute(event) {
  const base = num(event?.time);
  if (base == null) return null;
  const added = num(event?.overloadTime) ?? 0;
  return base + added;
}

function extractFotMobRedCardContext(details, match, teamName, redCardStat) {
  const rawEvents =
    details?.content?.matchFacts?.events?.events ??
    details?.content?.matchFacts?.events ??
    [];
  const events = Array.isArray(rawEvents) ? rawEvents : [];

  const isHome = teamNameMatches(match?.home, teamName);
  const isAway = teamNameMatches(match?.away, teamName);
  if (!isHome && !isAway) return null;

  const redCards = num(redCardStat);
  if (redCards == null) return null;

  const redEvents = events
    .filter(event =>
      String(event?.type || '').toLowerCase() === 'card' &&
      String(event?.card || '').toLowerCase() === 'red' &&
      Boolean(event?.isHome) === isHome
    )
    .map(event => ({
      minute: fotMobEventMinute(event),
      displayMinute: event?.timeStr ?? null,
      playerId: event?.playerId ?? event?.player?.id ?? null,
      playerName: event?.fullName ?? event?.nameStr ?? event?.player?.name ?? null
    }))
    .filter(event => event.minute != null)
    .sort((a, b) => a.minute - b.minute);

  if (redCards === 0) {
    return {
      source: 'FotMob',
      status: 'verified-no-red',
      redCards: 0,
      firstRedMinute: null,
      shortHandedMinutes: 0,
      events: []
    };
  }

  if (redEvents.length !== redCards) {
    return {
      source: 'FotMob',
      status: 'event-time-missing',
      redCards,
      firstRedMinute: null,
      shortHandedMinutes: null,
      events: redEvents
    };
  }

  const allEventMinutes = events
    .map(fotMobEventMinute)
    .filter(value => value != null);
  const durationMinutes = Math.max(90, ...allEventMinutes);
  const firstRedMinute = redEvents[0].minute;

  return {
    source: 'FotMob',
    status: 'verified-event',
    redCards,
    durationMinutes,
    firstRedMinute,
    shortHandedMinutes: Number(
      Math.max(0, durationMinutes - firstRedMinute).toFixed(2)
    ),
    events: redEvents
  };
}

function summarizeRedCardContext(rows) {
  const contexts = rows
    .map(row => row?.redCardContext)
    .filter(Boolean);
  const verified = contexts.filter(context =>
    finiteNumber(context?.shortHandedMinutes)
  );
  const unverifiedRed = contexts.filter(context =>
    (context?.redCards || 0) > 0 &&
    !finiteNumber(context?.shortHandedMinutes)
  );

  return {
    dataMatches: verified.length,
    redCardMatches: verified.filter(context => (context.redCards || 0) > 0).length,
    unverifiedRedCardMatches: unverifiedRed.length,
    shortHandedMinutes: Number(
      verified.reduce(
        (sum, context) => sum + context.shortHandedMinutes,
        0
      ).toFixed(2)
    )
  };
}

function teamStandardPerspective(match, teamName, stats) {
  const home = teamNameMatches(match.home, teamName);
  const own = pair => pair ? (home ? pair.home : pair.away) : null;
  const opp = pair => pair ? (home ? pair.away : pair.home) : null;

  return {
    shots: own(stats?.shots),
    shotsAllowed: opp(stats?.shots),
    shotsOnTarget: own(stats?.shotsOnTarget),
    shotsOnTargetAllowed: opp(stats?.shotsOnTarget),
    shotsInsideBox: own(stats?.shotsInsideBox),
    shotsInsideBoxAllowed: opp(stats?.shotsInsideBox),
    bigChances: own(stats?.bigChances),
    bigChancesAllowed: opp(stats?.bigChances),
    corners: own(stats?.corners),
    cornersAllowed: opp(stats?.corners),
    possession: own(stats?.possession),
    yellowCards: own(stats?.yellowCards),
    redCards: own(stats?.redCards),
    touchesOppBox: own(stats?.touchesOppBox),
    touchesOppBoxAllowed: opp(stats?.touchesOppBox),
    passes: own(stats?.passes),
    accuratePasses: own(stats?.accuratePasses),
    ownHalfPasses: own(stats?.ownHalfPasses),
    oppositionHalfPasses: own(stats?.oppositionHalfPasses),
    tackles: own(stats?.tackles),
    interceptions: own(stats?.interceptions),
    shotBlocks: own(stats?.shotBlocks),
    clearances: own(stats?.clearances),
    duelsWon: own(stats?.duelsWon),
    groundDuelsWon: own(stats?.groundDuelsWon),
    aerialDuelsWon: own(stats?.aerialDuelsWon),
    successfulDribbles: own(stats?.successfulDribbles),
    accurateLongBalls: own(stats?.accurateLongBalls),
    accurateCrosses: own(stats?.accurateCrosses),
    keeperSaves: own(stats?.keeperSaves)
  };
}

function derivedPassAccuracy(standard) {
  const passes = num(standard?.passes);
  const accuratePasses = num(standard?.accuratePasses);

  if (
    passes == null ||
    accuratePasses == null ||
    passes <= 0 ||
    accuratePasses < 0 ||
    accuratePasses > passes
  ) {
    return null;
  }

  return Number(((accuratePasses / passes) * 100).toFixed(2));
}

function verifiedKeeperSavePercentage(match, teamName, standard) {
  const isHome = teamNameMatches(match?.home, teamName);
  const isAway = teamNameMatches(match?.away, teamName);
  if (!isHome && !isAway) return null;

  const keeperSaves = num(standard?.keeperSaves);
  const shotsOnTargetAllowed = num(standard?.shotsOnTargetAllowed);
  const goalsAgainst = num(isHome ? match?.awayScore : match?.homeScore);

  if (
    keeperSaves == null ||
    shotsOnTargetAllowed == null ||
    goalsAgainst == null ||
    shotsOnTargetAllowed <= 0 ||
    keeperSaves + goalsAgainst !== shotsOnTargetAllowed
  ) {
    return null;
  }

  return Number(((keeperSaves / shotsOnTargetAllowed) * 100).toFixed(1));
}

function standardStatsSummary(rows) {
  const keys = [
    'shots',
    'shotsAllowed',
    'shotsOnTarget',
    'shotsOnTargetAllowed',
    'shotsInsideBox',
    'shotsInsideBoxAllowed',
    'bigChances',
    'bigChancesAllowed',
    'corners',
    'cornersAllowed',
    'possession',
    'yellowCards',
    'redCards',
    'touchesOppBox',
    'touchesOppBoxAllowed',
    'passes',
    'accuratePasses',
    'ownHalfPasses',
    'oppositionHalfPasses',
    'tackles',
    'interceptions',
    'shotBlocks',
    'clearances',
    'duelsWon',
    'groundDuelsWon',
    'aerialDuelsWon',
    'successfulDribbles',
    'accurateLongBalls',
    'accurateCrosses',
    'keeperSaves'
  ];
  const out = {};
  for (const key of keys) out[key] = avg(rows, key);
  out.keeperSavesDataMatches = rows.filter(
    row => num(row?.keeperSaves) != null
  ).length;
  out.savePercentage = avg(rows, 'savePercentage');
  out.savePercentageDataMatches = rows.filter(
    row => num(row?.savePercentage) != null
  ).length;
  out.passAccuracy = avg(rows, 'passAccuracy');
  out.passAccuracyDataMatches = rows.filter(
    row => num(row?.passAccuracy) != null
  ).length;
  out.veriMac = rows.filter(row =>
    keys.some(key => num(row?.[key]) != null)
  ).length;
  return out;
}

async function getMatchXg(browser, url, matchId, directDetails = null) {
  const direct = directDetails || await fetchFotMobMatchDetails(matchId);
  if (direct) {
    const rows = findExpectedGoals(direct);
    return rows.length ? rows[0] : null;
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

function upcomingFrom(matches, referenceMs = Date.now()) {
  const now = Number.isFinite(referenceMs) ? referenceMs : Date.now();
  return matches
    .filter(m => Number.isFinite(Date.parse(m.date)) && Date.parse(m.date) > now)
    .sort((a,b) => Date.parse(a.date) - Date.parse(b.date))
    .filter((m,i,arr) => arr.findIndex(x => [x.home,x.away,new Date(x.date).toISOString().slice(0,10)].join('|') === [m.home,m.away,new Date(m.date).toISOString().slice(0,10)].join('|')) === i)
    .slice(0,5);
}

function h2hFrom(matches, a, b, referenceMs = Date.now()) {
  const cutoff = Number.isFinite(referenceMs) ? referenceMs : Date.now();
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
    .filter(m =>
      Number.isFinite(Date.parse(m.date)) &&
      Date.parse(m.date) < cutoff &&
      isFinished(m, cutoff)
    )
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
      scanMatches(direct, info.name, matches, 'root', teamId);
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


function playerIdentity(player) {
  if (!player) return null;
  if (player.id != null) return 'id:' + String(player.id);
  const name = normalizeName(player.name || '');
  return name ? 'name:' + name : null;
}

function buildPlayerFormFromLineups(lineupRows) {
  const recent = lineupRows.slice(0, 5);
  const players = new Map();

  recent.forEach((row, matchIndex) => {
    const lineup = row?.lineup;
    const groups = [
      ['starter', lineup?.starters || []],
      ['sub', lineup?.subs || []]
    ];

    for (const [role, list] of groups) {
      for (const player of list) {
        const key = playerIdentity(player);
        if (!key) continue;

        if (!players.has(key)) {
          players.set(key, {
            id: player.id ?? null,
            name: player.name ?? null,
            shirtNumber: player.shirtNumber ?? null,
            usualPlayingPositionId: player.usualPlayingPositionId ?? null,
            appearances: 0,
            starts: 0,
            subAppearances: 0,
            playerOfTheMatch: 0,
            ratings: [],
            recent: []
          });
        }

        const target = players.get(key);
        target.appearances++;
        if (role === 'starter') target.starts++;
        else target.subAppearances++;
        if (player.playerOfTheMatch === true) target.playerOfTheMatch++;
        if (finiteNumber(player.rating)) target.ratings.push(player.rating);
        target.recent.push({
          matchIndex,
          date: row.date,
          opponent: teamNameMatches(row.home, row?.lineup?.teamName)
            ? row.away
            : row.home,
          role,
          rating: finiteNumber(player.rating) ? player.rating : null,
          playerOfTheMatch: player.playerOfTheMatch === true
        });
      }
    }
  });

  const rows = [...players.values()].map(player => ({
    id: player.id,
    name: player.name,
    shirtNumber: player.shirtNumber,
    usualPlayingPositionId: player.usualPlayingPositionId,
    appearances: player.appearances,
    starts: player.starts,
    subAppearances: player.subAppearances,
    startRate: recent.length
      ? Number((player.starts / recent.length).toFixed(2))
      : null,
    averageRating: player.ratings.length
      ? Number(
          (
            player.ratings.reduce((sum, value) => sum + value, 0) /
            player.ratings.length
          ).toFixed(2)
        )
      : null,
    ratingMatches: player.ratings.length,
    playerOfTheMatch: player.playerOfTheMatch,
    recent: player.recent
  }));

  rows.sort((a, b) =>
    b.starts - a.starts ||
    (b.averageRating ?? -1) - (a.averageRating ?? -1) ||
    String(a.name || '').localeCompare(String(b.name || ''))
  );

  return {
    dataMatches: recent.length,
    players: rows
  };
}

function buildXiContinuityFromLineups(lineupRows) {
  const recent = lineupRows.slice(0, 5);
  const latest = recent[0]?.lineup?.starters || [];
  const latestIds = new Set(latest.map(playerIdentity).filter(Boolean));

  if (latestIds.size === 0) {
    return {
      dataMatches: recent.length,
      latestXiSize: 0,
      averageRetainedFromLatest: null,
      minRetainedFromLatest: null,
      maxRetainedFromLatest: null,
      exactSameXiMatches: null,
      uniqueStarters: null,
      matches: []
    };
  }

  const comparisons = recent.map(row => {
    const ids = new Set(
      (row?.lineup?.starters || []).map(playerIdentity).filter(Boolean)
    );
    const retained = [...latestIds].filter(id => ids.has(id)).length;
    const same =
      ids.size === latestIds.size &&
      retained === latestIds.size;

    return {
      date: row.date,
      home: row.home,
      away: row.away,
      starters: ids.size,
      retainedFromLatest: retained,
      exactSameXi: same
    };
  });

  const retainedValues = comparisons.map(item => item.retainedFromLatest);
  const unique = new Set();
  recent.forEach(row => {
    for (const player of row?.lineup?.starters || []) {
      const id = playerIdentity(player);
      if (id) unique.add(id);
    }
  });

  return {
    dataMatches: recent.length,
    latestXiSize: latestIds.size,
    averageRetainedFromLatest: retainedValues.length
      ? Number(
          (
            retainedValues.reduce((sum, value) => sum + value, 0) /
            retainedValues.length
          ).toFixed(2)
        )
      : null,
    minRetainedFromLatest: retainedValues.length
      ? Math.min(...retainedValues)
      : null,
    maxRetainedFromLatest: retainedValues.length
      ? Math.max(...retainedValues)
      : null,
    exactSameXiMatches: comparisons.filter(item => item.exactSameXi).length,
    uniqueStarters: unique.size,
    matches: comparisons
  };
}


function buildCoachSystemChanges(lineupRows) {
  const timeline = lineupRows.slice(0, 10).map(row => ({
    date: row?.date ?? null,
    home: row?.home ?? null,
    away: row?.away ?? null,
    coach: row?.lineup?.coach ? {
      id: row.lineup.coach.id ?? null,
      name: row.lineup.coach.name ?? null
    } : null,
    formation: row?.lineup?.formation ?? null
  }));

  const identity = coach => {
    if (!coach) return null;
    if (coach.id != null) return 'id:' + String(coach.id);
    const name = normalizeName(coach.name || '');
    return name ? 'name:' + name : null;
  };

  const summarize = rows => {
    const coachIds = rows
      .map(row => identity(row.coach))
      .filter(Boolean);
    const formations = rows
      .map(row => row.formation)
      .filter(Boolean);

    let coachChanges = 0;
    let formationChanges = 0;

    for (let i = 0; i < rows.length - 1; i++) {
      const currentCoach = identity(rows[i].coach);
      const previousCoach = identity(rows[i + 1].coach);
      if (currentCoach && previousCoach && currentCoach !== previousCoach) {
        coachChanges++;
      }

      const currentFormation = rows[i].formation;
      const previousFormation = rows[i + 1].formation;
      if (
        currentFormation &&
        previousFormation &&
        currentFormation !== previousFormation
      ) {
        formationChanges++;
      }
    }

    return {
      dataMatches: rows.length,
      uniqueCoaches: new Set(coachIds).size,
      uniqueFormations: new Set(formations).size,
      coachChanges,
      formationChanges
    };
  };

  const last5 = timeline.slice(0, 5);
  const summary5 = summarize(last5);
  const summary10 = summarize(timeline);
  const latest = timeline[0] || null;
  const previous = timeline[1] || null;

  return {
    dataMatches: timeline.length,
    latestCoach: latest?.coach ?? null,
    latestFormation: latest?.formation ?? null,
    coachChangedFromPrevious:
      identity(latest?.coach) && identity(previous?.coach)
        ? identity(latest.coach) !== identity(previous.coach)
        : null,
    formationChangedFromPrevious:
      latest?.formation && previous?.formation
        ? latest.formation !== previous.formation
        : null,
    son5: summary5,
    son10: summary10,
    timeline
  };
}

async function buildTeam(browser, info, opponentName, referenceMs = Date.now()) {
  const { matches, jsons, source } = await collectTeamDataSmart(browser, info);
  const cutoff = Number.isFinite(referenceMs) ? referenceMs : Date.now();
  const finished = matches
    .filter(m =>
      Number.isFinite(Date.parse(m.date)) &&
      Date.parse(m.date) < cutoff &&
      isFinished(m, cutoff)
    )
    .sort((a,b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0,10);
  const upcoming = upcomingFrom(matches, cutoff);

  const rows = await mapLimit(finished, 4, async m => {
    const details = await fetchFotMobMatchDetails(m.id);
    const pair = await getMatchXg(browser, m.url, m.id, details);
    const px = teamPerspective(m, info.name, pair);
    const standard = teamStandardPerspective(
      m,
      info.name,
      extractFotMobStandardStats(details)
    );
    const savePercentage = verifiedKeeperSavePercentage(
      m,
      info.name,
      standard
    );
    const passAccuracy = derivedPassAccuracy(standard);
    const lineup = extractFotMobTeamLineup(details, info);
    const playerProgression = extractFotMobPlayerProgression(details, info);
    const redCardContext = extractFotMobRedCardContext(
      details,
      m,
      info.name,
      standard.redCards
    );
    return {
      ...m,
      ...px,
      ...standard,
      savePercentage,
      passAccuracy,
      lineup,
      playerProgression,
      redCardContext
    };

  });

  const last5 = rows.slice(0,5);
  const valid5 = last5.filter(x => x.xG != null && x.xGA != null);
  const valid10 = rows.filter(x => x.xG != null && x.xGA != null);
  const lineupRows = rows.filter(
    row => Array.isArray(row?.lineup?.starters) && row.lineup.starters.length > 0
  );
  const latestLineupRow = lineupRows[0] || null;
  const oyuncuFormu = buildPlayerFormFromLineups(lineupRows);
  const ilk11Surekliligi = buildXiContinuityFromLineups(lineupRows);
  const teknikSistemDegisimi = buildCoachSystemChanges(lineupRows);
  const kirmiziKartBaglami = {
    son5: summarizeRedCardContext(last5),
    son10: summarizeRedCardContext(rows)
  };
  const son5Standard = standardStatsSummary(last5);
  const son10Standard = standardStatsSummary(rows);
  const goalkeeperContext = {
    source: 'FotMob',
    basis: 'match-details-standard-stats-plus-score-validation',
    son5: {
      keeperSaves: son5Standard.keeperSaves ?? null,
      keeperSavesDataMatches: son5Standard.keeperSavesDataMatches ?? 0,
      savePercentage: son5Standard.savePercentage ?? null,
      savePercentageDataMatches: son5Standard.savePercentageDataMatches ?? 0,
      psxg: null
    },
    son10: {
      keeperSaves: son10Standard.keeperSaves ?? null,
      keeperSavesDataMatches: son10Standard.keeperSavesDataMatches ?? 0,
      savePercentage: son10Standard.savePercentage ?? null,
      savePercentageDataMatches: son10Standard.savePercentageDataMatches ?? 0,
      psxg: null
    },
    provenance: {
      keeperSaves: 'FotMob.matchDetails.content.stats',
      savePercentage: 'derived-verified-keeperSaves-shotsOnTargetAllowed-goalsAgainst',
      psxg: null
    },
    savePercentageValidation: 'keeperSaves+goalsAgainst=shotsOnTargetAllowed',
    psxgStatus: 'not-provided-by-source'
  };
  const playerProgressionRows = rows.filter(row => row?.playerProgression);
  const playerProgressionContext = {
    source: 'FotMob',
    basis: 'match-details-player-stats',
    son5: {
      dataMatches: last5.filter(row => row?.playerProgression).length,
      completeMatches: last5.filter(
        row => row?.playerProgression?.complete === true
      ).length
    },
    son10: {
      dataMatches: playerProgressionRows.length,
      completeMatches: playerProgressionRows.filter(
        row => row?.playerProgression?.complete === true
      ).length
    },
    teamTotalPolicy:
      'null-when-any-played-player-is-missing-passes-into-final-third',
    provenance: {
      passesIntoFinalThird:
        'FotMob.matchDetails.content.playerStats.*.stats.attack.passes_into_final_third'
    }
  };
  const progressionContext = {
    source: 'FotMob',
    basis: 'match-details-standard-stats',
    son5: {
      passes: son5Standard.passes ?? null,
      accuratePasses: son5Standard.accuratePasses ?? null,
      passAccuracy: son5Standard.passAccuracy ?? null,
      passAccuracyDataMatches: son5Standard.passAccuracyDataMatches ?? 0,
      possession: son5Standard.possession ?? null,
      ownHalfPasses: son5Standard.ownHalfPasses ?? null,
      oppositionHalfPasses: son5Standard.oppositionHalfPasses ?? null,
      touchesOppBox: son5Standard.touchesOppBox ?? null
    },
    son10: {
      passes: son10Standard.passes ?? null,
      accuratePasses: son10Standard.accuratePasses ?? null,
      passAccuracy: son10Standard.passAccuracy ?? null,
      passAccuracyDataMatches: son10Standard.passAccuracyDataMatches ?? 0,
      possession: son10Standard.possession ?? null,
      ownHalfPasses: son10Standard.ownHalfPasses ?? null,
      oppositionHalfPasses: son10Standard.oppositionHalfPasses ?? null,
      touchesOppBox: son10Standard.touchesOppBox ?? null
    },
    provenance: {
      passes: 'FotMob.matchDetails.content.stats',
      accuratePasses: 'FotMob.matchDetails.content.stats',
      passAccuracy: 'derived-accuratePasses-divided-by-passes',
      possession: 'FotMob.matchDetails.content.stats',
      ownHalfPasses: 'FotMob.matchDetails.content.stats',
      oppositionHalfPasses: 'FotMob.matchDetails.content.stats',
      touchesOppBox: 'FotMob.matchDetails.content.stats'
    }
  };
  const pressingContext = {
    source: 'FotMob',
    basis: 'match-details-defence-stats',
    son5: {
      tackles: son5Standard.tackles ?? null,
      interceptions: son5Standard.interceptions ?? null
    },
    son10: {
      tackles: son10Standard.tackles ?? null,
      interceptions: son10Standard.interceptions ?? null
    },
    provenance: {
      tackles: 'FotMob.matchDetails.content.stats',
      interceptions: 'FotMob.matchDetails.content.stats'
    },
    ppda: null,
    highTurnovers: null,
    recoveries: null,
    pressingMetricStatus: 'direct-pressing-metric-not-provided-by-source'
  };
  const defensiveStructureContext = {
    source: 'FotMob',
    basis: 'match-details-defence-stats',
    son5: {
      tackles: son5Standard.tackles ?? null,
      interceptions: son5Standard.interceptions ?? null,
      shotBlocks: son5Standard.shotBlocks ?? null,
      clearances: son5Standard.clearances ?? null
    },
    son10: {
      tackles: son10Standard.tackles ?? null,
      interceptions: son10Standard.interceptions ?? null,
      shotBlocks: son10Standard.shotBlocks ?? null,
      clearances: son10Standard.clearances ?? null
    },
    provenance: {
      tackles: 'FotMob.matchDetails.content.stats',
      interceptions: 'FotMob.matchDetails.content.stats',
      shotBlocks: 'FotMob.matchDetails.content.stats',
      clearances: 'FotMob.matchDetails.content.stats'
    }
  };
  const duelContext = {
    source: 'FotMob',
    basis: 'match-details-duel-stats',
    son5: {
      duelsWon: son5Standard.duelsWon ?? null,
      groundDuelsWon: son5Standard.groundDuelsWon ?? null,
      aerialDuelsWon: son5Standard.aerialDuelsWon ?? null,
      successfulDribbles: son5Standard.successfulDribbles ?? null
    },
    son10: {
      duelsWon: son10Standard.duelsWon ?? null,
      groundDuelsWon: son10Standard.groundDuelsWon ?? null,
      aerialDuelsWon: son10Standard.aerialDuelsWon ?? null,
      successfulDribbles: son10Standard.successfulDribbles ?? null
    },
    provenance: {
      duelsWon: 'FotMob.matchDetails.content.stats',
      groundDuelsWon: 'FotMob.matchDetails.content.stats',
      aerialDuelsWon: 'FotMob.matchDetails.content.stats',
      successfulDribbles: 'FotMob.matchDetails.content.stats'
    }
  };

  const fotMobStyleCoverage = subset => ({
    windowMatches: subset.length,
    dataMatches: {
      accurateLongBalls: subset.filter(row =>
        finiteNumber(row?.accurateLongBalls)
      ).length,
      accurateCrosses: subset.filter(row =>
        finiteNumber(row?.accurateCrosses)
      ).length
    }
  });

  const son5StyleCoverage = fotMobStyleCoverage(last5);
  const son10StyleCoverage = fotMobStyleCoverage(rows);
  const fotMobStyleTrend = {
    comparison: 'son5-vs-son10',
    interpretation: 'mathematical-change-only',
    metrics: {}
  };
  for (const key of ['accurateLongBalls', 'accurateCrosses']) {
    const recent = son5Standard?.[key];
    const baseline = son10Standard?.[key];

    if (!finiteNumber(recent) || !finiteNumber(baseline)) {
      fotMobStyleTrend.metrics[key] = null;
      continue;
    }

    const delta = Number((recent - baseline).toFixed(2));
    fotMobStyleTrend.metrics[key] = {
      son5: recent,
      son10: baseline,
      delta,
      deltaPct: baseline !== 0
        ? Number(((delta / Math.abs(baseline)) * 100).toFixed(1))
        : null,
      dataMatches5: son5StyleCoverage.dataMatches[key] ?? 0,
      dataMatches10: son10StyleCoverage.dataMatches[key] ?? 0
    };
  }

  const styleContext = {
    source: 'FotMob',
    basis: 'match-details-passing-style-stats',
    son5: {
      accurateLongBalls: son5Standard.accurateLongBalls ?? null,
      accurateCrosses: son5Standard.accurateCrosses ?? null
    },
    son10: {
      accurateLongBalls: son10Standard.accurateLongBalls ?? null,
      accurateCrosses: son10Standard.accurateCrosses ?? null
    },
    coverage: {
      son5: son5StyleCoverage,
      son10: son10StyleCoverage
    },
    trend: fotMobStyleTrend,
    provenance: {
      accurateLongBalls: 'FotMob.matchDetails.content.stats.long_balls_accurate',
      accurateCrosses: 'FotMob.matchDetails.content.stats.accurate_crosses'
    }
  };

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
    standartIstatistik: {
      son5: son5Standard,
      son10: son10Standard
    },
    lineup: {
      veriMac: lineupRows.length,
      sonMac: latestLineupRow ? {
        tarih: latestLineupRow.date,
        ev: latestLineupRow.home,
        deplasman: latestLineupRow.away,
        ...latestLineupRow.lineup
      } : null
    },
    oyuncuFormu,
    ilk11Surekliligi,
    teknikSistemDegisimi,
    kirmiziKartBaglami,
    goalkeeperContext,
    progressionContext,
    playerProgressionContext,
    pressingContext,
    defensiveStructureContext,
    duelContext,
    styleContext,
    maclar: rows.map(m => ({
      tarih: m.date,
      ev: m.home,
      deplasman: m.away,
      evGol: m.homeScore,
      deplasmanGol: m.awayScore,
      xG: m.xG,
      xGA: m.xGA,
      lineup: m.lineup,
      playerProgression: m.playerProgression,
      redCardContext: m.redCardContext,
      istatistik: {
        shots: m.shots,
        shotsAllowed: m.shotsAllowed,
        shotsOnTarget: m.shotsOnTarget,
        shotsOnTargetAllowed: m.shotsOnTargetAllowed,
        shotsInsideBox: m.shotsInsideBox,
        shotsInsideBoxAllowed: m.shotsInsideBoxAllowed,
        bigChances: m.bigChances,
        bigChancesAllowed: m.bigChancesAllowed,
        corners: m.corners,
        cornersAllowed: m.cornersAllowed,
        possession: m.possession,
        yellowCards: m.yellowCards,
        redCards: m.redCards,
        touchesOppBox: m.touchesOppBox,
        touchesOppBoxAllowed: m.touchesOppBoxAllowed,
        passes: m.passes,
        accuratePasses: m.accuratePasses,
        ownHalfPasses: m.ownHalfPasses,
        oppositionHalfPasses: m.oppositionHalfPasses,
        tackles: m.tackles,
        interceptions: m.interceptions,
        shotBlocks: m.shotBlocks,
        clearances: m.clearances,
        duelsWon: m.duelsWon,
        groundDuelsWon: m.groundDuelsWon,
        aerialDuelsWon: m.aerialDuelsWon,
        successfulDribbles: m.successfulDribbles,
        accurateLongBalls: m.accurateLongBalls,
        accurateCrosses: m.accurateCrosses,
        passAccuracy: m.passAccuracy,
        keeperSaves: m.keeperSaves,
        savePercentage: m.savePercentage
      },
      url: m.url,
      id: m.id
    })),
    h2h: h2hFrom(matches, info.name, opponentName, cutoff).map(m => ({
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
      sonraki7Gun: upcoming.filter(m => Date.parse(m.date) <= cutoff + 7 * 86400000).length,
      sonraki14Gun: upcoming.filter(m => Date.parse(m.date) <= cutoff + 14 * 86400000).length
    },
    ligDurumu: leagueFromJsons(jsons, info.name),
    veriKaynagi: source,
    _allMatches: matches
  };
}

function matchBetweenUpcoming(
  matches,
  a,
  b,
  referenceMs = Date.now(),
  strictReference = false
) {
  const cutoff = Number.isFinite(referenceMs) ? referenceMs : Date.now();
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
    .filter(m => {
      const time = Date.parse(m.date);
      return (
        Number.isFinite(time) &&
        time > cutoff - 4 * 60 * 60 * 1000 &&
        (!strictReference || Math.abs(time - cutoff) <= 36 * 60 * 60 * 1000)
      );
    })
    .sort((x,y) => Math.abs(Date.parse(x.date) - cutoff) - Math.abs(Date.parse(y.date) - cutoff))[0] || null;
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
  referenceMs = Date.now(),
  strictReference = false,
) {
  const cutoff = Number.isFinite(referenceMs) ? referenceMs : Date.now();
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
        const time = Date.parse(m.date);
        return (
          done &&
          m.homeScore != null &&
          m.awayScore != null &&
          Number.isFinite(time) &&
          time < cutoff
        );
      })
      .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
      .slice(0, 4);

    const target = rows
      .filter(m => {
        const time = Date.parse(m.date);
        return (
          Number.isFinite(time) &&
          time > cutoff - 4 * 60 * 60 * 1000 &&
          (!strictReference || Math.abs(time - cutoff) <= 36 * 60 * 60 * 1000)
        );
      })
      .sort(
        (a, b) =>
          Math.abs(Date.parse(a.date) - cutoff) -
          Math.abs(Date.parse(b.date) - cutoff)
      )[0] || null;

    return { finished, target };
  } catch {
    return { finished: [], target: null };
  }
}

async function buildFotMobPerformancePackage({ home, away, matchDate = null }) {
  if (!home?.name || !away?.name) {
    throw new Error('home/away takım adı gerekli.');
  }

  const parsedReference = Date.parse(matchDate || '');
  const referenceMs = Number.isFinite(parsedReference) ? parsedReference : Date.now();
  const referenceKey = Number.isFinite(parsedReference)
    ? new Date(parsedReference).toISOString()
    : 'current';

  const cacheKey = JSON.stringify([
    home.name,
    home.url || '',
    away.name,
    away.url || '',
    referenceKey
  ]);
  const hit = performanceCacheGet(cacheKey);
  if (hit) return { ...hit.data, cache: true };

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

    const resolvedCacheKey = JSON.stringify([
      homeInfo.name,
      homeInfo.url,
      awayInfo.name,
      awayInfo.url,
      referenceKey
    ]);
    const resolvedHit = performanceCacheGet(resolvedCacheKey);
    if (resolvedHit) {
      return { ...resolvedHit.data, cache: true };
    }

    const homeId = teamIdFromUrl(homeInfo.url);
    const awayId = teamIdFromUrl(awayInfo.url);

    const matchup = await fetchMatchupData(
      homeInfo.name,
      awayInfo.name,
      homeId,
      awayId,
      referenceMs,
      Number.isFinite(parsedReference),
    );

    const homePack = await buildTeam(browser, homeInfo, awayInfo.name, referenceMs);
    const awayPack = await buildTeam(browser, awayInfo, homeInfo.name, referenceMs);

    const targetMatch =
      matchBetweenUpcoming(
        homePack._allMatches,
        homeInfo.name,
        awayInfo.name,
        referenceMs,
        Number.isFinite(parsedReference)
      ) ||
      matchBetweenUpcoming(
        awayPack._allMatches,
        homeInfo.name,
        awayInfo.name,
        referenceMs,
        Number.isFinite(parsedReference)
      ) ||
      matchup.target;

    const unavailable = targetMatch
      ? await getUnavailable(browser, targetMatch.url, targetMatch.id)
      : { home: [], away: [], available: false };

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
      h2h: { bulunan: h2h.length, hedef: 4, kaynak: 'FotMob', maclar: h2h },
      meta: {
        kaynak: 'FotMob',
        olusturmaZamani: new Date().toISOString(),
        homeUrl: homeInfo.url,
        awayUrl: awayInfo.url,
        engineVersion: 80,
      },
      cache: false
    };

    performanceCacheSet(cacheKey, data);
    performanceCacheSet(resolvedCacheKey, data);
    return data;
  } finally {
    await browser.close().catch(() => {});
  }
}

const UNDERSTAT_LEAGUES = [
  'EPL',
  'La_liga',
  'Bundesliga',
  'Serie_A',
  'Ligue_1',
  'RFPL',
];

let understatCatalogCache = {
  key: '',
  expiresAt: 0,
  teams: [],
};

function understatSeasonCandidates(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const current = month >= 6 ? year : year - 1;
  return [current, current - 1];
}

function understatTeamScore(candidate, target) {
  const a = foldName(candidate);
  const b = foldName(target);
  if (!a || !b) return 0;
  if (a === b) return 1000;
  if (teamNameMatches(candidate, target)) return 800;

  const stop = new Set(['fc', 'cf', 'sc', 'ac', 'club', 'de', 'the']);
  const words = a.split(' ').filter(x => x && !stop.has(x));
  const acronym = words.map(x => x[0]).join('');
  const compactTarget = b.replace(/\s+/g, '');
  if (acronym.length >= 2 && acronym === compactTarget) return 750;

  if (b.length >= 4 && a.includes(b)) return 600;
  if (a.length >= 4 && b.includes(a)) return 550;

  const bt = b.split(' ').filter(Boolean);
  const hits = bt.filter(x => a.includes(x)).length;
  return hits ? 100 + hits * 40 : 0;
}

function decodeHtmlValue(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

async function fetchUnderstatText(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0',
        'accept-language': 'en-US,en;q=0.9',
        ...headers,
      },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUnderstatTeamPage(teamValue, season) {
  const team = String(teamValue || '').trim();
  if (!team) return null;
  return fetchUnderstatText(
    'https://understat.com/team/' +
      encodeURIComponent(team.replace(/\s+/g, '_')) + '/' +
      encodeURIComponent(season)
  );
}

function understatCatalogFromHtml(html) {
  if (!html) return [];
  const select = html.match(
    /<select[^>]+name=["']team["'][^>]*>([\s\S]*?)<\/select>/i
  );
  if (!select) return [];

  const out = [];
  const seen = new Set();
  const re = /<option[^>]+value=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = re.exec(select[1]))) {
    const value = decodeHtmlValue(match[1]);
    const key = foldName(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

async function resolveUnderstatFromCatalog(teamName, catalog, season) {
  const ranked = (catalog || [])
    .map(name => ({ name, score: understatTeamScore(name, teamName) }))
    .filter(x => x.score >= 500)
    .sort((a, b) => b.score - a.score);

  for (const candidate of ranked.slice(0, 5)) {
    const data = await fetchUnderstatTeamData(candidate.name, season);
    if (data) return { name: candidate.name, season, data };
  }
  return null;
}

async function fetchUnderstatTeamData(teamValue, season) {
  const team = String(teamValue || '').trim();
  if (!team) return null;
  const url =
    'https://understat.com/getTeamData/' +
    encodeURIComponent(team) + '/' +
    encodeURIComponent(season) + '/';

  const body = await fetchUnderstatText(url, {
    accept: 'application/json, text/javascript, */*; q=0.01',
    referer:
      'https://understat.com/team/' +
      encodeURIComponent(team.replace(/\s+/g, '_')) + '/' +
      encodeURIComponent(season),
    'x-requested-with': 'XMLHttpRequest',
  });
  if (!body) return null;

  try {
    const data = JSON.parse(body);
    if (!data || !Array.isArray(data.dates)) return null;
    return data;
  } catch {
    return null;
  }
}

async function getUnderstatCatalog(season) {
  const key = String(season);
  if (
    understatCatalogCache.key === key &&
    understatCatalogCache.expiresAt > Date.now()
  ) {
    return understatCatalogCache.teams;
  }

  const settled = await Promise.allSettled(
    UNDERSTAT_LEAGUES.map(league =>
      fetchUnderstatText(
        'https://understat.com/league/' +
        encodeURIComponent(league) + '/' +
        encodeURIComponent(season)
      )
    )
  );

  const teams = new Set();
  for (const item of settled) {
    const html = item.status === 'fulfilled' ? item.value : null;
    if (!html) continue;
    const select = html.match(
      /<select[^>]+name=["']team["'][^>]*>([\s\S]*?)<\/select>/i
    );
    if (!select) continue;

    const re = /<option[^>]+value=["']([^"']+)["'][^>]*>/gi;
    let match;
    while ((match = re.exec(select[1]))) {
      const value = decodeHtmlValue(match[1]);
      if (/[a-z]/i.test(value)) teams.add(value);
    }
  }

  const list = [...teams];
  understatCatalogCache = {
    key,
    expiresAt: Date.now() + 6 * 60 * 60 * 1000,
    teams: list,
  };
  return list;
}

async function resolveUnderstatTeam(teamName) {
  const target = String(teamName || '').trim();
  if (!target) return null;

  for (const season of understatSeasonCandidates()) {
    const direct = await fetchUnderstatTeamData(target, season);
    if (direct) {
      return { name: target, season, data: direct };
    }

    const catalog = await getUnderstatCatalog(season);
    const ranked = catalog
      .map(name => ({ name, score: understatTeamScore(name, target) }))
      .filter(x => x.score >= 500)
      .sort((a, b) => b.score - a.score);

    for (const candidate of ranked.slice(0, 3)) {
      const data = await fetchUnderstatTeamData(candidate.name, season);
      if (data) {
        return { name: candidate.name, season, data };
      }
    }
  }
  return null;
}

function understatRows(resolved) {
  return (resolved?.data?.dates || [])
    .map(m => {
      const home = String(m?.h?.title || '').trim();
      const away = String(m?.a?.title || '').trim();
      if (!home || !away) return null;

      const isHome = teamNameMatches(home, resolved.name);
      const homeXg = num(m?.xG?.h);
      const awayXg = num(m?.xG?.a);

      return {
        id: m?.id ?? null,
        home,
        away,
        date: m?.datetime || null,
        homeScore: num(m?.goals?.h),
        awayScore: num(m?.goals?.a),
        xG: isHome ? homeXg : awayXg,
        xGA: isHome ? awayXg : homeXg,
        isResult: m?.isResult === true,
        url: m?.id ? 'https://understat.com/match/' + m.id : null,
      };
    })
    .filter(Boolean);
}

function buildUnderstatTeamPack(resolved, opponentName, referenceMs = Date.now()) {
  const allMatches = understatRows(resolved);
  const cutoff = Number.isFinite(referenceMs) ? referenceMs : Date.now();
  const finished = allMatches
    .filter(m => m.isResult)
    .filter(m => Number.isFinite(Date.parse(m.date)) && Date.parse(m.date) < cutoff)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, 10);
  const upcoming = allMatches
    .filter(m => !m.isResult && Number.isFinite(Date.parse(m.date)))
    .filter(m => Date.parse(m.date) > cutoff)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .slice(0, 5);

  const last5 = finished.slice(0, 5);
  const valid5 = last5.filter(x => x.xG != null && x.xGA != null);
  const valid10 = finished.filter(x => x.xG != null && x.xGA != null);

  return {
    takim: resolved.name,
    son5: {
      sonuc: resultSummary(last5, resolved.name),
      xGVerisi: valid5.length,
      xG: avg(valid5, 'xG'),
      xGA: avg(valid5, 'xGA'),
    },
    son10: {
      sonuc: resultSummary(finished, resolved.name),
      xGVerisi: valid10.length,
      xG: avg(valid10, 'xG'),
      xGA: avg(valid10, 'xGA'),
    },
    maclar: finished.map(m => ({
      tarih: m.date,
      ev: m.home,
      deplasman: m.away,
      evGol: m.homeScore,
      deplasmanGol: m.awayScore,
      xG: m.xG,
      xGA: m.xGA,
      url: m.url,
      id: m.id,
    })),
    h2h: h2hFrom(allMatches, resolved.name, opponentName, cutoff).map(m => ({
      tarih: m.date,
      ev: m.home,
      deplasman: m.away,
      evGol: m.homeScore,
      deplasmanGol: m.awayScore,
    })),
    sonrakiMaclar: upcoming.map(m => ({
      tarih: m.date,
      ev: m.home,
      deplasman: m.away,
      url: m.url,
    })),
    fiksturYogunlugu: {
      sonraki7Gun: upcoming.filter(
        m => Date.parse(m.date) <= cutoff + 7 * 86400000
      ).length,
      sonraki14Gun: upcoming.filter(
        m => Date.parse(m.date) <= cutoff + 14 * 86400000
      ).length,
    },
    ligDurumu: null,
    eksikler: [],
    eksikVerisi: false,
    veriKaynagi: 'Understat',
    _allMatches: allMatches,
  };
}

async function buildUnderstatPerformancePackage({ home, away, matchDate = null }) {
  if (!home?.name || !away?.name) {
    throw new Error('home/away team name required.');
  }

  let homeResolved = await resolveUnderstatTeam(home.name);
  let awayResolved = await resolveUnderstatTeam(away.name);

  if (homeResolved && !awayResolved) {
    const html = await fetchUnderstatTeamPage(
      homeResolved.name,
      homeResolved.season
    );
    const catalog = understatCatalogFromHtml(html);
    awayResolved = await resolveUnderstatFromCatalog(
      away.name,
      catalog,
      homeResolved.season
    );
  }

  if (awayResolved && !homeResolved) {
    const html = await fetchUnderstatTeamPage(
      awayResolved.name,
      awayResolved.season
    );
    const catalog = understatCatalogFromHtml(html);
    homeResolved = await resolveUnderstatFromCatalog(
      home.name,
      catalog,
      awayResolved.season
    );
  }

  if (!homeResolved || !awayResolved) {
    throw new Error('Understat team match not found.');
  }

  const parsedReference = Date.parse(matchDate || '');
  const referenceMs = Number.isFinite(parsedReference) ? parsedReference : Date.now();
  const homePack = buildUnderstatTeamPack(homeResolved, awayResolved.name, referenceMs);
  const awayPack = buildUnderstatTeamPack(awayResolved, homeResolved.name, referenceMs);

  const candidates = homePack._allMatches
    .filter(m =>
      (teamNameMatches(m.home, homeResolved.name) &&
       teamNameMatches(m.away, awayResolved.name)) ||
      (teamNameMatches(m.home, awayResolved.name) &&
       teamNameMatches(m.away, homeResolved.name))
    )
    .sort((a, b) => {
      const af = a.isResult ? 1 : 0;
      const bf = b.isResult ? 1 : 0;
      if (af !== bf) return af - bf;
      return Math.abs(Date.parse(a.date) - referenceMs) -
        Math.abs(Date.parse(b.date) - referenceMs);
    });

  const targetMatch = candidates[0] || null;
  const h2h = h2hFrom(
    homePack._allMatches,
    homeResolved.name,
    awayResolved.name,
    referenceMs
  ).map(m => ({
    tarih: m.date,
    ev: m.home,
    deplasman: m.away,
    evGol: m.homeScore,
    deplasmanGol: m.awayScore,
  }));

  delete homePack._allMatches;
  delete awayPack._allMatches;

  return {
    mac: targetMatch ? {
      ev: targetMatch.home,
      deplasman: targetMatch.away,
      tarih: targetMatch.date,
      url: targetMatch.url,
      id: targetMatch.id,
    } : {
      ev: homeResolved.name,
      deplasman: awayResolved.name,
      tarih: null,
      url: null,
      id: null,
    },
    evTakimi: homePack,
    deplasmanTakimi: awayPack,
    h2h: { bulunan: h2h.length, hedef: 4, kaynak: 'Understat', maclar: h2h },
    meta: {
      kaynak: 'Understat',
      olusturmaZamani: new Date().toISOString(),
      homeUrl:
        'https://understat.com/team/' +
        encodeURIComponent(homeResolved.name.replace(/\s+/g, '_')) +
        '/' + homeResolved.season,
      awayUrl:
        'https://understat.com/team/' +
        encodeURIComponent(awayResolved.name.replace(/\s+/g, '_')) +
        '/' + awayResolved.season,
      understatSeason: homeResolved.season,
      engineVersion: 80,
    },
    cache: false,
  };
}


function decodeBetExplorerHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchBetExplorerHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0',
        'accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!response.ok) {
      throw new Error('BetExplorer HTTP ' + response.status);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function betExplorerTeamLinks(html) {
  const rows = [];
  const seen = new Set();
  const re = /<a\s+[^>]*href="([^"]*\/football\/team\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const name = decodeBetExplorerHtml(m[2]);
    if (!name) continue;
    const url = new URL(m[1], 'https://www.betexplorer.com').href;
    if (seen.has(url)) continue;
    seen.add(url);
    rows.push({ name, url });
  }
  return rows;
}

function betExplorerTeamLinkScore(candidate, teamName) {
  const a = foldName(candidate?.name || '');
  const b = foldName(teamName || '');
  const u = foldName(candidate?.url || '');
  if (b.length === 0) return 0;
  if (a === b) return 1000;
  if (u.includes(b)) return 950;
  if (a.length > 0 && teamNameMatches(candidate.name, teamName)) return 900;
  if (a.includes(b) || b.includes(a)) return 700;
  const parts = b.split(' ').filter(x => x.length > 2);
  const hits = parts.filter(x => a.includes(x)).length;
  return hits ? 300 + hits * 50 : 0;
}

function selectBetExplorerTeamLink(html, teamName) {
  return betExplorerTeamLinks(html)
    .map(x => ({ ...x, score: betExplorerTeamLinkScore(x, teamName) }))
    .sort((a, b) => b.score - a.score)
    .find(x => x.score >= 500) || null;
}

function betExplorerRowsFromTeamPage(html, teamName) {
  const out = [];
  const rowRe = /<tr[^>]*data-ttid[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(String(html || '')))) {
    const rowHtml = rowMatch[1];
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowHtml))) {
      cells.push(decodeBetExplorerHtml(cellMatch[1]));
    }

    if (cells.length < 7) continue;
    const score = String(cells[4] || '').match(/^(\d+)\s*:\s*(\d+)/);
    const date = String(cells[6] || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!score || !date) continue;

    const homeName = cells[2];
    const awayName = cells[3];
    if (!teamNameMatches(homeName, teamName) && !teamNameMatches(awayName, teamName)) {
      continue;
    }

    const detail = rowHtml.match(/href="([^"]*\/football\/[^"]+\/[A-Za-z0-9]+\/)"[^>]*>/i);
    const url = detail ? new URL(detail[1], 'https://www.betexplorer.com').href : null;
    const idMatch = url ? url.match(/\/([A-Za-z0-9]+)\/$/) : null;

    out.push({
      id: idMatch ? idMatch[1] : null,
      home: homeName,
      away: awayName,
      date: date[3] + '-' + date[2] + '-' + date[1] + 'T00:00:00.000Z',
      homeScore: Number(score[1]),
      awayScore: Number(score[2]),
      status: 'finished',
      isResult: true,
      url,
      xG: null,
      xGA: null
    });
  }

  return out.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
}

function buildBetExplorerTeamPack(
  teamName,
  matches,
  opponentName,
  referenceMs = Date.now(),
  strictReferenceDay = false
) {
  const reference = Number.isFinite(referenceMs) ? referenceMs : Date.now();
  const cutoff = strictReferenceDay
    ? Date.parse(new Date(reference).toISOString().slice(0, 10) + 'T00:00:00.000Z')
    : reference;
  const finished = matches
    .filter(m => Number.isFinite(Date.parse(m.date)) && Date.parse(m.date) < cutoff)
    .slice(0, 10);
  const last5 = finished.slice(0, 5);

  return {
    takim: teamName,
    son5: {
      sonuc: resultSummary(last5, teamName),
      xGVerisi: 0,
      xG: null,
      xGA: null
    },
    son10: {
      sonuc: resultSummary(finished, teamName),
      xGVerisi: 0,
      xG: null,
      xGA: null
    },
    maclar: finished.map(m => ({
      tarih: m.date,
      ev: m.home,
      deplasman: m.away,
      evGol: m.homeScore,
      deplasmanGol: m.awayScore,
      xG: null,
      xGA: null,
      url: m.url,
      id: m.id
    })),
    h2h: h2hFrom(matches, teamName, opponentName, cutoff).map(m => ({
      tarih: m.date,
      ev: m.home,
      deplasman: m.away,
      evGol: m.homeScore,
      deplasmanGol: m.awayScore
    })),
    sonrakiMaclar: [],
    fiksturYogunlugu: {
      sonraki7Gun: null,
      sonraki14Gun: null
    },
    ligDurumu: null,
    eksikler: [],
    eksikVerisi: false,
    veriKaynagi: 'BetExplorer',
    _allMatches: matches
  };
}

async function buildBetExplorerPerformancePackage({ home, away, matchUrl, matchDate }) {
  if (!home?.name || !away?.name || !matchUrl) {
    throw new Error('BetExplorer match URL required.');
  }

  const match = new URL(matchUrl);
  if (!/(^|\.)betexplorer\.com$/i.test(match.hostname)) {
    throw new Error('BetExplorer URL required.');
  }

  const matchHtml = await fetchBetExplorerHtml(match.href);
  const homeLink = selectBetExplorerTeamLink(matchHtml, home.name);
  const awayLink = selectBetExplorerTeamLink(matchHtml, away.name);
  if (!homeLink || !awayLink) {
    throw new Error('BetExplorer team links not found.');
  }

  const [homeHtml, awayHtml] = await Promise.all([
    fetchBetExplorerHtml(homeLink.url),
    fetchBetExplorerHtml(awayLink.url)
  ]);

  const parsedReference = Date.parse(matchDate || '');
  const referenceMs = Number.isFinite(parsedReference)
    ? parsedReference
    : Date.now();
  const strictReferenceDay = Number.isFinite(parsedReference);
  const betExplorerCutoff = strictReferenceDay
    ? Date.parse(
        new Date(referenceMs).toISOString().slice(0, 10) +
        'T00:00:00.000Z'
      )
    : referenceMs;

  const homeRows = betExplorerRowsFromTeamPage(homeHtml, home.name);
  const awayRows = betExplorerRowsFromTeamPage(awayHtml, away.name);
  if (!homeRows.length || !awayRows.length) {
    throw new Error('BetExplorer team form not found.');
  }

  const homePack = buildBetExplorerTeamPack(
    home.name,
    homeRows,
    away.name,
    referenceMs,
    strictReferenceDay
  );
  const awayPack = buildBetExplorerTeamPack(
    away.name,
    awayRows,
    home.name,
    referenceMs,
    strictReferenceDay
  );

  const h2hRows = [...homeRows, ...awayRows]
    .filter(m =>
      Number.isFinite(Date.parse(m.date)) &&
      Date.parse(m.date) < betExplorerCutoff &&
      (
        (teamNameMatches(m.home, home.name) && teamNameMatches(m.away, away.name)) ||
        (teamNameMatches(m.home, away.name) && teamNameMatches(m.away, home.name))
      )
    );
  const h2hMap = new Map();
  for (const m of h2hRows) {
    h2hMap.set([m.date, m.home, m.away].join('|'), m);
  }
  const h2h = [...h2hMap.values()]
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
    .slice(0, 4)
    .map(m => ({
      tarih: m.date,
      ev: m.home,
      deplasman: m.away,
      evGol: m.homeScore,
      deplasmanGol: m.awayScore
    }));

  delete homePack._allMatches;
  delete awayPack._allMatches;

  return {
    mac: {
      ev: home.name,
      deplasman: away.name,
      tarih: matchDate || null,
      url: match.href,
      id: match.pathname.split('/').filter(Boolean).pop() || null
    },
    evTakimi: homePack,
    deplasmanTakimi: awayPack,
    h2h: { bulunan: h2h.length, hedef: 4, kaynak: 'BetExplorer', maclar: h2h },
    meta: {
      kaynak: 'BetExplorer',
      olusturmaZamani: new Date().toISOString(),
      homeUrl: homeLink.url,
      awayUrl: awayLink.url,
      engineVersion: 80
    },
    cache: false
  };
}


function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function objectHasAny(obj, keys) {
  if (!obj || typeof obj !== 'object') return false;
  return keys.some(key => {
    const value = obj[key];
    if (finiteNumber(value)) return true;
    if (Array.isArray(value)) return value.length > 0;
    return value != null && value !== '';
  });
}

function bothTeams(data, predicate) {
  return predicate(data?.evTakimi) && predicate(data?.deplasmanTakimi);
}

function hasForm(team, period = 'son5') {
  const result = team?.[period]?.sonuc;
  return finiteNumber(result?.mac) && result.mac > 0;
}

function hasHomeAwayForm(team) {
  const result = team?.son5?.sonuc;
  return Boolean(
    result &&
    finiteNumber(result?.ev?.mac) &&
    finiteNumber(result?.deplasman?.mac) &&
    result.ev.mac + result.deplasman.mac > 0
  );
}

function hasGoals(team) {
  const result = team?.son5?.sonuc;
  return finiteNumber(result?.attigiGol) && finiteNumber(result?.yedigiGol);
}

function hasXg(team) {
  return finiteNumber(team?.son5?.xG);
}

function hasXga(team) {
  return finiteNumber(team?.son5?.xGA);
}

function hasLeague(team) {
  return Boolean(
    team?.ligDurumu &&
    finiteNumber(team.ligDurumu.sira) &&
    finiteNumber(team.ligDurumu.puan)
  );
}

function hasFixtureCongestion(team) {
  return Boolean(
    team?.fiksturYogunlugu &&
    finiteNumber(team.fiksturYogunlugu.sonraki7Gun) &&
    finiteNumber(team.fiksturYogunlugu.sonraki14Gun)
  );
}

function hasMatchHistory(team) {
  return Array.isArray(team?.maclar) && team.maclar.length >= 3;
}

function hasUsableDefensiveStructure(team) {
  const context = team?.defensiveStructureContext;
  if (context?.source !== 'FotMob') return false;

  const hasWindow = window => [
    window?.tackles,
    window?.interceptions,
    window?.shotBlocks,
    window?.clearances
  ].some(finiteNumber);

  return hasWindow(context?.son5) || hasWindow(context?.son10);
}

function hasUsableProgressionSources(team) {
  const sources = team?.progressionSources;
  if (!sources || typeof sources !== 'object') return false;

  const fotMob = sources.FotMob;
  const fotMobUsable = Boolean(
    (
      (fotMob?.availability?.son5?.completeMatches || 0) > 0 &&
      finiteNumber(fotMob?.summary?.son5?.passesIntoFinalThirdTeamTotalAvg)
    ) ||
    (
      (fotMob?.availability?.son10?.completeMatches || 0) > 0 &&
      finiteNumber(fotMob?.summary?.son10?.passesIntoFinalThirdTeamTotalAvg)
    )
  );

  const scores365 = sources['365Scores'];
  const scores365Usable = Boolean(
    (
      (scores365?.availability?.son5?.dataMatches || 0) > 0 &&
      finiteNumber(scores365?.son5?.passesIntoFinalThird)
    ) ||
    (
      (scores365?.availability?.son10?.dataMatches || 0) > 0 &&
      finiteNumber(scores365?.son10?.passesIntoFinalThird)
    )
  );

  return fotMobUsable || scores365Usable;
}

function buildXgResultVsUnderlyingContext(team, sourceOverride = null) {
  const rows = (Array.isArray(team?.maclar) ? team.maclar : [])
    .slice(0, 5)
    .filter(row => {
      if (!finiteNumber(row?.xG)) return false;
      const isHome = teamNameMatches(row?.ev, team?.takim);
      const isAway = teamNameMatches(row?.deplasman, team?.takim);
      if (!isHome && !isAway) return false;
      const goals = isHome ? row?.evGol : row?.deplasmanGol;
      return finiteNumber(goals);
    });

  if (!rows.length) return null;

  const goals = rows.map(row =>
    teamNameMatches(row.ev, team.takim) ? row.evGol : row.deplasmanGol
  );
  const xg = rows.map(row => row.xG);
  const goalsPerMatch = Number(
    (goals.reduce((sum, value) => sum + value, 0) / rows.length).toFixed(2)
  );
  const xGPerMatch = Number(
    (xg.reduce((sum, value) => sum + value, 0) / rows.length).toFixed(2)
  );

  return {
    source: sourceOverride || team?.veriKaynagi || 'primary',
    basis: 'goals-vs-xg',
    dataMatches: rows.length,
    goalsPerMatch,
    xGPerMatch,
    goalsMinusXg: Number((goalsPerMatch - xGPerMatch).toFixed(2)),
    interpretationStatus: 'descriptive-result-vs-xg-no-weighting'
  };
}

function build365ResultVsUnderlyingContext(team) {
  const context = team?.underlyingConsistency;
  if (!context || typeof context !== 'object') return null;
  const usable = Object.values(context.indicators || {}).some(
    indicator => indicator?.relation && indicator.relation !== 'unavailable'
  );
  if (!usable || !context.goalsFor) return null;

  return {
    source: '365Scores',
    basis: 'goals-vs-shot-trend-support',
    comparison: context.comparison ?? null,
    goalsFor: context.goalsFor,
    indicators: context.indicators,
    interpretationStatus: 'shot-trend-support-not-xg'
  };
}

function buildTeamResultVsUnderlyingSources(primaryTeam, scores365Team, understatTeam, primarySource = null) {
  const sources = {};

  const primary = buildXgResultVsUnderlyingContext(primaryTeam, primarySource);
  if (primary) {
    sources[primary.source] = primary;
  }

  if (understatTeam?.resultVsUnderlying) {
    sources.Understat = understatTeam.resultVsUnderlying;
  }

  const scores365 = build365ResultVsUnderlyingContext(scores365Team);
  if (scores365) {
    sources['365Scores'] = scores365;
  }

  return sources;
}

function hasUsableResultVsUnderlying(team) {
  const sources = team?.resultVsUnderlyingSources;
  if (!sources || typeof sources !== 'object') return false;

  return Object.values(sources).some(context => {
    if (!context || typeof context !== 'object') return false;
    if (
      context.basis === 'goals-vs-xg' &&
      (context.dataMatches || 0) > 0 &&
      finiteNumber(context.goalsPerMatch) &&
      finiteNumber(context.xGPerMatch)
    ) {
      return true;
    }
    if (context.source === '365Scores') {
      return Object.values(context.indicators || {}).some(
        indicator => indicator?.relation && indicator.relation !== 'unavailable'
      );
    }
    return false;
  });
}

function hasUsablePlayingStyle(team) {
  const sources = team?.styleSources;
  if (!sources || typeof sources !== 'object') return false;

  const fotMob = sources.FotMob;
  const fotMobUsable = Boolean(
    (
      (fotMob?.coverage?.son5?.dataMatches?.accurateLongBalls || 0) > 0 &&
      finiteNumber(fotMob?.son5?.accurateLongBalls)
    ) ||
    (
      (fotMob?.coverage?.son5?.dataMatches?.accurateCrosses || 0) > 0 &&
      finiteNumber(fotMob?.son5?.accurateCrosses)
    ) ||
    (
      (fotMob?.coverage?.son10?.dataMatches?.accurateLongBalls || 0) > 0 &&
      finiteNumber(fotMob?.son10?.accurateLongBalls)
    ) ||
    (
      (fotMob?.coverage?.son10?.dataMatches?.accurateCrosses || 0) > 0 &&
      finiteNumber(fotMob?.son10?.accurateCrosses)
    )
  );

  const scores365 = sources['365Scores'];
  const styleKeys = [
    'backwardPasses',
    'passesIntoFinalThird',
    'passesOppositionHalf',
    'passesOwnHalf',
    'longPassesCompleted',
    'longPassesAttempted',
    'crossesCompleted',
    'crossesAttempted',
    'keyPasses',
    'totalPasses',
    'passesCompleted'
  ];
  const scores365Usable = Boolean(
    [scores365?.son5, scores365?.son10].some(section =>
      styleKeys.some(key => finiteNumber(section?.[key]))
    )
  );

  return fotMobUsable || scores365Usable;
}

function evaluatePerformanceCoverage(data) {
  const checks = {
    general_strength: bothTeams(data, hasLeague),
    recent_form: bothTeams(data, team => hasForm(team, 'son5')),
    extended_form: bothTeams(data, team => hasForm(team, 'son10')),
    home_away_form: bothTeams(data, hasHomeAwayForm),
    opponent_quality: bothTeams(data, team =>
      objectHasAny(team, ['rakipKalitesi', 'opponentQuality'])
    ),
    goals_for_against: bothTeams(data, hasGoals),
    xg: bothTeams(data, hasXg),
    xga: bothTeams(data, hasXga),
    xg_differential: bothTeams(data, team => hasXg(team) && hasXga(team)),
    shot_quality: bothTeams(data, team =>
      objectHasAny(team?.standartIstatistik?.son5, ['shots', 'shotsOnTarget']) ||
      objectHasAny(team, ['shotQuality', 'sutlar', 'sutKalitesi'])
    ),
    big_chances: bothTeams(data, team =>
      objectHasAny(team?.standartIstatistik?.son5, ['bigChances']) ||
      objectHasAny(team, ['buyukPozisyonlar'])
    ),
    box_dominance: bothTeams(data, team =>
      objectHasAny(team?.standartIstatistik?.son5, ['shotsInsideBox', 'touchesOppBox']) ||
      objectHasAny(team, ['boxEntries', 'boxTouches', 'cezaSahasi'])
    ),
    progression: bothTeams(data, team =>
      objectHasAny(team, ['progression', 'progressivePasses', 'xT', 'epv']) ||
      hasUsableProgressionSources(team)
    ),
    possession_quality: bothTeams(data, team =>
      objectHasAny(team?.standartIstatistik?.son5, ['possession']) ||
      objectHasAny(team, ['fieldTilt', 'possessionQuality'])
    ),
    pressing: bothTeams(data, team =>
      objectHasAny(team, ['ppda', 'pressing', 'highTurnovers'])
    ),
    transitions: bothTeams(data, team =>
      objectHasAny(team, ['transitions', 'counterAttacks', 'kontralar'])
    ),
    defensive_structure: bothTeams(data, team =>
      objectHasAny(team, ['defensiveStructure', 'savunmaYapisi']) ||
      hasUsableDefensiveStructure(team)
    ),
    set_pieces: bothTeams(data, team =>
      objectHasAny(team?.standartIstatistik?.son5, ['corners']) ||
      objectHasAny(team, ['setPieces', 'duranTop'])
    ),
    goalkeeper: bothTeams(data, team =>
      objectHasAny(team?.standartIstatistik?.son5, ['keeperSaves']) ||
      objectHasAny(team, ['goalkeeper', 'psxg', 'kaleci'])
    ),
    lineups: bothTeams(data, team =>
      Array.isArray(team?.lineup?.sonMac?.starters) &&
      team.lineup.sonMac.starters.length >= 11
    ),
    absences: bothTeams(data, team => team?.eksikVerisi === true),
    player_form: bothTeams(data, team =>
      Array.isArray(team?.oyuncuFormu?.players) &&
      team.oyuncuFormu.players.some(player => player.ratingMatches > 0)
    ),
    playing_style: bothTeams(data, hasUsablePlayingStyle),
    tactical_matchup: bothTeams(data, team =>
      objectHasAny(team, ['tactics', 'formation', 'taktik'])
    ),
    coach_system_changes: bothTeams(data, team =>
      (team?.teknikSistemDegisimi?.dataMatches || 0) >= 2
    ),
    fixture_congestion: bothTeams(data, hasFixtureCongestion),
    travel: bothTeams(data, team =>
      objectHasAny(team, ['travel', 'seyahat'])
    ),
    match_context: Boolean(
      data?.matchContext ||
      data?.mac?.importance ||
      data?.mac?.context
    ),
    table_season_stage: Boolean(
      data?.tableSeasonStage ||
      data?.seasonStage ||
      data?.ligAsamasi
    ),
    weather_pitch: Boolean(data?.weather || data?.pitch || data?.hava),
    referee: Boolean(data?.referee || data?.hakem),
    h2h: finiteNumber(data?.h2h?.bulunan) && data.h2h.bulunan > 0,
    score_state: bothTeams(data, team =>
      objectHasAny(team, ['scoreState', 'skorDurumu'])
    ),
    red_card_context: bothTeams(data, team =>
      objectHasAny(team?.standartIstatistik?.son5, ['redCards']) ||
      objectHasAny(team, ['redCardContext', 'kirmiziKart'])
    ),
    result_vs_underlying: bothTeams(data, hasUsableResultVsUnderlying),
    match_history: bothTeams(data, hasMatchHistory),
    match_identity: Boolean(data?.mac?.ev && data?.mac?.deplasman),
    source_provenance: Boolean(
      data?.meta?.kaynak ||
      data?.evTakimi?.veriKaynagi ||
      data?.deplasmanTakimi?.veriKaynagi
    )
  };

  const available = Object.entries(checks)
    .filter(([, value]) => value)
    .map(([key]) => key);
  const missing = Object.entries(checks)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
  const total = available.length + missing.length;
  const score = total ? Math.round((available.length / total) * 100) : 0;

  return {
    score,
    available_count: available.length,
    total_count: total,
    available,
    missing
  };
}


function needsBetExplorerSupplement(data, coverage) {
  if (!data || !coverage) return false;
  if (coverage.score > 35) return false;

  const home = data.evTakimi;
  const away = data.deplasmanTakimi;
  const noAdvancedData =
    !finiteNumber(home?.son5?.xG) &&
    !finiteNumber(away?.son5?.xG) &&
    !objectHasAny(home?.standartIstatistik?.son5, ['shots', 'shotsOnTarget']) &&
    !objectHasAny(away?.standartIstatistik?.son5, ['shots', 'shotsOnTarget']) &&
    !(home?.lineup?.veriMac > 0) &&
    !(away?.lineup?.veriMac > 0);

  return noAdvancedData;
}

function compactBetExplorerSupplement(data) {
  const compactTeam = team => ({
    takim: team?.takim ?? null,
    son5: team?.son5 ?? null,
    son10: team?.son10 ?? null,
    maclar: Array.isArray(team?.maclar) ? team.maclar.slice(0, 10) : []
  });

  return {
    source: 'BetExplorer',
    collected_at: new Date().toISOString(),
    home: compactTeam(data?.evTakimi),
    away: compactTeam(data?.deplasmanTakimi),
    h2h: data?.h2h ?? null,
    provenance: {
      homeUrl: data?.meta?.homeUrl ?? null,
      awayUrl: data?.meta?.awayUrl ?? null
    }
  };
}



function mackolikPlainText(value) {
  return decodeHtmlValue(
    String(value || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  );
}

function parseMackolikNumber(value) {
  const text = mackolikPlainText(value).replace('%', '').replace(',', '.');
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function parseMackolikFixtureIdentity(html) {
  const source = String(html || '');
  const title = source.match(
    /<title>\s*(.*?)\s*-\s*(.*?)\s*\((\d{2}\.\d{2}\.\d{4})\)\s*Maç Detayı/i
  );
  const score = source.match(
    /<meta\s+property=["']og:title["']\s+content=["'](.*?)\s+(\d+)\s*-\s*(\d+)\s+(.*?)\s+MS\s+(\d{2}\.\d{2}\.\d{4})["']/i
  );

  return {
    home: title ? mackolikPlainText(title[1]) : score ? mackolikPlainText(score[1]) : null,
    away: title ? mackolikPlainText(title[2]) : score ? mackolikPlainText(score[4]) : null,
    date: title ? title[3] : score ? score[5] : null,
    homeScore: score ? Number(score[2]) : null,
    awayScore: score ? Number(score[3]) : null
  };
}

function mackolikDateKey(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const dmy = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dmy) return dmy[3] + '-' + dmy[2] + '-' + dmy[1];
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? iso[1] + '-' + iso[2] + '-' + iso[3] : null;
}

function validateMackolikFixture(html, input) {
  const identity = parseMackolikFixtureIdentity(html);
  const homeOk = teamNameMatches(identity.home, mackolikInputTeamName(input?.home));
  const awayOk = teamNameMatches(identity.away, mackolikInputTeamName(input?.away));
  const expectedDate = mackolikDateKey(input?.matchDate);
  const actualDate = mackolikDateKey(identity.date);
  const dateOk = !expectedDate || (actualDate && expectedDate === actualDate);

  return {
    ok: Boolean(homeOk && awayOk && dateOk),
    homeOk,
    awayOk,
    dateOk,
    identity
  };
}

function parseMackolikStats(html) {
  const source = String(html || '');
  const rows = {};
  const statRe = /<div class=["']team-1-statistics-text["'][^>]*>([\s\S]*?)<\/div>\s*<div class=["']statistics-title-text["'][^>]*>([\s\S]*?)<\/div>\s*<div class=["']team-2-statistics-text["'][^>]*>([\s\S]*?)<\/div>/gi;
  let row;

  while ((row = statRe.exec(source))) {
    const name = mackolikPlainText(row[2]);
    const homeValue = parseMackolikNumber(row[1]);
    const awayValue = parseMackolikNumber(row[3]);
    if (!name || homeValue === null || awayValue === null) continue;

    rows[name] = { home: homeValue, away: awayValue };
  }

  const aliases = {
    possession: ['Topla Oynama'],
    shots: ['Toplam Şut'],
    shotsOnTarget: ['İsabetli Şut'],
    woodwork: ['Direkten Dönen'],
    corners: ['Köşe Vuruşu', 'Korner'],
    fouls: ['Fauller', 'Faul'],
    offsides: ['Ofsaytlar', 'Ofsayt']
  };

  const pick = names => {
    for (const name of names) {
      if (rows[name]) return rows[name];
    }
    return null;
  };

  const fields = {};
  for (const [key, names] of Object.entries(aliases)) {
    const value = pick(names);
    if (value) fields[key] = value;
  }
  return fields;
}

function buildMackolikFieldSupplementFromHtml(html, input, sourceUrl = null) {
  const validation = validateMackolikFixture(html, input);
  if (!validation.ok) return null;

  const fields = parseMackolikStats(html);
  if (!Object.keys(fields).length) return {
    source: 'Mackolik',
    exactFixture: true,
    fields: {},
    provenance: {
      sourceUrl,
      policy: 'field-level-only',
      missingFieldsRemainNull: true,
      crossProviderAverage: false
    }
  };

  return {
    source: 'Mackolik',
    exactFixture: true,
    fields,
    provenance: {
      sourceUrl,
      policy: 'field-level-only',
      missingFieldsRemainNull: true,
      crossProviderAverage: false
    }
  };
}



function mackolikInputTeamName(value) {
  if (typeof value === 'string') return value.trim();
  return String(value?.name || value?.team || value?.takim || '').trim();
}

async function fetchMackolikText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': UA,
        'accept-language': 'tr-TR,tr;q=0.9,en;q=0.8'
      }
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function mackolikTeamCandidatesFromSearch(html, teamName) {
  const source = String(html || '');
  const out = [];
  const re = /\{text:'([^']*)'[\s\S]*?desc:'Takım\s*-\s*([^']*)'[\s\S]*?url:'(\/\/arsiv\.mackolik\.com\/Takim\/(\d+)\/[^']+)'/gi;
  let match;
  while ((match = re.exec(source))) {
    const name = mackolikPlainText(match[1]);
    const url = 'https:' + match[3];
    let score = 0;
    if (teamNameMatches(name, teamName)) score += 1000;
    if (foldName(name) === foldName(teamName)) score += 500;
    out.push({
      name,
      country: mackolikPlainText(match[2]),
      teamId: Number(match[4]),
      url,
      score
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

async function resolveMackolikTeam(teamName) {
  const name = String(teamName || '').trim();
  if (!name) return null;
  const searchUrl =
    'https://arsiv.mackolik.com/AjaxHandlers/SearchHandler.aspx?q=' +
    encodeURIComponent(name);
  const html = await fetchMackolikText(searchUrl);
  if (!html) return null;
  const candidates = mackolikTeamCandidatesFromSearch(html, name);
  return candidates.find(candidate => candidate.score >= 1000) || null;
}

function mackolikMatchLinksFromTeamPage(html) {
  const source = String(html || '');
  const out = [];
  const seen = new Set();
  const re = /(?:https?:)?\/\/arsiv\.mackolik\.com\/Karsilastirma\/(\d+)\/([^"'#<\s]+)/gi;
  let match;
  while ((match = re.exec(source))) {
    const url =
      'https://arsiv.mackolik.com/Karsilastirma/' +
      match[1] +
      '/' +
      match[2];
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ matchId: Number(match[1]), slug: match[2], url });
  }
  return out;
}

function mackolikLinkTeamHintScore(link, homeName, awayName) {
  const slug = foldName(String(link?.slug || '').replace(/-/g, ' '));
  if (!slug) return 0;
  const home = foldName(homeName);
  const away = foldName(awayName);
  let score = 0;
  if (home && slug.includes(home)) score += 2;
  if (away && slug.includes(away)) score += 2;

  const homeWords = home.split(' ').filter(word => word.length >= 4);
  const awayWords = away.split(' ').filter(word => word.length >= 4);
  if (homeWords.some(word => slug.includes(word))) score += 1;
  if (awayWords.some(word => slug.includes(word))) score += 1;
  return score;
}

async function resolveMackolikExactFixture(input) {
  const homeName = mackolikInputTeamName(input?.home);
  const awayName = mackolikInputTeamName(input?.away);
  if (!homeName || !awayName) return null;

  const [homeTeam, awayTeam] = await Promise.all([
    resolveMackolikTeam(homeName),
    resolveMackolikTeam(awayName)
  ]);
  if (!homeTeam && !awayTeam) return null;

  const pages = await Promise.all(
    [homeTeam, awayTeam]
      .filter(Boolean)
      .map(async team => ({
        team,
        html: await fetchMackolikText(team.url)
      }))
  );

  const links = [];
  const seen = new Set();
  for (const page of pages) {
    for (const link of mackolikMatchLinksFromTeamPage(page.html)) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      links.push(link);
    }
  }

  const candidates = links
    .map(link => ({
      ...link,
      hintScore: mackolikLinkTeamHintScore(link, homeName, awayName)
    }))
    .filter(link => link.hintScore >= 2)
    .sort((a, b) => b.hintScore - a.hintScore)
    .slice(0, 8);

  const normalizedInput = {
    ...input,
    home: homeName,
    away: awayName
  };

  for (const candidate of candidates) {
    const html = await fetchMackolikText(candidate.url);
    if (!html) continue;
    const validation = validateMackolikFixture(html, normalizedInput);
    if (!validation.ok) continue;
    return {
      source: 'Mackolik',
      matchId: candidate.matchId,
      url: candidate.url,
      html,
      identity: validation.identity,
      homeTeam,
      awayTeam
    };
  }

  return null;
}

async function fetch365ScoresJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': UA,
        'accept': 'application/json,text/plain,*/*',
        'accept-language': 'en-US,en;q=0.9'
      }
    });
    if (!response.ok) {
      throw new Error('365Scores HTTP ' + response.status);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function resolve365ScoresTeam(teamName) {
  const url =
    'https://webws.365scores.com/web/search/?appTypeId=5&langId=1&query=' +
    encodeURIComponent(teamName);
  const data = await fetch365ScoresJson(url);
  const candidates = Array.isArray(data?.competitors) ? data.competitors : [];

  const ranked = candidates
    .filter(item => Number(item?.sportId) === 1)
    .map(item => ({
      item,
      score:
        foldName(item?.name) === foldName(teamName)
          ? 1000
          : teamNameMatches(item?.name, teamName)
            ? 900
            : (
                foldName(item?.name).includes(foldName(teamName)) ||
                foldName(teamName).includes(foldName(item?.name))
              )
              ? 700
              : 0
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked.find(row => row.score >= 700);
  if (!best) {
    throw new Error('365Scores team not found: ' + teamName);
  }

  const countryId = best.item.countryId ?? null;
  const country = (Array.isArray(data?.countries) ? data.countries : [])
    .find(item => Number(item?.id) === Number(countryId)) || null;

  return {
    id: Number(best.item.id),
    name: best.item.name,
    countryId,
    countryName: country?.name ?? null,
    mainCompetitionId: best.item.mainCompetitionId ?? null
  };
}


const scores365StandingsCache = new Map();


function build365ScoresTableBand(position, tableSize) {
  if (!finiteNumber(position) || !finiteNumber(tableSize) || tableSize <= 0) {
    return null;
  }
  if (position === 1) return 'leader';

  const ratio = position / tableSize;
  if (ratio <= 0.25) return 'top_quarter';
  if (ratio <= 0.75) return 'middle_half';
  return 'bottom_quarter';
}

async function fetch365ScoresStandings(competitionId) {
  const key = String(competitionId || '');
  if (!key) return new Map();

  const cached = scores365StandingsCache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
    return cached.rows;
  }

  const url =
    'https://webws.365scores.com/web/standings/?appTypeId=5&langId=1' +
    '&timezoneName=Europe/Istanbul&userCountryId=-1&competitions=' +
    encodeURIComponent(competitionId);
  const data = await fetch365ScoresJson(url);
  const table = (Array.isArray(data?.standings) ? data.standings : [])
    .find(item => Number(item?.competitionId) === Number(competitionId));
  const rows = new Map();
  const destinations = new Map(
    (table?.destinations || [])
      .filter(item => item?.num != null)
      .map(item => [Number(item.num), {
        num: Number(item.num),
        name: item?.name ?? null,
        guaranteedText: item?.guaranteedText ?? null,
        type: item?.type ?? null
      }])
  );
  const tableSize = Array.isArray(table?.rows) ? table.rows.length : 0;

  for (const row of table?.rows || []) {
    const competitorId = Number(row?.competitor?.id);
    if (!Number.isFinite(competitorId)) continue;
    const position = finiteNumber(Number(row?.position))
      ? Number(row.position)
      : null;
    const destinationNum = finiteNumber(Number(row?.destinationNum))
      ? Number(row.destinationNum)
      : null;

    rows.set(competitorId, {
      competitorId,
      name: row?.competitor?.name ?? null,
      position,
      points: finiteNumber(Number(row?.points)) ? Number(row.points) : null,
      played: finiteNumber(Number(row?.gamePlayed)) ? Number(row.gamePlayed) : null,
      won: finiteNumber(Number(row?.gamesWon)) ? Number(row.gamesWon) : null,
      drawn: finiteNumber(Number(row?.gamesEven)) ? Number(row.gamesEven) : null,
      lost: finiteNumber(Number(row?.gamesLost)) ? Number(row.gamesLost) : null,
      goalsFor: finiteNumber(Number(row?.for)) ? Number(row.for) : null,
      goalsAgainst: finiteNumber(Number(row?.against)) ? Number(row.against) : null,
      goalDifference: finiteNumber(Number(row?.ratio)) ? Number(row.ratio) : null,
      raceContext: {
        tableBand: build365ScoresTableBand(position, tableSize),
        officialDestination: destinationNum != null
          ? destinations.get(destinationNum) || { num: destinationNum }
          : null
      }
    });
  }

  const context = {
    source: '365Scores',
    basis: 'current-competition-snapshot',
    competitionId: Number(competitionId),
    name: table?.displayName ?? null,
    seasonNum: table?.seasonNum ?? null,
    stageNum: table?.stageNum ?? null,
    isCurrentStage: table?.isCurrentStage ?? null,
    tableSize: rows.size,
    destinations: Array.from(destinations.values()),
    standingsUpdateId: data?.lastUpdateId ?? null
  };

  scores365StandingsCache.set(key, {
    at: Date.now(),
    rows,
    context
  });
  return rows;
}

async function fetch365ScoresCompetitionContext(competitionId) {
  const key = String(competitionId || '');
  if (!key) return null;

  await fetch365ScoresStandings(competitionId);
  const cached = scores365StandingsCache.get(key);
  if (!cached?.context) return null;

  return {
    ...cached.context,
    tableSize: cached.rows?.size ?? cached.context.tableSize ?? null
  };
}

async function fetch365ScoresResults(competitorId, beforeMs = Date.now()) {
  const url =
    'https://webws.365scores.com/web/games/results/?appTypeId=5&langId=1' +
    '&timezoneName=Europe/Istanbul&userCountryId=-1&competitors=' +
    encodeURIComponent(competitorId);
  const data = await fetch365ScoresJson(url);
  const games = Array.isArray(data?.games) ? data.games : [];

  return games
    .filter(game => {
      const belongs =
        Number(game?.homeCompetitor?.id) === Number(competitorId) ||
        Number(game?.awayCompetitor?.id) === Number(competitorId);
      const startedAt = Date.parse(game?.startTime || '');
      const isPast =
        Number.isFinite(startedAt) &&
        startedAt < beforeMs;
      return belongs && isPast;
    })
    .sort((a, b) => Date.parse(b?.startTime || 0) - Date.parse(a?.startTime || 0));
}



async function fetch365ScoresTargetGame(
  homeCompetitorId,
  awayCompetitorId,
  competitionId,
  referenceMs
) {
  if (
    !Number.isFinite(Number(homeCompetitorId)) ||
    !Number.isFinite(Number(awayCompetitorId)) ||
    !Number.isFinite(referenceMs)
  ) {
    return null;
  }

  const homeId = Number(homeCompetitorId);
  const awayId = Number(awayCompetitorId);
  const isTarget = game =>
    Number(game?.homeCompetitor?.id) === homeId &&
    Number(game?.awayCompetitor?.id) === awayId;
  const withinWindow = game => {
    const startedAt = Date.parse(game?.startTime || '');
    return (
      Number.isFinite(startedAt) &&
      Math.abs(startedAt - referenceMs) <= 36 * 60 * 60 * 1000
    );
  };
  const chooseClosest = games =>
    games
      .filter(game => isTarget(game) && withinWindow(game))
      .sort(
        (a, b) =>
          Math.abs(Date.parse(a?.startTime || '') - referenceMs) -
          Math.abs(Date.parse(b?.startTime || '') - referenceMs)
      )[0] || null;

  const resultsUrl =
    'https://webws.365scores.com/web/games/results/?appTypeId=5&langId=1' +
    '&timezoneName=Europe/Istanbul&userCountryId=-1&competitors=' +
    encodeURIComponent(homeId);
  const resultsData = await fetch365ScoresJson(resultsUrl);
  const fromResults = chooseClosest(
    Array.isArray(resultsData?.games) ? resultsData.games : []
  );
  if (fromResults) return fromResults;

  if (!competitionId) return null;

  const startMs = referenceMs - 24 * 60 * 60 * 1000;
  const endMs = referenceMs + 24 * 60 * 60 * 1000;
  const gamesUrl =
    'https://webws.365scores.com/web/games/?appTypeId=5&langId=1' +
    '&timezoneName=Europe/Istanbul&userCountryId=-1&competitions=' +
    encodeURIComponent(competitionId) +
    '&startDate=' + encodeURIComponent(format365ScoresDate(startMs)) +
    '&endDate=' + encodeURIComponent(format365ScoresDate(endMs));
  const gamesData = await fetch365ScoresJson(gamesUrl);

  return chooseClosest(
    Array.isArray(gamesData?.games) ? gamesData.games : []
  );
}

function format365ScoresDate(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).formatToParts(new Date(ms));
  const get = type => parts.find(part => part.type === type)?.value;
  return [get('day'), get('month'), get('year')].join('/');
}

async function fetch365ScoresUpcoming(competitionId, competitorId, referenceMs) {
  if (!competitionId || !Number.isFinite(referenceMs)) return [];

  const endMs = referenceMs + 14 * 86400000;
  const url =
    'https://webws.365scores.com/web/games/?appTypeId=5&langId=1' +
    '&timezoneName=Europe/Istanbul&userCountryId=-1&competitions=' +
    encodeURIComponent(competitionId) +
    '&startDate=' + encodeURIComponent(format365ScoresDate(referenceMs)) +
    '&endDate=' + encodeURIComponent(format365ScoresDate(endMs));
  const data = await fetch365ScoresJson(url);
  const games = Array.isArray(data?.games) ? data.games : [];

  return games
    .filter(game => {
      const belongs =
        Number(game?.homeCompetitor?.id) === Number(competitorId) ||
        Number(game?.awayCompetitor?.id) === Number(competitorId);
      const startedAt = Date.parse(game?.startTime || '');
      return (
        belongs &&
        Number.isFinite(startedAt) &&
        startedAt > referenceMs + 30 * 60 * 1000 &&
        startedAt <= endMs
      );
    })
    .sort((a, b) => Date.parse(a?.startTime || 0) - Date.parse(b?.startTime || 0));
}

function daysBetween(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Number(((toMs - fromMs) / 86400000).toFixed(2));
}

function build365ScoresRestFixture(history, upcoming, referenceMs) {
  const previous = history[0] || null;
  const next = upcoming[0] || null;
  const previousMs = Date.parse(previous?.startTime || '');
  const nextMs = Date.parse(next?.startTime || '');

  return {
    referenceTime: new Date(referenceMs).toISOString(),
    previousMatch: previous ? {
      id: previous.id ?? null,
      date: previous.startTime ?? null,
      home: previous?.homeCompetitor?.name ?? null,
      away: previous?.awayCompetitor?.name ?? null
    } : null,
    daysSincePreviousMatch: Number.isFinite(previousMs)
      ? daysBetween(previousMs, referenceMs)
      : null,
    nextMatch: next ? {
      id: next.id ?? null,
      date: next.startTime ?? null,
      home: next?.homeCompetitor?.name ?? null,
      away: next?.awayCompetitor?.name ?? null
    } : null,
    daysUntilNextMatch: Number.isFinite(nextMs)
      ? daysBetween(referenceMs, nextMs)
      : null,
    next7DaysCount: upcoming.filter(game =>
      Date.parse(game?.startTime || '') <= referenceMs + 7 * 86400000
    ).length,
    next14DaysCount: upcoming.length
  };
}

function parse365StatValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const m = String(value ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function parse365RatioStatValue(value) {
  const m = String(value ?? '')
    .replace(',', '.')
    .trim()
    .match(/^(\d+)\s*\/\s*(\d+)\s*\((\d+(?:\.\d+)?)%\)$/);
  if (!m) return null;
  return {
    completed: Number(m[1]),
    attempted: Number(m[2]),
    pct: Number(m[3])
  };
}

function assign365MappedStat(target, key, rawValue) {
  if (!target || !key) return;

  if (
    key === 'longPassesCompletedRatio' ||
    key === 'crossesCompletedRatio'
  ) {
    const ratio = parse365RatioStatValue(rawValue);
    if (!ratio) return;
    const prefix =
      key === 'longPassesCompletedRatio' ? 'longPasses' : 'crosses';
    target[prefix + 'Completed'] = ratio.completed;
    target[prefix + 'Attempted'] = ratio.attempted;
    target[prefix + 'Pct'] = ratio.pct;
    return;
  }

  const parsed = parse365StatValue(rawValue);
  if (parsed != null) target[key] = parsed;
}

function map365StatName(name) {
  const key = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const aliases = {
    totalshots: 'shots',
    shotsontarget: 'shotsOnTarget',
    shotsofftarget: 'shotsOffTarget',
    corners: 'corners',
    freekicks: 'freeKicks',
    throwins: 'throwIns',
    goalkicks: 'goalKicks',
    possession: 'possession',
    yellowcards: 'yellowCards',
    redcards: 'redCards',
    attacks: 'attacks',
    offsides: 'offsides',
    backwardpasses: 'backwardPasses',
    passesintofinalthird: 'passesIntoFinalThird',
    passesoppositionhalf: 'passesOppositionHalf',
    passesownhalf: 'passesOwnHalf',
    longpassescompleted: 'longPassesCompletedRatio',
    crossescompleted: 'crossesCompletedRatio',
    finalthirdpossessionwon: 'finalThirdPossessionWon',
    possessionlost: 'possessionLost',
    keypasses: 'keyPasses',
    totalpasses: 'totalPasses',
    passescompleted: 'passesCompleted'
  };
  return aliases[key] || null;
}


const scores365GameTimelineCache = new Map();

async function fetch365ScoresGameTimeline(gameId) {
  const key = String(gameId || '');
  if (!key) return null;

  if (scores365GameTimelineCache.has(key)) {
    return scores365GameTimelineCache.get(key);
  }

  const promise = (async () => {
    const url =
      'https://webws.365scores.com/web/game/?appTypeId=5&langId=1' +
      '&timezoneName=Europe/Istanbul&userCountryId=-1&gameId=' +
      encodeURIComponent(gameId);
    const data = await fetch365ScoresJson(url);
    const game = data?.game || null;
    if (!game) return null;

    const rawEvents = Array.isArray(game.events) ? game.events : [];
    const compactTimelineEvent = event => {
      const baseMinute = finiteNumber(Number(event?.gameTime))
        ? Number(event.gameTime)
        : null;
      const added = finiteNumber(Number(event?.addedTime))
        ? Number(event.addedTime)
        : 0;
      const minute = baseMinute == null
        ? null
        : baseMinute + (baseMinute === 45 || baseMinute === 90 ? added : 0);

      return {
        competitorId: event?.competitorId ?? null,
        minute,
        gameTime: baseMinute,
        addedTime: added,
        display: event?.gameTimeDisplay ?? null,
        order: event?.order ?? null
      };
    };
    const sortTimeline = (a, b) =>
      a.minute - b.minute ||
      Number(a.order || 0) - Number(b.order || 0);

    const goals = rawEvents
      .filter(event =>
        Number(event?.eventType?.id) === 1 ||
        String(event?.eventType?.name || '').toLowerCase() === 'goal'
      )
      .map(compactTimelineEvent)
      .filter(event => finiteNumber(event.minute))
      .sort(sortTimeline);

    const redCards = rawEvents
      .filter(event => {
        const label = (
          String(event?.eventType?.name || '') + ' ' +
          String(event?.eventType?.subTypeName || '')
        ).toLowerCase();
        return label.includes('red') && label.includes('card');
      })
      .map(compactTimelineEvent)
      .filter(event => finiteNumber(event.minute))
      .sort(sortTimeline);

    const allEventMinutes = rawEvents
      .map(compactTimelineEvent)
      .map(event => event.minute)
      .filter(finiteNumber);
    const durationMinutes = Math.max(
      90,
      finiteNumber(Number(game?.gameTime)) ? Number(game.gameTime) : 0,
      ...allEventMinutes
    );

    const countryMap = new Map(
      (Array.isArray(data?.countries) ? data.countries : [])
        .filter(item => item?.id != null)
        .map(item => [Number(item.id), item?.name ?? null])
    );
    const homeCountryId = game?.homeCompetitor?.countryId ?? null;
    const awayCountryId = game?.awayCompetitor?.countryId ?? null;

    return {
      gameId: game?.id ?? gameId,
      homeCompetitorId: game?.homeCompetitor?.id ?? null,
      awayCompetitorId: game?.awayCompetitor?.id ?? null,
      homeCountry: {
        id: homeCountryId,
        name: countryMap.get(Number(homeCountryId)) ?? null
      },
      awayCountry: {
        id: awayCountryId,
        name: countryMap.get(Number(awayCountryId)) ?? null
      },
      venue: game?.venue ? {
        id: game.venue.id ?? null,
        name: game.venue.name ?? null,
        shortName: game.venue.shortName ?? null,
        capacity: finiteNumber(Number(game.venue.capacity))
          ? Number(game.venue.capacity)
          : null
      } : null,
      durationMinutes,
      goals,
      redCards
    };
  })();

  scores365GameTimelineCache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    scores365GameTimelineCache.delete(key);
    throw error;
  }
}



function build365ScoresTravelContext(timeline, competitorId) {
  if (!timeline) return null;

  const teamId = Number(competitorId);
  const homeId = Number(timeline.homeCompetitorId);
  const awayId = Number(timeline.awayCompetitorId);
  const isHome = teamId === homeId;
  const isAway = teamId === awayId;
  if (!isHome && !isAway) return null;

  const originCountry = isHome
    ? timeline.homeCountry || null
    : timeline.awayCountry || null;
  const destinationCountry = timeline.homeCountry || null;
  const sameCountry =
    originCountry?.id != null &&
    destinationCountry?.id != null
      ? Number(originCountry.id) === Number(destinationCountry.id)
      : null;

  const missing = [];
  if (!timeline.venue?.name) missing.push('destinationVenue');
  missing.push('originCity', 'originCoordinates', 'destinationCoordinates', 'distanceKm');

  return {
    source: '365Scores',
    basis: 'venue-plus-competitor-country',
    role: isHome ? 'home' : 'away',
    travelRequired: isAway,
    originCountry,
    destinationCountry,
    sameCountry,
    destinationVenue: timeline.venue || null,
    originCity: null,
    destinationCity: null,
    originCoordinates: null,
    destinationCoordinates: null,
    distanceKm: null,
    status: isAway ? 'location-incomplete' : 'home-team',
    missing
  };
}

function summarize365ScoresTravelContext(rows) {
  const contexts = rows
    .map(row => row?.travelContext)
    .filter(Boolean);
  const away = contexts.filter(context => context.travelRequired === true);

  return {
    source: '365Scores',
    basis: 'recent-match-venue-country',
    dataMatches: contexts.length,
    awayMatches: away.length,
    venueKnownMatches: contexts.filter(context => context?.destinationVenue?.name).length,
    distanceKnownMatches: contexts.filter(context => finiteNumber(context?.distanceKm)).length,
    locationIncompleteMatches: away.filter(context => context.status === 'location-incomplete').length
  };
}


function build365ScoresWeatherPitchContext(targetGame, timeline) {
  if (!targetGame) {
    return {
      source: '365Scores',
      basis: 'target-match-venue-time',
      status: 'match-not-resolved',
      gameId: null,
      matchTime: null,
      venue: null,
      homeTeamCountry: null,
      awayTeamCountry: null,
      venueCity: null,
      venueCoordinates: null,
      weather: {
        temperatureC: null,
        precipitationMm: null,
        windKph: null,
        condition: null
      },
      pitch: {
        surface: null,
        condition: null
      },
      missing: [
        'targetMatch',
        'venueCity',
        'venueCoordinates',
        'weather',
        'pitch'
      ]
    };
  }

  const venue = timeline?.venue || (
    targetGame?.venue
      ? {
          id: targetGame.venue.id ?? null,
          name: targetGame.venue.name ?? null,
          shortName: targetGame.venue.shortName ?? null,
          capacity: finiteNumber(Number(targetGame.venue.capacity))
            ? Number(targetGame.venue.capacity)
            : null
        }
      : null
  );

  return {
    source: '365Scores',
    basis: 'target-match-venue-time',
    status: 'location-incomplete',
    gameId: targetGame?.id ?? null,
    matchTime: targetGame?.startTime ?? null,
    venue,
    homeTeamCountry: timeline?.homeCountry || null,
    awayTeamCountry: timeline?.awayCountry || null,
    venueCity: null,
    venueCoordinates: null,
    weather: {
      temperatureC: null,
      precipitationMm: null,
      windKph: null,
      condition: null
    },
    pitch: {
      surface: null,
      condition: null
    },
    missing: [
      'venueCity',
      'venueCoordinates',
      'temperatureC',
      'precipitationMm',
      'windKph',
      'weatherCondition',
      'pitchSurface',
      'pitchCondition'
    ]
  };
}

function build365ScoresRedCardContext(timeline, competitorId, redCardStat) {
  const redCards = finiteNumber(redCardStat) ? Number(redCardStat) : null;
  if (redCards == null) return null;

  if (redCards === 0) {
    return {
      source: '365Scores',
      status: 'verified-no-red',
      redCards: 0,
      firstRedMinute: null,
      shortHandedMinutes: 0,
      events: []
    };
  }

  if (!timeline || !Array.isArray(timeline.redCards)) {
    return {
      source: '365Scores',
      status: 'event-time-missing',
      redCards,
      firstRedMinute: null,
      shortHandedMinutes: null,
      events: []
    };
  }

  const events = timeline.redCards.filter(
    event => Number(event?.competitorId) === Number(competitorId)
  );

  if (events.length !== redCards) {
    return {
      source: '365Scores',
      status: 'event-time-missing',
      redCards,
      firstRedMinute: null,
      shortHandedMinutes: null,
      events
    };
  }

  const durationMinutes = finiteNumber(timeline.durationMinutes)
    ? timeline.durationMinutes
    : Math.max(90, ...events.map(event => event.minute));
  const firstRedMinute = events[0]?.minute ?? null;

  if (!finiteNumber(firstRedMinute)) {
    return {
      source: '365Scores',
      status: 'event-time-missing',
      redCards,
      firstRedMinute: null,
      shortHandedMinutes: null,
      events
    };
  }

  return {
    source: '365Scores',
    status: 'verified-event',
    redCards,
    durationMinutes,
    firstRedMinute,
    shortHandedMinutes: Number(
      Math.max(0, durationMinutes - firstRedMinute).toFixed(2)
    ),
    events
  };
}

function build365ScoresScoreState(timeline, competitorId, goalsFor, goalsAgainst) {
  if (!timeline || !Array.isArray(timeline.goals)) return null;

  const homeId = Number(timeline.homeCompetitorId);
  const awayId = Number(timeline.awayCompetitorId);
  const teamId = Number(competitorId);
  const isHome = teamId === homeId;
  const isAway = teamId === awayId;
  if (!isHome && !isAway) return null;

  const effectiveGoals = timeline.goals.filter(event =>
    Number(event.competitorId) === homeId ||
    Number(event.competitorId) === awayId
  );

  const timelineHomeGoals = effectiveGoals.filter(
    event => Number(event.competitorId) === homeId
  ).length;
  const timelineAwayGoals = effectiveGoals.filter(
    event => Number(event.competitorId) === awayId
  ).length;
  const expectedHomeGoals = isHome ? goalsFor : goalsAgainst;
  const expectedAwayGoals = isHome ? goalsAgainst : goalsFor;

  if (
    !finiteNumber(expectedHomeGoals) ||
    !finiteNumber(expectedAwayGoals) ||
    timelineHomeGoals !== expectedHomeGoals ||
    timelineAwayGoals !== expectedAwayGoals
  ) {
    return null;
  }

  const durationMinutes = Math.max(
    90,
    ...effectiveGoals.map(event => event.minute)
  );

  let homeScore = 0;
  let awayScore = 0;
  let cursor = 0;
  const durations = {
    leadingMinutes: 0,
    drawingMinutes: 0,
    trailingMinutes: 0
  };

  const currentState = () => {
    const teamScore = isHome ? homeScore : awayScore;
    const opponentScore = isHome ? awayScore : homeScore;
    if (teamScore > opponentScore) return 'leadingMinutes';
    if (teamScore < opponentScore) return 'trailingMinutes';
    return 'drawingMinutes';
  };

  const goalEvents = [];

  for (const event of effectiveGoals) {
    const minute = Math.max(cursor, Math.min(durationMinutes, event.minute));
    durations[currentState()] += minute - cursor;

    if (Number(event.competitorId) === homeId) homeScore++;
    if (Number(event.competitorId) === awayId) awayScore++;

    goalEvents.push({
      minute: event.minute,
      display: event.display,
      competitorId: event.competitorId,
      teamStateAfterGoal: currentState().replace('Minutes', '')
    });
    cursor = minute;
  }

  durations[currentState()] += durationMinutes - cursor;

  const pct = value => durationMinutes > 0
    ? Number(((value / durationMinutes) * 100).toFixed(1))
    : null;

  return {
    source: '365Scores',
    basis: 'nominal-90-plus-recorded-stoppage-goal',
    durationMinutes,
    leadingMinutes: Number(durations.leadingMinutes.toFixed(2)),
    drawingMinutes: Number(durations.drawingMinutes.toFixed(2)),
    trailingMinutes: Number(durations.trailingMinutes.toFixed(2)),
    leadingPct: pct(durations.leadingMinutes),
    drawingPct: pct(durations.drawingMinutes),
    trailingPct: pct(durations.trailingMinutes),
    goalEvents
  };
}

async function fetch365ScoresGameStats(gameId, competitorId) {
  const url =
    'https://webws.365scores.com/web/game/stats/?appTypeId=5&langId=1' +
    '&timezoneName=Europe/Istanbul&userCountryId=-1&games=' +
    encodeURIComponent(gameId);
  const data = await fetch365ScoresJson(url);
  const statistics = Array.isArray(data?.statistics) ? data.statistics : [];
  const out = {};
  const opponent = {};

  for (const item of statistics) {
    const key = map365StatName(item?.name);
    if (!key) continue;

    const itemCompetitorId = Number(item?.competitorId);
    if (itemCompetitorId === Number(competitorId)) {
      assign365MappedStat(out, key, item?.value);
      continue;
    }

    if (Number.isFinite(itemCompetitorId)) {
      assign365MappedStat(opponent, key, item?.value);
    }
  }

  if (Object.keys(opponent).length) {
    out.opponent = opponent;
  }

  return Object.keys(out).length ? out : null;
}

function summarize365ScoresStyleDerived(matches) {
  const definitions = {
    passCompletionPct: 'passesCompleted',
    backwardPassesPer100: 'backwardPasses',
    finalThirdPassesPer100: 'passesIntoFinalThird',
    keyPassesPer100: 'keyPasses',
    longPassAttemptSharePct: 'longPassesAttempted',
    crossAttemptSharePct: 'crossesAttempted'
  };
  const values = {};
  const dataMatches = {};

  for (const [outputKey, numeratorKey] of Object.entries(definitions)) {
    const rows = (matches || []).filter(row =>
      finiteNumber(row?.stats?.[numeratorKey]) &&
      finiteNumber(row?.stats?.totalPasses) &&
      row.stats.totalPasses > 0
    );
    dataMatches[outputKey] = rows.length;

    if (!rows.length) {
      values[outputKey] = null;
      continue;
    }

    const numerator = rows.reduce(
      (sum, row) => sum + row.stats[numeratorKey],
      0
    );
    const denominator = rows.reduce(
      (sum, row) => sum + row.stats.totalPasses,
      0
    );
    values[outputKey] = denominator > 0
      ? Number(((numerator / denominator) * 100).toFixed(1))
      : null;
  }

  return { values, dataMatches };
}

function build365ScoresStyleTrend(
  son5,
  son10,
  son5Coverage,
  son10Coverage
) {
  const keys = [
    'passCompletionPct',
    'backwardPassesPer100',
    'finalThirdPassesPer100',
    'keyPassesPer100',
    'longPassAttemptSharePct',
    'crossAttemptSharePct'
  ];
  const metrics = {};

  for (const key of keys) {
    const recent = son5?.[key];
    const baseline = son10?.[key];

    if (!finiteNumber(recent) || !finiteNumber(baseline)) {
      metrics[key] = null;
      continue;
    }

    const delta = Number((recent - baseline).toFixed(2));
    metrics[key] = {
      son5: recent,
      son10: baseline,
      delta,
      deltaPct: baseline !== 0
        ? Number(((delta / Math.abs(baseline)) * 100).toFixed(1))
        : null,
      dataMatches5: son5Coverage?.dataMatches?.[key] ?? 0,
      dataMatches10: son10Coverage?.dataMatches?.[key] ?? 0
    };
  }

  return {
    comparison: 'son5-vs-son10',
    interpretation: 'mathematical-change-only',
    metrics
  };
}

function summarize365ScoresMatches(matches) {
  const keys = [
    'shots',
    'shotsOnTarget',
    'shotsOffTarget',
    'shotAccuracyPct',
    'corners',
    'freeKicks',
    'throwIns',
    'goalKicks',
    'possession',
    'yellowCards',
    'redCards',
    'attacks',
    'offsides',
    'backwardPasses',
    'passesIntoFinalThird',
    'passesOppositionHalf',
    'passesOwnHalf',
    'longPassesCompleted',
    'longPassesAttempted',
    'crossesCompleted',
    'crossesAttempted',
    'finalThirdPossessionWon',
    'possessionLost',
    'keyPasses',
    'totalPasses',
    'passesCompleted'
  ];
  const rows = matches.filter(match => match?.stats);
  const summary = { veriMac: rows.length };

  const goalValues = rows
    .map(row => row?.goalsFor)
    .filter(finiteNumber);
  summary.goalsFor = goalValues.length
    ? Number((
        goalValues.reduce((sum, value) => sum + value, 0) /
        goalValues.length
      ).toFixed(2))
    : null;

  for (const key of keys) {
    const values = rows
      .map(row => row.stats?.[key])
      .filter(finiteNumber);
    summary[key] = values.length
      ? Number(
          (
            values.reduce((sum, value) => sum + value, 0) /
            values.length
          ).toFixed(2)
        )
      : null;
  }

  for (const prefix of ['longPasses', 'crosses']) {
    const ratioRows = rows.filter(row =>
      finiteNumber(row?.stats?.[prefix + 'Completed']) &&
      finiteNumber(row?.stats?.[prefix + 'Attempted'])
    );
    const completed = ratioRows.reduce(
      (sum, row) => sum + row.stats[prefix + 'Completed'],
      0
    );
    const attempted = ratioRows.reduce(
      (sum, row) => sum + row.stats[prefix + 'Attempted'],
      0
    );
    summary[prefix + 'Pct'] = attempted > 0
      ? Number(((completed / attempted) * 100).toFixed(1))
      : ratioRows.length
        ? 0
        : null;
    summary[prefix + 'DataMatches'] = ratioRows.length;
  }

  const opponentFreeKickValues = rows
    .map(row => row?.stats?.opponent?.freeKicks)
    .filter(finiteNumber);
  summary.opponentFreeKicks = opponentFreeKickValues.length
    ? Number(
        (
          opponentFreeKickValues.reduce((sum, value) => sum + value, 0) /
          opponentFreeKickValues.length
        ).toFixed(2)
      )
    : null;

  const opponentThrowInValues = rows
    .map(row => row?.stats?.opponent?.throwIns)
    .filter(finiteNumber);
  summary.opponentThrowIns = opponentThrowInValues.length
    ? Number(
        (
          opponentThrowInValues.reduce((sum, value) => sum + value, 0) /
          opponentThrowInValues.length
        ).toFixed(2)
      )
    : null;

  const opponentGoalKickValues = rows
    .map(row => row?.stats?.opponent?.goalKicks)
    .filter(finiteNumber);
  summary.opponentGoalKicks = opponentGoalKickValues.length
    ? Number(
        (
          opponentGoalKickValues.reduce((sum, value) => sum + value, 0) /
          opponentGoalKickValues.length
        ).toFixed(2)
      )
    : null;

  const shotRows = rows.filter(row =>
    finiteNumber(row?.stats?.shots) &&
    finiteNumber(row?.stats?.shotsOnTarget) &&
    row.stats.shots > 0
  );
  const totalShots = shotRows.reduce(
    (sum, row) => sum + row.stats.shots,
    0
  );
  const totalShotsOnTarget = shotRows.reduce(
    (sum, row) => sum + row.stats.shotsOnTarget,
    0
  );

  summary.shotAccuracyPct = totalShots > 0
    ? Number(((totalShotsOnTarget / totalShots) * 100).toFixed(1))
    : null;
  summary.shotAccuracyDataMatches = shotRows.length;

  const goalShotRows = rows.filter(row =>
    finiteNumber(row?.goalsFor) &&
    finiteNumber(row?.stats?.shots) &&
    row.stats.shots > 0
  );
  const goalSotRows = rows.filter(row =>
    finiteNumber(row?.goalsFor) &&
    finiteNumber(row?.stats?.shotsOnTarget) &&
    row.stats.shotsOnTarget > 0
  );
  const totalGoalShotGoals = goalShotRows.reduce(
    (sum, row) => sum + row.goalsFor,
    0
  );
  const totalGoalShots = goalShotRows.reduce(
    (sum, row) => sum + row.stats.shots,
    0
  );
  const totalGoalSotGoals = goalSotRows.reduce(
    (sum, row) => sum + row.goalsFor,
    0
  );
  const totalGoalSot = goalSotRows.reduce(
    (sum, row) => sum + row.stats.shotsOnTarget,
    0
  );

  summary.goalPerShotPct = totalGoalShots > 0
    ? Number(((totalGoalShotGoals / totalGoalShots) * 100).toFixed(1))
    : null;
  summary.goalPerShotDataMatches = goalShotRows.length;
  summary.goalPerShotOnTargetPct = totalGoalSot > 0
    ? Number(((totalGoalSotGoals / totalGoalSot) * 100).toFixed(1))
    : null;
  summary.goalPerShotOnTargetDataMatches = goalSotRows.length;

  const opponentShotRows = rows.filter(row =>
    finiteNumber(row?.stats?.opponent?.shots)
  );
  const opponentSotRows = rows.filter(row =>
    finiteNumber(row?.stats?.opponent?.shotsOnTarget)
  );
  const concededShotRows = rows.filter(row =>
    finiteNumber(row?.goalsAgainst) &&
    finiteNumber(row?.stats?.opponent?.shots) &&
    row.stats.opponent.shots > 0
  );
  const concededSotRows = rows.filter(row =>
    finiteNumber(row?.goalsAgainst) &&
    finiteNumber(row?.stats?.opponent?.shotsOnTarget) &&
    row.stats.opponent.shotsOnTarget > 0
  );

  summary.opponentShots = opponentShotRows.length
    ? Number((
        opponentShotRows.reduce(
          (sum, row) => sum + row.stats.opponent.shots,
          0
        ) / opponentShotRows.length
      ).toFixed(2))
    : null;
  summary.opponentShotsOnTarget = opponentSotRows.length
    ? Number((
        opponentSotRows.reduce(
          (sum, row) => sum + row.stats.opponent.shotsOnTarget,
          0
        ) / opponentSotRows.length
      ).toFixed(2))
    : null;

  const totalConcededShotGoals = concededShotRows.reduce(
    (sum, row) => sum + row.goalsAgainst,
    0
  );
  const totalOpponentShots = concededShotRows.reduce(
    (sum, row) => sum + row.stats.opponent.shots,
    0
  );
  const totalConcededSotGoals = concededSotRows.reduce(
    (sum, row) => sum + row.goalsAgainst,
    0
  );
  const totalOpponentSot = concededSotRows.reduce(
    (sum, row) => sum + row.stats.opponent.shotsOnTarget,
    0
  );

  summary.concededGoalPerOpponentShotPct = totalOpponentShots > 0
    ? Number(((totalConcededShotGoals / totalOpponentShots) * 100).toFixed(1))
    : null;
  summary.concededGoalPerOpponentShotDataMatches = concededShotRows.length;
  summary.concededGoalPerOpponentShotOnTargetPct = totalOpponentSot > 0
    ? Number(((totalConcededSotGoals / totalOpponentSot) * 100).toFixed(1))
    : null;
  summary.concededGoalPerOpponentShotOnTargetDataMatches = concededSotRows.length;

  const scoreStateRows = rows.filter(row =>
    row?.scoreState &&
    finiteNumber(row.scoreState.durationMinutes) &&
    row.scoreState.durationMinutes > 0
  );
  const totalStateMinutes = scoreStateRows.reduce(
    (sum, row) => sum + row.scoreState.durationMinutes,
    0
  );
  const totalLeadingMinutes = scoreStateRows.reduce(
    (sum, row) => sum + row.scoreState.leadingMinutes,
    0
  );
  const totalDrawingMinutes = scoreStateRows.reduce(
    (sum, row) => sum + row.scoreState.drawingMinutes,
    0
  );
  const totalTrailingMinutes = scoreStateRows.reduce(
    (sum, row) => sum + row.scoreState.trailingMinutes,
    0
  );

  summary.scoreState = {
    dataMatches: scoreStateRows.length,
    totalMinutes: Number(totalStateMinutes.toFixed(2)),
    leadingMinutes: Number(totalLeadingMinutes.toFixed(2)),
    drawingMinutes: Number(totalDrawingMinutes.toFixed(2)),
    trailingMinutes: Number(totalTrailingMinutes.toFixed(2)),
    leadingPct: totalStateMinutes > 0
      ? Number(((totalLeadingMinutes / totalStateMinutes) * 100).toFixed(1))
      : null,
    drawingPct: totalStateMinutes > 0
      ? Number(((totalDrawingMinutes / totalStateMinutes) * 100).toFixed(1))
      : null,
    trailingPct: totalStateMinutes > 0
      ? Number(((totalTrailingMinutes / totalStateMinutes) * 100).toFixed(1))
      : null
  };

  summary.redCardContext = summarizeRedCardContext(rows);

  return summary;
}



function split365ScoresByVenue(matches) {
  const homeMatches = matches.filter(match => match?.venue === 'home');
  const awayMatches = matches.filter(match => match?.venue === 'away');

  return {
    ev: summarize365ScoresMatches(homeMatches),
    deplasman: summarize365ScoresMatches(awayMatches)
  };
}

function build365ScoresTrend(son5, son10) {
  const keys = [
    'goalsFor',
    'shots',
    'shotsOnTarget',
    'shotsOffTarget',
    'shotAccuracyPct',
    'goalPerShotPct',
    'goalPerShotOnTargetPct',
    'opponentShots',
    'opponentShotsOnTarget',
    'concededGoalPerOpponentShotPct',
    'concededGoalPerOpponentShotOnTargetPct',
    'corners',
    'possession',
    'yellowCards',
    'redCards',
    'attacks',
    'offsides'
  ];

  const metrics = {};
  for (const key of keys) {
    const recent = son5?.[key];
    const baseline = son10?.[key];

    if (!finiteNumber(recent) || !finiteNumber(baseline)) {
      metrics[key] = null;
      continue;
    }

    const delta = Number((recent - baseline).toFixed(2));
    const deltaPct = baseline !== 0
      ? Number(((delta / Math.abs(baseline)) * 100).toFixed(1))
      : null;

    metrics[key] = {
      son5: recent,
      son10: baseline,
      delta,
      deltaPct,
      direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
    };
  }

  return {
    comparison: 'son5-vs-son10',
    dataMatches5: son5?.veriMac ?? 0,
    dataMatches10: son10?.veriMac ?? 0,
    metrics
  };
}


function build365ScoresUnderlyingConsistency(trend) {
  const goal = trend?.metrics?.goalsFor || null;
  const keys = ['shots', 'shotsOnTarget', 'shotAccuracyPct'];
  const indicators = {};

  for (const key of keys) {
    const metric = trend?.metrics?.[key] || null;

    if (!goal || !metric) {
      indicators[key] = {
        relation: 'unavailable',
        goalDirection: goal?.direction ?? null,
        metricDirection: metric?.direction ?? null
      };
      continue;
    }

    let relation;
    if (goal.direction === 'flat' && metric.direction === 'flat') {
      relation = 'flat';
    } else if (goal.direction === 'flat') {
      relation = 'goal_flat_metric_changed';
    } else if (metric.direction === 'flat') {
      relation = 'metric_flat_goal_changed';
    } else if (goal.direction === metric.direction) {
      relation = 'aligned';
    } else {
      relation = 'opposite';
    }

    indicators[key] = {
      relation,
      goalDirection: goal.direction,
      metricDirection: metric.direction,
      goalDelta: goal.delta,
      metricDelta: metric.delta
    };
  }

  return {
    comparison: 'son5-vs-son10',
    basis: 'goals-vs-underlying-attack',
    goalsFor: goal,
    indicators
  };
}

async function build365ScoresTeamSupplement(
  teamName,
  referenceMs,
  currentStandingsSafe = true
) {
  const team = await resolve365ScoresTeam(teamName);
  const allHistory = await fetch365ScoresResults(team.id, referenceMs);
  const games = allHistory.slice(0, 10);
  const upcoming = await fetch365ScoresUpcoming(
    team.mainCompetitionId,
    team.id,
    referenceMs
  );
  const standings = currentStandingsSafe
    ? await fetch365ScoresStandings(team.mainCompetitionId)
    : new Map();

  const matches = await mapLimit(games, 3, async game => {
    const [statsResult, timelineResult] = await Promise.allSettled([
      fetch365ScoresGameStats(game.id, team.id),
      fetch365ScoresGameTimeline(game.id)
    ]);
    const stats = statsResult.status === 'fulfilled'
      ? statsResult.value
      : null;
    const timeline = timelineResult.status === 'fulfilled'
      ? timelineResult.value
      : null;

    const isHome =
      Number(game?.homeCompetitor?.id) === Number(team.id);
    const isAway =
      Number(game?.awayCompetitor?.id) === Number(team.id);
    const opponent = isHome
      ? game?.awayCompetitor
      : isAway
        ? game?.homeCompetitor
        : null;
    const opponentId = Number(opponent?.id);
    const standing = Number.isFinite(opponentId)
      ? standings.get(opponentId) || null
      : null;

    const homeScore = finiteNumber(Number(game?.homeCompetitor?.score))
      ? Number(game.homeCompetitor.score)
      : null;
    const awayScore = finiteNumber(Number(game?.awayCompetitor?.score))
      ? Number(game.awayCompetitor.score)
      : null;
    const goalsFor = isHome ? homeScore : isAway ? awayScore : null;
    const goalsAgainst = isHome ? awayScore : isAway ? homeScore : null;

    return {
      id: game.id ?? null,
      date: game.startTime ?? null,
      home: game?.homeCompetitor?.name ?? null,
      away: game?.awayCompetitor?.name ?? null,
      venue: isHome ? 'home' : isAway ? 'away' : null,
      competitionId: game?.competitionId ?? null,
      goalsFor,
      goalsAgainst,
      scoreState: build365ScoresScoreState(timeline, team.id, goalsFor, goalsAgainst),
      travelContext: build365ScoresTravelContext(timeline, team.id),
      redCardContext: build365ScoresRedCardContext(
        timeline,
        team.id,
        stats?.redCards
      ),
      opponent: opponent ? {
        competitorId: opponent.id ?? null,
        name: opponent.name ?? null,
        currentStanding: standing
      } : null,
      stats
    };
  });

  const last5 = matches.slice(0, 5);
  const son5General = summarize365ScoresMatches(last5);
  const son10General = summarize365ScoresMatches(matches);
  const son5StyleDerived = summarize365ScoresStyleDerived(last5);
  const son10StyleDerived = summarize365ScoresStyleDerived(matches);
  const son5Venue = split365ScoresByVenue(last5);
  const son10Venue = split365ScoresByVenue(matches);
  const son5 = {
    ...son5General,
    ev: son5Venue.ev,
    deplasman: son5Venue.deplasman
  };
  const son10 = {
    ...son10General,
    ev: son10Venue.ev,
    deplasman: son10Venue.deplasman
  };
  const scores365StyleCoverage = subset => {
    const directKeys = [
      'backwardPasses',
      'passesIntoFinalThird',
      'passesOppositionHalf',
      'passesOwnHalf',
      'longPassesCompleted',
      'longPassesAttempted',
      'crossesCompleted',
      'crossesAttempted',
      'finalThirdPossessionWon',
      'possessionLost',
      'keyPasses',
      'totalPasses',
      'passesCompleted'
    ];
    const dataMatches = {};
    for (const key of directKeys) {
      dataMatches[key] = subset.filter(row =>
        finiteNumber(row?.stats?.[key])
      ).length;
    }
    dataMatches.longPassesPct = subset.filter(row =>
      finiteNumber(row?.stats?.longPassesCompleted) &&
      finiteNumber(row?.stats?.longPassesAttempted)
    ).length;
    dataMatches.crossesPct = subset.filter(row =>
      finiteNumber(row?.stats?.crossesCompleted) &&
      finiteNumber(row?.stats?.crossesAttempted)
    ).length;
    Object.assign(
      dataMatches,
      summarize365ScoresStyleDerived(subset).dataMatches
    );

    return {
      windowMatches: subset.length,
      dataMatches
    };
  };

  const son5StyleCoverage = scores365StyleCoverage(last5);
  const son10StyleCoverage = scores365StyleCoverage(matches);

  const styleContext = {
    source: '365Scores',
    basis: 'recent-match-game-stats',
    son5: {
      backwardPasses: son5General?.backwardPasses ?? null,
      passesIntoFinalThird: son5General?.passesIntoFinalThird ?? null,
      passesOppositionHalf: son5General?.passesOppositionHalf ?? null,
      passesOwnHalf: son5General?.passesOwnHalf ?? null,
      longPassesCompleted: son5General?.longPassesCompleted ?? null,
      longPassesAttempted: son5General?.longPassesAttempted ?? null,
      longPassesPct: son5General?.longPassesPct ?? null,
      crossesCompleted: son5General?.crossesCompleted ?? null,
      crossesAttempted: son5General?.crossesAttempted ?? null,
      crossesPct: son5General?.crossesPct ?? null,
      finalThirdPossessionWon: son5General?.finalThirdPossessionWon ?? null,
      possessionLost: son5General?.possessionLost ?? null,
      keyPasses: son5General?.keyPasses ?? null,
      totalPasses: son5General?.totalPasses ?? null,
      passesCompleted: son5General?.passesCompleted ?? null,
      ...son5StyleDerived.values
    },
    son10: {
      backwardPasses: son10General?.backwardPasses ?? null,
      passesIntoFinalThird: son10General?.passesIntoFinalThird ?? null,
      passesOppositionHalf: son10General?.passesOppositionHalf ?? null,
      passesOwnHalf: son10General?.passesOwnHalf ?? null,
      longPassesCompleted: son10General?.longPassesCompleted ?? null,
      longPassesAttempted: son10General?.longPassesAttempted ?? null,
      longPassesPct: son10General?.longPassesPct ?? null,
      crossesCompleted: son10General?.crossesCompleted ?? null,
      crossesAttempted: son10General?.crossesAttempted ?? null,
      crossesPct: son10General?.crossesPct ?? null,
      finalThirdPossessionWon: son10General?.finalThirdPossessionWon ?? null,
      possessionLost: son10General?.possessionLost ?? null,
      keyPasses: son10General?.keyPasses ?? null,
      totalPasses: son10General?.totalPasses ?? null,
      passesCompleted: son10General?.passesCompleted ?? null,
      ...son10StyleDerived.values
    },
    coverage: {
      son5: son5StyleCoverage,
      son10: son10StyleCoverage
    },
    trend: build365ScoresStyleTrend(
      son5StyleDerived.values,
      son10StyleDerived.values,
      son5StyleCoverage,
      son10StyleCoverage
    ),
    provenance: {
      backwardPasses: '365Scores.game/stats.Backward Passes',
      passesIntoFinalThird: '365Scores.game/stats.Passes Into Final Third',
      passesOppositionHalf: '365Scores.game/stats.Passes Opposition Half',
      passesOwnHalf: '365Scores.game/stats.Passes Own Half',
      longPasses: '365Scores.game/stats.Long Passes Completed',
      crosses: '365Scores.game/stats.Crosses Completed',
      finalThirdPossessionWon:
        '365Scores.game/stats.Final Third Possession Won',
      possessionLost: '365Scores.game/stats.Possession Lost',
      keyPasses: '365Scores.game/stats.Key Passes',
      totalPasses: '365Scores.game/stats.Total Passes',
      passesCompleted: '365Scores.game/stats.Passes Completed',
      passCompletionPct:
        'derived:365Scores.game/stats.Passes Completed + Total Passes',
      backwardPassesPer100:
        'derived:365Scores.game/stats.Backward Passes + Total Passes',
      finalThirdPassesPer100:
        'derived:365Scores.game/stats.Passes Into Final Third + Total Passes',
      keyPassesPer100:
        'derived:365Scores.game/stats.Key Passes + Total Passes',
      longPassAttemptSharePct:
        'derived:365Scores.game/stats.Long Passes Completed(attempted component) + Total Passes',
      crossAttemptSharePct:
        'derived:365Scores.game/stats.Crosses Completed(attempted component) + Total Passes'
    },
    formulas: {
      passCompletionPct: '(passesCompleted / totalPasses) * 100',
      backwardPassesPer100: '(backwardPasses / totalPasses) * 100',
      finalThirdPassesPer100:
        '(passesIntoFinalThird / totalPasses) * 100',
      keyPassesPer100: '(keyPasses / totalPasses) * 100',
      longPassAttemptSharePct:
        '(longPassesAttempted / totalPasses) * 100',
      crossAttemptSharePct:
        '(crossesAttempted / totalPasses) * 100',
      aggregation:
        'ratio-of-sums-over-matches-with-both-fields-and-totalPasses>0',
      missingPolicy:
        'null-when-no-valid-denominator; explicit-zero-numerator-preserved-as-0'
    },
    interpretationStatus:
      'raw-direct-fields-no-playing-style-classification'
  };

  const setPieceContext = {
    source: '365Scores',
    basis: 'recent-match-game-stats',
    son5: {
      corners: son5General?.corners ?? null,
      freeKicks: son5General?.freeKicks ?? null,
      throwIns: son5General?.throwIns ?? null,
      goalKicks: son5General?.goalKicks ?? null,
      penalties: null
    },
    son10: {
      corners: son10General?.corners ?? null,
      freeKicks: son10General?.freeKicks ?? null,
      throwIns: son10General?.throwIns ?? null,
      goalKicks: son10General?.goalKicks ?? null,
      penalties: null
    },
    opponent: {
      son5: {
        freeKicks: son5General?.opponentFreeKicks ?? null,
        throwIns: son5General?.opponentThrowIns ?? null,
        goalKicks: son5General?.opponentGoalKicks ?? null
      },
      son10: {
        freeKicks: son10General?.opponentFreeKicks ?? null,
        throwIns: son10General?.opponentThrowIns ?? null,
        goalKicks: son10General?.opponentGoalKicks ?? null
      }
    },
    provenance: {
      corners: '365Scores.game/stats',
      freeKicks: '365Scores.game/stats',
      throwIns: '365Scores.game/stats',
      goalKicks: '365Scores.game/stats',
      penalties: null
    },
    penaltyStatus: 'not-provided-by-source'
  };

  const attackVolumeContext = {
    source: '365Scores',
    basis: 'recent-match-game-stats',
    son5: {
      attacks: son5General?.attacks ?? null
    },
    son10: {
      attacks: son10General?.attacks ?? null
    },
    provenance: {
      attacks: '365Scores.game/stats'
    },
    interpretationStatus: 'raw-attack-volume-not-transition-counter-attack-or-fast-break'
  };

  const trend = build365ScoresTrend(son5General, son10General);
  const underlyingConsistency = build365ScoresUnderlyingConsistency(trend);
  const travelContext = summarize365ScoresTravelContext(matches);
  const restFixture = build365ScoresRestFixture(
    allHistory,
    upcoming,
    referenceMs
  );
  const opponentRows = matches
    .filter(match => match?.opponent?.currentStanding)
    .map(match => ({
      gameId: match.id,
      date: match.date,
      opponent: match.opponent.name,
      ...match.opponent.currentStanding
    }));

  return {
    team: team.name,
    competitorId: team.id,
    dataMatches: son10.veriMac,
    dataMatches5: son5.veriMac,
    dataMatches10: son10.veriMac,
    son5,
    son10,
    trend,
    underlyingConsistency,
    styleContext,
    setPieceContext,
    attackVolumeContext,
    travelContext,
    restFixture,
    opponentQuality: {
      source: '365Scores',
      basis: 'current-standings-snapshot',
      competitionId: team.mainCompetitionId,
      referenceDateSafe: currentStandingsSafe,
      status: currentStandingsSafe
        ? 'current-snapshot-allowed'
        : 'historical-current-snapshot-blocked',
      dataMatches: opponentRows.length,
      matches: opponentRows
    },
    matches
  };
}

async function build365ScoresSupplement(input) {
  if (!input?.home?.name || !input?.away?.name) {
    throw new Error('365Scores home/away team names required.');
  }

  const parsedReference = Date.parse(input?.matchDate || '');
  const referenceMs = Number.isFinite(parsedReference)
    ? parsedReference
    : Date.now();
  const currentStandingsSafe =
    !Number.isFinite(parsedReference) ||
    parsedReference >= Date.now();

  const [home, away] = await Promise.all([
    build365ScoresTeamSupplement(
      input.home.name,
      referenceMs,
      currentStandingsSafe
    ),
    build365ScoresTeamSupplement(
      input.away.name,
      referenceMs,
      currentStandingsSafe
    )
  ]);

  if (!home.dataMatches && !away.dataMatches) {
    throw new Error('365Scores standard stats not found.');
  }

  const competitionId =
    home?.opponentQuality?.competitionId ||
    away?.opponentQuality?.competitionId ||
    null;
  const competitionContext =
    currentStandingsSafe && competitionId
      ? await fetch365ScoresCompetitionContext(competitionId)
      : null;
  const cachedStandings =
    currentStandingsSafe && competitionId
      ? scores365StandingsCache.get(String(competitionId))?.rows
      : null;

  const matchContext = competitionContext ? {
    ...competitionContext,
    referenceDateSafe: true,
    home: cachedStandings?.get(Number(home.competitorId)) || null,
    away: cachedStandings?.get(Number(away.competitorId)) || null
  } : null;

  let targetGame = null;
  let targetTimeline = null;
  if (currentStandingsSafe) {
    try {
      targetGame = await fetch365ScoresTargetGame(
        home.competitorId,
        away.competitorId,
        competitionId,
        referenceMs
      );
      if (targetGame?.id) {
        targetTimeline = await fetch365ScoresGameTimeline(targetGame.id);
      }
    } catch {}
  }

  const weatherPitchContext = build365ScoresWeatherPitchContext(
    targetGame,
    targetTimeline
  );

  const refereeContext = {
    source: '365Scores',
    basis: 'target-match-details',
    status: currentStandingsSafe
      ? 'not-provided-by-source'
      : 'historical-target-snapshot-blocked',
    referenceDateSafe: currentStandingsSafe,
    gameId: targetGame?.id ?? null,
    referee: null,
    history: null
  };

  return {
    source: '365Scores',
    collected_at: new Date().toISOString(),
    home,
    away,
    matchContext,
    weatherPitchContext,
    refereeContext,
    provenance: {
      homeCompetitorId: home.competitorId,
      awayCompetitorId: away.competitorId
    }
  };
}

function has365ScoresStyleData(styleContext) {
  if (!styleContext) return false;
  const sections = [styleContext.son5, styleContext.son10];
  const keys = [
    'backwardPasses',
    'passesIntoFinalThird',
    'passesOppositionHalf',
    'passesOwnHalf',
    'longPassesCompleted',
    'longPassesAttempted',
    'crossesCompleted',
    'crossesAttempted',
    'finalThirdPossessionWon',
    'possessionLost',
    'keyPasses',
    'totalPasses',
    'passesCompleted'
  ];
  return sections.some(section =>
    keys.some(key => finiteNumber(section?.[key]))
  );
}

function compact365ScoresStyleSupplement(scores365) {
  if (!scores365) return null;

  const compactTeam = team => {
    if (!team) return null;
    return {
      team: team.team ?? null,
      competitorId: team.competitorId ?? null,
      dataMatches: team.dataMatches ?? null,
      dataMatches5: team.dataMatches5 ?? null,
      dataMatches10: team.dataMatches10 ?? null,
      styleContext: team.styleContext ?? null
    };
  };

  const home = compactTeam(scores365.home);
  const away = compactTeam(scores365.away);
  if (
    !has365ScoresStyleData(home?.styleContext) &&
    !has365ScoresStyleData(away?.styleContext)
  ) {
    return null;
  }

  return {
    source: '365Scores',
    purpose: 'style-only',
    collected_at: scores365.collected_at ?? new Date().toISOString(),
    home,
    away,
    provenance: {
      homeCompetitorId: scores365?.provenance?.homeCompetitorId ?? null,
      awayCompetitorId: scores365?.provenance?.awayCompetitorId ?? null,
      coveragePolicy:
        'style-only-supplement-does-not-add-confidence-or-coverage'
    }
  };
}

function needsUnderstatXgSupplement(coverage) {
  if (!coverage) return false;
  return coverage.missing.includes('xg') ||
    coverage.missing.includes('xga') ||
    coverage.missing.includes('xg_differential');
}

function compactUnderstatXgSupplement(data) {
  if (!hasUsablePerformance(data)) return null;
  const compactTeam = team => ({
    team: team?.takim ?? null,
    son5: {
      xGVerisi: team?.son5?.xGVerisi ?? 0,
      xG: finiteNumber(team?.son5?.xG) ? team.son5.xG : null,
      xGA: finiteNumber(team?.son5?.xGA) ? team.son5.xGA : null
    },
    son10: {
      xGVerisi: team?.son10?.xGVerisi ?? 0,
      xG: finiteNumber(team?.son10?.xG) ? team.son10.xG : null,
      xGA: finiteNumber(team?.son10?.xGA) ? team.son10.xGA : null
    },
    resultVsUnderlying: buildXgResultVsUnderlyingContext(team, 'Understat')
  });
  return {
    source: 'Understat',
    home: compactTeam(data.evTakimi),
    away: compactTeam(data.deplasmanTakimi),
    provenance: {
      policy: 'provider-separated-xg-only',
      crossProviderAverage: false,
      referenceDateSafe: true
    }
  };
}

function needs365ScoresSupplement(data, coverage) {
  if (!data || !coverage) return false;
  return coverage.missing.includes('shot_quality') ||
    coverage.missing.includes('set_pieces') ||
    coverage.missing.includes('possession_quality') ||
    coverage.missing.includes('result_vs_underlying');
}

function needsMackolikSupplement(coverage) {
  if (!coverage) return false;
  return coverage.missing.includes('shot_quality') ||
    coverage.missing.includes('set_pieces') ||
    coverage.missing.includes('possession_quality');
}

async function collectPerformanceSupplements(primaryProvider, input, data, coverage) {
  const supplements = {};
  const attempts = [];

  if (
    primaryProvider === 'FotMob' &&
    input?.matchUrl &&
    /betexplorer\.com/i.test(String(input.matchUrl)) &&
    needsBetExplorerSupplement(data, coverage)
  ) {
    try {
      const betExplorer = await buildBetExplorerPerformancePackage(input);
      if (hasUsablePerformance(betExplorer)) {
        supplements.betexplorer = compactBetExplorerSupplement(betExplorer);
        attempts.push({ provider: 'BetExplorer', status: 'ok' });
      } else {
        attempts.push({ provider: 'BetExplorer', status: 'empty' });
      }
    } catch (err) {
      attempts.push({
        provider: 'BetExplorer',
        status: 'failed',
        error: String(err && err.message ? err.message : err).slice(0, 300)
      });
    }
  }

  const needs365Coverage = needs365ScoresSupplement(data, coverage);

  if (primaryProvider !== 'Understat' && needsUnderstatXgSupplement(coverage)) {
    try {
      const understat = await buildUnderstatPerformancePackage(input);
      const xgOnly = compactUnderstatXgSupplement(understat);
      if (
        xgOnly &&
        finiteNumber(xgOnly.home?.son5?.xG) &&
        finiteNumber(xgOnly.home?.son5?.xGA) &&
        finiteNumber(xgOnly.away?.son5?.xG) &&
        finiteNumber(xgOnly.away?.son5?.xGA)
      ) {
        supplements.understatXg = xgOnly;
        attempts.push({ provider: 'Understat', purpose: 'xg-only', status: 'ok' });
      } else {
        attempts.push({ provider: 'Understat', purpose: 'xg-only', status: 'empty' });
      }
    } catch (err) {
      attempts.push({
        provider: 'Understat',
        purpose: 'xg-only',
        status: 'failed',
        error: String(err && err.message ? err.message : err).slice(0, 300)
      });
    }
  }

  if (needsMackolikSupplement(coverage)) {
    try {
      const resolved = await resolveMackolikExactFixture(input);
      if (resolved) {
        const mackolik = buildMackolikFieldSupplementFromHtml(
          resolved.html,
          input,
          resolved.url
        );
        if (mackolik && Object.keys(mackolik.fields || {}).length) {
          supplements.mackolik = mackolik;
          attempts.push({ provider: 'Mackolik', status: 'ok' });
        } else {
          attempts.push({ provider: 'Mackolik', status: 'empty' });
        }
      } else {
        attempts.push({ provider: 'Mackolik', status: 'not-found' });
      }
    } catch (err) {
      attempts.push({
        provider: 'Mackolik',
        status: 'failed',
        error: String(err && err.message ? err.message : err).slice(0, 300)
      });
    }
  }

  if (needs365Coverage) {
    try {
      const scores365 = await build365ScoresSupplement(input);
      supplements.scores365 = scores365;
      attempts.push({ provider: '365Scores', status: 'ok' });
    } catch (err) {
      attempts.push({
        provider: '365Scores',
        status: 'failed',
        error: String(err && err.message ? err.message : err).slice(0, 300)
      });
    }
  } else if (primaryProvider === 'FotMob') {
    try {
      const scores365 = await build365ScoresSupplement(input);
      const styleOnly = compact365ScoresStyleSupplement(scores365);
      if (styleOnly) {
        supplements.scores365Style = styleOnly;
        attempts.push({
          provider: '365Scores',
          purpose: 'style-only',
          status: 'ok'
        });
      } else {
        attempts.push({
          provider: '365Scores',
          purpose: 'style-only',
          status: 'empty'
        });
      }
    } catch (err) {
      attempts.push({
        provider: '365Scores',
        purpose: 'style-only',
        status: 'failed',
        error: String(err && err.message ? err.message : err).slice(0, 300)
      });
    }
  }

  return { supplements, attempts };
}


function buildTeamStyleSources(primaryTeam, supplementTeam) {
  const sources = {
    _providerPolicy: {
      version: 1,
      mode: 'provider-separated-no-merge',
      rules: {
        crossProviderMerge: 'forbidden',
        crossProviderAverage: 'forbidden',
        crossProviderOverwrite: 'forbidden',
        sourceSelection: 'provider-specific-only'
      },
      semanticLinks: {
        longBalls: {
          FotMob: 'accurateLongBalls',
          '365Scores': 'longPassesCompleted',
          relation: 'same-completed-or-accurate-concept',
          numericInterchangeability: false,
          evidenceStatus: 'same-match-overlap-validated'
        },
        crosses: {
          FotMob: 'accurateCrosses',
          '365Scores': 'crossesCompleted',
          relation: 'same-completed-or-accurate-concept',
          numericInterchangeability: false,
          evidenceStatus: 'same-match-overlap-validated'
        }
      }
    }
  };
  const primaryStyle = primaryTeam?.styleContext;
  if (primaryStyle?.source) {
    sources[primaryStyle.source] = primaryStyle;
  }

  const supplementStyle = supplementTeam?.styleContext;
  if (
    supplementStyle?.source &&
    has365ScoresStyleData(supplementStyle)
  ) {
    sources[supplementStyle.source] = supplementStyle;
  }

  return sources;
}

function buildProgressionTrend(
  son5Value,
  son10Value,
  dataMatches5,
  dataMatches10
) {
  const eligible =
    finiteNumber(son5Value) &&
    finiteNumber(son10Value) &&
    dataMatches5 > 0 &&
    dataMatches10 > dataMatches5;

  const eligibility = {
    eligible,
    rule:
      'son5-data-present-and-son10-has-additional-data-beyond-son5',
    dataMatches5,
    dataMatches10
  };

  if (!eligible) {
    return {
      comparison: 'son5-vs-son10',
      interpretation: 'mathematical-change-only',
      eligibility,
      metric: null
    };
  }

  const delta = Number((son5Value - son10Value).toFixed(2));
  return {
    comparison: 'son5-vs-son10',
    interpretation: 'mathematical-change-only',
    eligibility,
    metric: {
      son5: son5Value,
      son10: son10Value,
      delta,
      deltaPct: son10Value !== 0
        ? Number(((delta / Math.abs(son10Value)) * 100).toFixed(1))
        : null
    }
  };
}

function averageCompleteProgressionTeamTotal(matches) {
  const values = (matches || [])
    .filter(match =>
      match?.complete === true &&
      finiteNumber(match?.teamTotal)
    )
    .map(match => match.teamTotal);

  return values.length
    ? Number((
        values.reduce((sum, value) => sum + value, 0) /
        values.length
      ).toFixed(1))
    : null;
}

function buildTeamProgressionSources(primaryTeam, supplementTeam) {
  const sources = {
    _providerPolicy: {
      version: 1,
      mode: 'provider-separated-no-merge-no-substitute',
      rules: {
        crossProviderMerge: 'forbidden',
        crossProviderAverage: 'forbidden',
        crossProviderOverwrite: 'forbidden',
        crossProviderSubstitute: 'forbidden',
        sourceSelection: 'provider-specific-only'
      },
      semanticLinks: {
        passesIntoFinalThird: {
          FotMob:
            'playerProgression.teamTotal (only when complete=true)',
          '365Scores':
            'styleContext.son5/son10.passesIntoFinalThird (direct team stat)',
          relation:
            'same-label-or-concept-but-provider-semantics-not-interchangeable',
          numericInterchangeability: false,
          evidenceStatus:
            'same-match-complete-overlap-mismatch-observed'
        }
      }
    }
  };

  const fotMobContext = primaryTeam?.playerProgressionContext;
  if (fotMobContext?.source === 'FotMob') {
    const matches = (primaryTeam?.maclar || []).slice(0, 10).map(
      match => ({
        date: match?.tarih ?? null,
        home: match?.ev ?? null,
        away: match?.deplasman ?? null,
        complete: match?.playerProgression?.complete === true,
        playedPlayers:
          match?.playerProgression?.playedPlayers ?? null,
        playersWithData:
          match?.playerProgression?.playersWithData ?? null,
        teamTotal:
          match?.playerProgression?.complete === true
            ? match?.playerProgression?.teamTotal ?? null
            : null
      })
    );
    const last5 = matches.slice(0, 5);
    const son5Average =
      averageCompleteProgressionTeamTotal(last5);
    const son10Average =
      averageCompleteProgressionTeamTotal(matches);
    const complete5 =
      fotMobContext?.son5?.completeMatches ?? 0;
    const complete10 =
      fotMobContext?.son10?.completeMatches ?? 0;

    sources.FotMob = {
      source: 'FotMob',
      basis: 'player-level-sum-only-when-complete',
      son5: fotMobContext.son5 ?? null,
      son10: fotMobContext.son10 ?? null,
      availability: {
        son5: {
          windowMatches: last5.length,
          dataMatches: fotMobContext?.son5?.dataMatches ?? 0,
          completeMatches: complete5
        },
        son10: {
          windowMatches: matches.length,
          dataMatches: fotMobContext?.son10?.dataMatches ?? 0,
          completeMatches: complete10
        }
      },
      summary: {
        son5: {
          passesIntoFinalThirdTeamTotalAvg: son5Average
        },
        son10: {
          passesIntoFinalThirdTeamTotalAvg: son10Average
        }
      },
      trend: buildProgressionTrend(
        son5Average,
        son10Average,
        complete5,
        complete10
      ),
      teamTotalPolicy: fotMobContext.teamTotalPolicy ?? null,
      matches,
      provenance: fotMobContext.provenance ?? null
    };
  }

  const style = supplementTeam?.styleContext;
  if (
    style?.source === '365Scores' &&
    (
      finiteNumber(style?.son5?.passesIntoFinalThird) ||
      finiteNumber(style?.son10?.passesIntoFinalThird)
    )
  ) {
    const son5Value =
      style?.son5?.passesIntoFinalThird ?? null;
    const son10Value =
      style?.son10?.passesIntoFinalThird ?? null;
    const son5Normalized =
      style?.son5?.finalThirdPassesPer100 ?? null;
    const son10Normalized =
      style?.son10?.finalThirdPassesPer100 ?? null;
    const dataMatches5 =
      style?.coverage?.son5?.dataMatches
        ?.passesIntoFinalThird ?? 0;
    const dataMatches10 =
      style?.coverage?.son10?.dataMatches
        ?.passesIntoFinalThird ?? 0;
    const normalizedDataMatches5 =
      style?.coverage?.son5?.dataMatches
        ?.finalThirdPassesPer100 ?? 0;
    const normalizedDataMatches10 =
      style?.coverage?.son10?.dataMatches
        ?.finalThirdPassesPer100 ?? 0;
    const availability = {
      son5: {
        windowMatches:
          style?.coverage?.son5?.windowMatches ?? 0,
        dataMatches: dataMatches5,
        metricDataMatches: {
          passesIntoFinalThird: dataMatches5,
          finalThirdPassesPer100: normalizedDataMatches5
        }
      },
      son10: {
        windowMatches:
          style?.coverage?.son10?.windowMatches ?? 0,
        dataMatches: dataMatches10,
        metricDataMatches: {
          passesIntoFinalThird: dataMatches10,
          finalThirdPassesPer100: normalizedDataMatches10
        }
      }
    };

    sources['365Scores'] = {
      source: '365Scores',
      basis: 'direct-team-game-stats-with-derived-per100',
      son5: {
        passesIntoFinalThird: son5Value,
        finalThirdPassesPer100: son5Normalized
      },
      son10: {
        passesIntoFinalThird: son10Value,
        finalThirdPassesPer100: son10Normalized
      },
      availability,
      coverage: availability,
      trend: buildProgressionTrend(
        son5Value,
        son10Value,
        dataMatches5,
        dataMatches10
      ),
      normalizedTrend: buildProgressionTrend(
        son5Normalized,
        son10Normalized,
        normalizedDataMatches5,
        normalizedDataMatches10
      ),
      normalization: {
        finalThirdPassesPer100: {
          formula:
            style?.formulas?.finalThirdPassesPer100 ?? null,
          aggregation:
            style?.formulas?.aggregation ?? null,
          missingPolicy:
            style?.formulas?.missingPolicy ?? null
        }
      },
      provenance: {
        passesIntoFinalThird:
          style?.provenance?.passesIntoFinalThird ?? null,
        finalThirdPassesPer100:
          style?.provenance?.finalThirdPassesPer100 ?? null
      }
    };
  }

  return sources;
}

function buildHighZoneRegainContext(supplementTeam) {
  const style = supplementTeam?.styleContext;
  if (style?.source !== '365Scores') return null;

  const son5Value =
    style?.son5?.finalThirdPossessionWon ?? null;
  const son10Value =
    style?.son10?.finalThirdPossessionWon ?? null;

  if (!finiteNumber(son5Value) && !finiteNumber(son10Value)) {
    return null;
  }

  const dataMatches5 =
    style?.coverage?.son5?.dataMatches
      ?.finalThirdPossessionWon ?? 0;
  const dataMatches10 =
    style?.coverage?.son10?.dataMatches
      ?.finalThirdPossessionWon ?? 0;

  return {
    source: '365Scores',
    basis: 'provider-defined-final-third-possession-won',
    interpretation: 'high-zone-possession-regain-signal-only',
    pressingClassification: 'not-directly-proven',
    son5: {
      finalThirdPossessionWon: son5Value
    },
    son10: {
      finalThirdPossessionWon: son10Value
    },
    availability: {
      son5: {
        windowMatches:
          style?.coverage?.son5?.windowMatches ?? 0,
        dataMatches: dataMatches5
      },
      son10: {
        windowMatches:
          style?.coverage?.son10?.windowMatches ?? 0,
        dataMatches: dataMatches10
      }
    },
    trend: buildProgressionTrend(
      son5Value,
      son10Value,
      dataMatches5,
      dataMatches10
    ),
    provenance: {
      finalThirdPossessionWon:
        style?.provenance?.finalThirdPossessionWon ?? null
    },
    guardrails: {
      pressingIntensity: 'not-inferred',
      PPDA: 'not-inferred',
      pressingRating: 'not-inferred'
    }
  };
}

function buildTeamPressingSources(primaryTeam, supplementTeam) {
  const sources = {
    _providerPolicy: {
      version: 1,
      mode: 'provider-separated-support-signals-only',
      rules: {
        crossProviderMerge: 'forbidden',
        crossProviderAverage: 'forbidden',
        crossProviderFormula: 'forbidden-until-validated',
        combinedPressingInterpretation: 'none',
        pressingIntensity: 'not-inferred',
        PPDA: 'not-inferred',
        pressingRating: 'not-inferred'
      }
    }
  };

  const fotMob = primaryTeam?.pressingContext;
  const hasFotMob =
    fotMob?.source === 'FotMob' &&
    (
      finiteNumber(fotMob?.son5?.tackles) ||
      finiteNumber(fotMob?.son5?.interceptions) ||
      finiteNumber(fotMob?.son10?.tackles) ||
      finiteNumber(fotMob?.son10?.interceptions)
    );

  if (hasFotMob) {
    const matches = (primaryTeam?.maclar || []).slice(0, 10);
    const last5 = matches.slice(0, 5);
    const countMetric = (subset, key) =>
      subset.filter(match =>
        finiteNumber(match?.istatistik?.[key])
      ).length;

    const tackles5 = countMetric(last5, 'tackles');
    const tackles10 = countMetric(matches, 'tackles');
    const interceptions5 = countMetric(last5, 'interceptions');
    const interceptions10 = countMetric(matches, 'interceptions');

    sources.FotMob = {
      source: 'FotMob',
      basis: fotMob.basis ?? 'match-details-defence-stats',
      interpretation: 'raw-defensive-action-support-signals-only',
      son5: {
        tackles: fotMob?.son5?.tackles ?? null,
        interceptions: fotMob?.son5?.interceptions ?? null
      },
      son10: {
        tackles: fotMob?.son10?.tackles ?? null,
        interceptions: fotMob?.son10?.interceptions ?? null
      },
      availability: {
        son5: {
          windowMatches: last5.length,
          dataMatches: {
            tackles: tackles5,
            interceptions: interceptions5
          }
        },
        son10: {
          windowMatches: matches.length,
          dataMatches: {
            tackles: tackles10,
            interceptions: interceptions10
          }
        }
      },
      trend: {
        comparison: 'son5-vs-son10',
        interpretation: 'mathematical-change-only',
        metrics: {
          tackles: buildProgressionTrend(
            fotMob?.son5?.tackles ?? null,
            fotMob?.son10?.tackles ?? null,
            tackles5,
            tackles10
          ),
          interceptions: buildProgressionTrend(
            fotMob?.son5?.interceptions ?? null,
            fotMob?.son10?.interceptions ?? null,
            interceptions5,
            interceptions10
          )
        }
      },
      provenance: {
        tackles: fotMob?.provenance?.tackles ?? null,
        interceptions: fotMob?.provenance?.interceptions ?? null
      },
      guardrails: {
        pressingIntensity: 'not-inferred',
        PPDA: 'not-inferred',
        pressingRating: 'not-inferred'
      }
    };
  }

  const highZone = buildHighZoneRegainContext(supplementTeam);
  if (highZone) {
    sources['365Scores'] = {
      ...highZone,
      role: 'high-zone-possession-regain-support-signal'
    };
  }

  return sources;
}

function attachStyleSources(data, supplements) {
  if (!data) return data;

  const scores365 =
    supplements?.scores365Style ||
    supplements?.scores365 ||
    null;
  const understatXg = supplements?.understatXg || null;

  return {
    ...data,
    evTakimi: data.evTakimi ? {
      ...data.evTakimi,
      styleSources: buildTeamStyleSources(
        data.evTakimi,
        scores365?.home
      ),
      progressionSources: buildTeamProgressionSources(
        data.evTakimi,
        scores365?.home
      ),
      highZoneRegainContext: buildHighZoneRegainContext(
        scores365?.home
      ),
      pressingSources: buildTeamPressingSources(
        data.evTakimi,
        scores365?.home
      ),
      resultVsUnderlyingSources: buildTeamResultVsUnderlyingSources(
        data.evTakimi,
        scores365?.home,
        understatXg?.home,
        data?.meta?.kaynak || null
      )
    } : data.evTakimi,
    deplasmanTakimi: data.deplasmanTakimi ? {
      ...data.deplasmanTakimi,
      styleSources: buildTeamStyleSources(
        data.deplasmanTakimi,
        scores365?.away
      ),
      progressionSources: buildTeamProgressionSources(
        data.deplasmanTakimi,
        scores365?.away
      ),
      highZoneRegainContext: buildHighZoneRegainContext(
        scores365?.away
      ),
      pressingSources: buildTeamPressingSources(
        data.deplasmanTakimi,
        scores365?.away
      ),
      resultVsUnderlyingSources: buildTeamResultVsUnderlyingSources(
        data.deplasmanTakimi,
        scores365?.away,
        understatXg?.away,
        data?.meta?.kaynak || null
      )
    } : data.deplasmanTakimi
  };
}

function supplementCoverageSources(supplements) {
  const sources = {};
  const scores365 = supplements?.scores365;
  const mackolik = supplements?.mackolik;
  const understatXg = supplements?.understatXg;
  const home = scores365?.home?.son5;
  const away = scores365?.away?.son5;

  const both = key =>
    finiteNumber(home?.[key]) &&
    finiteNumber(away?.[key]);

  const understatBoth = key =>
    finiteNumber(understatXg?.home?.son5?.[key]) &&
    finiteNumber(understatXg?.away?.son5?.[key]);

  if (understatBoth('xG')) {
    sources.xg = 'Understat';
  }
  if (understatBoth('xGA')) {
    sources.xga = 'Understat';
  }
  if (understatBoth('xG') && understatBoth('xGA')) {
    sources.xg_differential = 'Understat';
  }

  if (both('shots') && both('shotsOnTarget')) {
    sources.shot_quality = '365Scores';
  }
  if (both('corners')) {
    sources.set_pieces = '365Scores';
  }
  if (both('possession')) {
    sources.possession_quality = '365Scores';
  }

  if (
    mackolik?.fields?.shots &&
    mackolik?.fields?.shotsOnTarget
  ) {
    sources.shot_quality = sources.shot_quality || 'Mackolik';
  }
  if (mackolik?.fields?.corners) {
    sources.set_pieces = sources.set_pieces || 'Mackolik';
  }
  if (mackolik?.fields?.possession) {
    sources.possession_quality = sources.possession_quality || 'Mackolik';
  }
  if (
    (scores365?.home?.son5?.redCardContext?.dataMatches || 0) > 0 &&
    (scores365?.away?.son5?.redCardContext?.dataMatches || 0) > 0
  ) {
    sources.red_card_context = '365Scores';
  }

  if (
    (scores365?.home?.opponentQuality?.dataMatches || 0) > 0 &&
    (scores365?.away?.opponentQuality?.dataMatches || 0) > 0
  ) {
    sources.opponent_quality = '365Scores';
  }

  if (
    finiteNumber(scores365?.home?.restFixture?.next7DaysCount) &&
    finiteNumber(scores365?.home?.restFixture?.next14DaysCount) &&
    finiteNumber(scores365?.away?.restFixture?.next7DaysCount) &&
    finiteNumber(scores365?.away?.restFixture?.next14DaysCount)
  ) {
    sources.fixture_congestion = '365Scores';
  }

  if (
    scores365?.matchContext?.competitionId &&
    scores365?.matchContext?.home?.position != null &&
    scores365?.matchContext?.away?.position != null
  ) {
    sources.match_context = '365Scores';
  }

  if (
    scores365?.matchContext?.competitionId &&
    finiteNumber(scores365?.matchContext?.stageNum) &&
    finiteNumber(scores365?.matchContext?.tableSize) &&
    scores365.matchContext.tableSize > 0 &&
    finiteNumber(scores365?.matchContext?.home?.position) &&
    finiteNumber(scores365?.matchContext?.away?.position)
  ) {
    sources.table_season_stage = '365Scores';
  }

  if (
    (scores365?.home?.son5?.scoreState?.dataMatches || 0) > 0 &&
    (scores365?.away?.son5?.scoreState?.dataMatches || 0) > 0
  ) {
    sources.score_state = '365Scores';
  }

  return sources;
}

function mergeSupplementCoverage(primaryCoverage, supplements) {
  const metricSources = supplementCoverageSources(supplements);
  const added = Object.keys(metricSources).filter(
    key => primaryCoverage.missing.includes(key)
  );

  const available = [...primaryCoverage.available, ...added];
  const addedSet = new Set(added);
  const missing = primaryCoverage.missing.filter(
    key => !addedSet.has(key)
  );
  const total = available.length + missing.length;
  const score = total
    ? Math.round((available.length / total) * 100)
    : 0;

  return {
    score,
    available_count: available.length,
    total_count: total,
    available,
    missing,
    supplement_added: added,
    metric_sources: Object.fromEntries(
      added.map(key => [key, metricSources[key]])
    )
  };
}

const performanceProviders = [
  { name: 'FotMob', build: buildFotMobPerformancePackage },
  { name: 'Understat', build: buildUnderstatPerformancePackage },
  { name: 'BetExplorer', build: buildBetExplorerPerformancePackage },
];

function hasUsablePerformance(data) {
  return Boolean(data && data.evTakimi && data.deplasmanTakimi);
}

async function buildPerformancePackage(input) {
  const attempts = [];
  let lastError = null;

  for (const provider of performanceProviders) {
    try {
      const data = await provider.build(input);
      if (hasUsablePerformance(data) === false) {
        attempts.push({ provider: provider.name, status: 'empty' });
        continue;
      }

      attempts.push({ provider: provider.name, status: 'ok' });
      const coverage = evaluatePerformanceCoverage(data);
      const supplementResult = await collectPerformanceSupplements(
        provider.name,
        input,
        data,
        coverage
      );
      const supplementNames = Object.keys(supplementResult.supplements);
      const dataWithStyleSources = attachStyleSources(
        data,
        supplementResult.supplements
      );
      const coverageWithAttachedSources =
        evaluatePerformanceCoverage(dataWithStyleSources);
      const combinedCoverage = mergeSupplementCoverage(
        coverageWithAttachedSources,
        supplementResult.supplements
      );

      return {
        ...dataWithStyleSources,
        source_supplements: supplementResult.supplements,
        primary_data_confidence: coverage.score,
        data_confidence: combinedCoverage.score,
        data_coverage: {
          available_count: combinedCoverage.available_count,
          total_count: combinedCoverage.total_count,
          available: combinedCoverage.available,
          missing: combinedCoverage.missing,
          supplement_added: combinedCoverage.supplement_added,
          metric_sources: combinedCoverage.metric_sources,
        },
        meta: {
          ...(data.meta || {}),
          provider: provider.name,
          providerAttempts: attempts,
          fallbackUsed: attempts.length > 1,
          supplementSources: supplementNames,
          supplementAttempts: supplementResult.attempts,
          sourceStrategy: supplementNames.length
            ? 'primary-plus-supplement'
            : 'primary-only',
        },
      };
    } catch (err) {
      lastError = err;
      attempts.push({
        provider: provider.name,
        status: 'failed',
        error: String(err && err.message ? err.message : err).slice(0, 300),
      });
    }
  }

  const error = new Error(
    lastError
      ? 'Performans kaynaklari basarisiz: ' + String(lastError.message || lastError)
      : 'Kullanilabilir performans kaynagi bulunamadi.'
  );
  error.providerAttempts = attempts;
  throw error;
}

module.exports = { buildPerformancePackage };
