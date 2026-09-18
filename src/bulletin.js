const { sleep } = require('./util');

const cache = new Map();

function decodeHtml(x = '') {
  return String(x)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDailyFootball(html) {
  const heads = [];
  const leagueRe = /<p[^>]*class="[^"]*leaguesNames[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = leagueRe.exec(html))) {
    const league = decodeHtml(m[1]);
    if (league) heads.push({ league, start: m.index, end: leagueRe.lastIndex });
  }

  const out = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1].start : html.length;
    const block = html.slice(h.end, end);
    const rowRe = /<li[^>]*data-event-id="([^"]+)"[^>]*>([\s\S]*?)(?=<li[^>]*data-event-id="|<p[^>]*class="[^"]*leaguesNames|$)/gi;
    let row;
    while ((row = rowRe.exec(block))) {
      const eventId = row[1];
      const body = row[2];
      const link = body.match(/<a href="(\/football\/[^"]+\/([A-Za-z0-9]{6,12})\/)"[^>]*data-live-cell="matchlink"[^>]*>([\s\S]*?)<\/a>/i)
        || body.match(/<a[^>]*data-live-cell="matchlink"[^>]*href="(\/football\/[^"]+\/([A-Za-z0-9]{6,12})\/)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!link) continue;
      const timeM = body.match(/data-live-cell="time"[^>]*>\s*([^<\n]+)/i);
      const teams = [...link[3].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(x => decodeHtml(x[1])).filter(Boolean);
      let name = '';
      if (teams.length >= 2) name = `${teams[0]} - ${teams[teams.length - 1]}`;
      if (!name) {
        const slug = link[1].split('/').filter(Boolean).slice(-2, -1)[0] || '';
        name = slug.replace(/-/g, ' ');
      }
      out.push({
        league: h.league,
        time: decodeHtml(timeM?.[1] || ''),
        name,
        url: `https://www.betexplorer.com${link[1]}`,
        eventId
      });
    }
  }
  const seen = new Set();
  return out.filter(x => x.url && !seen.has(x.url) && seen.add(x.url));
}

async function fetchTextWithRetry(url, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 50000);
      const r = await fetch(url, {
        signal: c.signal,
        redirect: 'follow',
        headers: {
          'user-agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/149 Mobile Safari/537.36',
          'accept-language': 'en-US,en;q=0.9'
        }
      });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) {
      last = e;
      if (i < attempts) await sleep(1000);
    }
  }
  throw last;
}

async function getBulletin(date, { force = false } = {}) {
  const c = cache.get(date);
  if (!force && c && Date.now() - c.fetchedAt < 10 * 60 * 1000) return c;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Tarih YYYY-MM-DD olmalı.');
  const [y, m, d] = date.split('-');
  const target = `https://www.betexplorer.com/?day=${d}&month=${m}&year=${y}`;
  const html = await fetchTextWithRetry(target);
  const eventRaw = (html.match(/data-event-id=/g) || []).length;
  if (!eventRaw) throw new Error('BetExplorer bülten verisi gelmedi.');
  const matches = parseDailyFootball(html);
  const data = { date, fetchedAt: Date.now(), matches, eventRaw };
  cache.set(date, data);
  return data;
}

module.exports = { getBulletin, parseDailyFootball };
