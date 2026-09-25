const ENDPOINT_BASE =
  'https://www.betexplorer.com/gres/ajax/odds-movements.php';

function buildEndpoint(options = {}) {
  const hours = Number(options.hours ?? 1);
  const days = Number(options.days ?? 1);
  const bookies = Number(options.bookies ?? 30);

  if (![1, 2, 12, 24, 48].includes(hours)) {
    throw new Error('Gecersiz Dropping hours: ' + hours);
  }
  if (![0, 1, 2, 7].includes(days)) {
    throw new Error('Gecersiz Dropping days: ' + days);
  }
  if (![30, 40, 50, 60, 70].includes(bookies)) {
    throw new Error('Gecersiz Dropping bookies: ' + bookies);
  }

  const params = new URLSearchParams({
    sport_id: '1',
    hours: String(hours),
    days: String(days),
    bookies: String(bookies),
    lang: 'en'
  });

  return ENDPOINT_BASE + '?' + params.toString();
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#039;|&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDropping(html) {
  const rows = [];
  const blocks = String(html).match(/<tbody>[\s\S]*?<\/tbody>/gi) || [];
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const byType = Object.fromEntries(parts.map(x => [x.type, x.value]));
  let currentDate = byType.day + '.' + byType.month + '.' + byType.year;
  let currentLeague = null;

  for (const block of blocks) {
    const league = block.match(/table-main__tournament[^>]*>[\s\S]*?<\/i>([^<]+)<\/a>/i);
    const date = block.match(/table-main__date">([^<]+)</i);

    if (league) currentLeague = decodeHtml(league[1]);
    if (date) currentDate = decodeHtml(date[1]);

    const matchLink = block.match(/href="\/football\/[^"]+\/([A-Za-z0-9]+)\/">([^<]+)<\/a>/i);
    const time = block.match(/table-main__time">([^<]+)</i);
    if (!matchLink) continue;

    const oddsCells = [
      ...block.matchAll(/<td class="table-main__odds([^"]*)"[^>]*data-oid="([^"]+)"[\s\S]*?<\/td>/gi)
    ];

    for (let index = 0; index < oddsCells.length && index < 3; index++) {
      const classes = oddsCells[index][1] || '';
      if (!/\bdrop\d\b/i.test(classes)) continue;

      const cell = oddsCells[index][0];
      const detail = cell.match(/<li>Drop:\s*(\d+)%<\/li>[\s\S]*?<span data-odd="([^"]+)"><\/span>\s*&raquo;\s*<span data-odd="([^"]+)"><\/span>[\s\S]*?B's:\s*(\d+)%\s*\((\d+)\/(\d+)\)/i);
      if (!detail) continue;

      const selection = ['1', 'X', '2'][index] || null;
      rows.push({
        matchId: matchLink[1],
        match: decodeHtml(matchLink[2]),
        time: time ? decodeHtml(time[1]) : null,
        date: currentDate,
        league: currentLeague,
        selection,
        outcomeId: oddsCells[index][2],
        dropPct: Number(detail[1]),
        oldOdd: Number(detail[2]),
        currentOdd: Number(detail[3]),
        bookiesPct: Number(detail[4]),
        bookiesDown: Number(detail[5]),
        bookiesTotal: Number(detail[6])
      });
    }
  }

  return rows;
}

function discoverPaginationUrls(html, currentUrl) {
  const found = new Set();
  const current = new URL(currentUrl);
  const source = String(html || '');
  const anchorRe = /<a\b([^>]*)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorRe.exec(source))) {
    const attrs = (match[1] || '') + ' ' + (match[3] || '');
    const text = decodeHtml(match[4] || '');
    const href = match[2];
    const paginationHint =
      /\brel\s*=\s*["']?next\b/i.test(attrs) ||
      /\b(next|pager|pagination|page-next|load-more)\b/i.test(attrs) ||
      /^(next|older|more|>)$/i.test(text) ||
      /[?&](page|p|offset)=\d+/i.test(href);

    if (!paginationHint) continue;

    try {
      const url = new URL(href, current);
      if (url.origin !== current.origin) continue;
      if (url.pathname !== current.pathname) continue;
      found.add(url.toString());
    } catch (_) {}
  }

  const dataUrlRe = /\bdata-(?:url|next-url)=["']([^"']+)["']/gi;
  while ((match = dataUrlRe.exec(source))) {
    try {
      const url = new URL(match[1], current);
      if (url.origin !== current.origin) continue;
      if (url.pathname !== current.pathname) continue;
      if (!/[?&](page|p|offset)=\d+/i.test(url.search)) continue;
      found.add(url.toString());
    } catch (_) {}
  }

  found.delete(current.toString());
  return [...found];
}

async function fetchDropping(options = {}) {
  const firstEndpoint = buildEndpoint(options);
  const fetchImpl = options.fetchImpl || fetch;
  const maxPages = Math.min(20, Math.max(1, Number(options.maxPages || 10)));
  const queue = [firstEndpoint];
  const seenPages = new Set();
  const rowsByKey = new Map();

  while (queue.length && seenPages.size < maxPages) {
    const endpoint = queue.shift();
    if (seenPages.has(endpoint)) continue;
    seenPages.add(endpoint);

    const response = await fetchImpl(endpoint, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/149 Mobile Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: 'https://www.betexplorer.com/football/dropping-odds/',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    if (!response.ok) throw new Error('Dropping HTTP ' + response.status);
    const html = await response.text();

    for (const row of parseDropping(html)) {
      rowsByKey.set(row.matchId + '|' + row.outcomeId, row);
    }

    for (const nextUrl of discoverPaginationUrls(html, endpoint)) {
      if (!seenPages.has(nextUrl) && !queue.includes(nextUrl)) queue.push(nextUrl);
    }
  }

  if (queue.length) {
    throw new Error('Dropping pagination overflow: maxPages=' + maxPages);
  }

  return [...rowsByKey.values()];
}

if (require.main === module) {
  fetchDropping()
    .then(rows => {
      console.log('DROPPING_COUNT=' + rows.length);
      console.log(JSON.stringify(rows.slice(0, 5), null, 2));
    })
    .catch(error => {
      console.error('DROPPING_ERROR=' + (error.message || error));
      process.exitCode = 1;
    });
}

module.exports = { fetchDropping, parseDropping, buildEndpoint, discoverPaginationUrls };
