const { execFile } = require('child_process');
const { promisify } = require('util');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const execFileAsync = promisify(execFile);

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';

const DEFAULT_REMOTE_SOURCE_SECRET =
  'ee3a321e49e949c5ac27dc2a5504ba55a59b11eae7ab1f7b5357cd305b6e8968';

const MIN_HEALTHY_BOOKMAKERS = Math.max(
  1,
  Math.min(50, Number(process.env.ODDS_MIN_HEALTHY_BOOKMAKERS) || 12)
);

const MIN_OPENING_BOOKMAKERS = Math.max(
  1,
  Math.min(50, Number(process.env.ODDS_MIN_OPENING_BOOKMAKERS) || 8)
);

function remoteSourceConfig() {
  const base = String(process.env.ODDS_REMOTE_SOURCE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) return null;

  const secret = String(
    process.env.ODDS_REMOTE_SOURCE_SECRET ||
    DEFAULT_REMOTE_SOURCE_SECRET
  );
  if (!secret) {
    throw new Error('Remote odds source shared secret missing.');
  }

  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Invalid remote odds source protocol.');
  }
  return { base, secret };
}

function hmacHex(secret, value) {
  return crypto.createHmac('sha256', secret)
    .update(String(value))
    .digest('hex');
}

function equalHex(left, right) {
  const a = Buffer.from(String(left || ''), 'hex');
  const b = Buffer.from(String(right || ''), 'hex');
  return a.length === 32 &&
    b.length === 32 &&
    crypto.timingSafeEqual(a, b);
}

function remoteGet(endpoint, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(endpoint);
    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.get(
      parsed,
      { headers, timeout: 60000 },
      res => {
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            req.destroy(new Error('Remote odds response too large.'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({
          status: Number(res.statusCode || 0),
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        }));
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('Remote odds source timeout.'));
    });
    req.on('error', reject);
  });
}

async function fetchRemoteValidated(rawUrl, capture) {
  const config = remoteSourceConfig();
  if (!config) return null;

  const parsed = parseBetExplorerUrl(rawUrl);
  const mode = capture === 'opening' ? 'opening' : 'current';
  const timestamp = String(Date.now());
  const requestSignature = hmacHex(
    config.secret,
    timestamp + '\n' + mode + '\n' + parsed.url
  );

  const endpoint =
    config.base +
    '/api/internal/odds-source/1x2?capture=' +
    encodeURIComponent(mode) +
    '&url=' +
    encodeURIComponent(parsed.url);

  const response = await remoteGet(endpoint, {
    accept: 'application/json',
    'x-odds-ts': timestamp,
    'x-odds-signature': requestSignature
  });

  const responseSignature = String(
    response.headers['x-odds-response-signature'] || ''
  );
  const expectedResponseSignature = hmacHex(
    config.secret,
    timestamp + '\n' + response.body
  );
  if (!equalHex(responseSignature, expectedResponseSignature)) {
    throw new Error('Remote odds response signature invalid.');
  }

  let payload;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new Error('Remote odds source returned invalid JSON.');
  }

  if (response.status !== 200) {
    throw new Error(
      'Remote odds source HTTP ' + response.status + ': ' +
      String(payload?.error || 'unknown error')
    );
  }

  if (
    String(payload?.event_id || '') !== parsed.eventId ||
    payload?.market !== '1X2' ||
    !Array.isArray(payload?.rows)
  ) {
    throw new Error('Remote odds source envelope invalid.');
  }

  const minimum = mode === 'opening'
    ? MIN_OPENING_BOOKMAKERS
    : MIN_HEALTHY_BOOKMAKERS;
  if (payload.rows.length < minimum) {
    throw new Error(
      'Remote odds coverage too low: ' +
      payload.rows.length + ' < ' + minimum
    );
  }

  const rows = payload.rows.map(row => {
    const bookmakerId = String(row?.bookmaker_id || '').trim() || null;
    const bookmakerName = String(row?.bookmaker_name || '').trim();
    const homeOdd = Number(row?.home_odd);
    const drawOdd = Number(row?.draw_odd);
    const awayOdd = Number(row?.away_odd);

    if (
      !bookmakerName ||
      ![homeOdd, drawOdd, awayOdd].every(
        value => Number.isFinite(value) && value > 1
      )
    ) {
      throw new Error('Remote odds row invalid.');
    }

    const out = {
      bookmakerId,
      bookmakerName,
      homeOdd,
      drawOdd,
      awayOdd
    };

    if (mode === 'opening') {
      const capturedAt = new Date(row?.captured_at);
      if (!Number.isFinite(capturedAt.getTime())) {
        throw new Error('Remote opening timestamp invalid.');
      }
      out.capturedAt = capturedAt;
    }
    return out;
  });

  let capturedAt = null;
  if (mode === 'current') {
    capturedAt = new Date(payload.captured_at);
    if (!Number.isFinite(capturedAt.getTime())) {
      throw new Error('Remote current timestamp invalid.');
    }
  }

  return {
    eventId: parsed.eventId,
    url: parsed.url,
    market: '1X2',
    capturedAt,
    sourceName: String(payload.source_name || '').trim(),
    sourceRegion: payload.source_region == null
      ? null
      : String(payload.source_region).trim() || null,
    rows,
    attempts: Array.isArray(payload.attempts)
      ? payload.attempts
      : [],
    fallbackUsed: payload.fallback_used === true
  };
}

function parseBetExplorerUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  const match = value.match(/\/([A-Za-z0-9]{6,16})\/?$/);
  if (!match) throw new Error('Invalid BetExplorer match URL.');
  return { url: value, eventId: match[1] };
}

function bookmakerKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\.(de|com|tr|eu|net|org)$/i, '');
}

function decodeHtml(value = '') {
  return String(value)
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

function extractBookmaker(rowHtml) {
  const patterns = [
    /data-bookie\s*=\s*["']([^"']+)["']/i,
    /<a\b[^>]*title\s*=\s*["']([^"']+)["'][^>]*>/i,
    /class\s*=\s*["'][^"']*table-main__participant[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i
  ];
  for (const pattern of patterns) {
    const match = rowHtml.match(pattern);
    if (match) {
      const value = decodeHtml(match[1]);
      if (value) return value;
    }
  }
  return '';
}

function cellAttr(tag, name) {
  const wanted = String(name || '').toLowerCase();
  const attrs = [
    ...String(tag).matchAll(/\b(data-[a-z0-9_-]+)\s*=\s*["']([^"']*)["']/gi)
  ];
  const match = attrs.find(item =>
    String(item[1] || '').toLowerCase() === wanted
  );
  return match ? decodeHtml(match[2]) : null;
}

function parse1x2Detailed(html) {
  const seen = new Set();
  const rows = [];
  const tableRows = [
    ...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)
  ].map(match => match[1]);

  for (const rowHtml of tableRows) {
    const oddTags = [
      ...rowHtml.matchAll(/<td\b[^>]*\bdata-odd\s*=\s*["'][^"']+["'][^>]*>/gi)
    ].map(match => match[0]);

    if (oddTags.length < 3) continue;

    const cells = oddTags.slice(0, 3).map(tag => ({
      value: Number(String(cellAttr(tag, 'data-odd') || '').replace(',', '.')),
      oid: cellAttr(tag, 'data-oid'),
      bid: cellAttr(tag, 'data-bid'),
      bt: cellAttr(tag, 'data-bt'),
      sc: cellAttr(tag, 'data-sc'),
      hcp: cellAttr(tag, 'data-hcp'),
      created: cellAttr(tag, 'data-created')
    }));

    if (cells.some(cell =>
      !Number.isFinite(cell.value) || cell.value <= 1 || cell.value >= 1000
    )) continue;

    const bookmakerName = extractBookmaker(rowHtml);
    const key = bookmakerKey(bookmakerName);
    if (!key || seen.has(key)) continue;

    rows.push({
      bookmakerId: key,
      bookmakerName,
      homeOdd: cells[0].value,
      drawOdd: cells[1].value,
      awayOdd: cells[2].value,
      cells
    });
    seen.add(key);
  }

  return rows;
}

function parse1x2(html) {
  return parse1x2Detailed(html).map(({ cells, ...row }) => row);
}

function parseOpeningAt(rawDate, cellCreated) {
  const opening = String(rawDate || '').match(
    /(\d{1,2})\.(\d{1,2})\.\s+(\d{1,2}):(\d{2})/
  );
  const current = String(cellCreated || '').match(
    /(\d{1,2}),(\d{1,2}),(\d{4}),(\d{1,2}),(\d{2})/
  );
  if (!opening || !current) return null;

  const day = Number(opening[1]);
  const month = Number(opening[2]);
  const hour = Number(opening[3]);
  const minute = Number(opening[4]);
  const currentDay = Number(current[1]);
  const currentMonth = Number(current[2]);
  let year = Number(current[3]);
  const currentHour = Number(current[4]);
  const currentMinute = Number(current[5]);

  const currentMs = Date.UTC(
    year, currentMonth - 1, currentDay, currentHour, currentMinute
  );
  let openingMs = Date.UTC(year, month - 1, day, hour, minute);

  if (openingMs > currentMs + 45 * 86400000) {
    year -= 1;
    openingMs = Date.UTC(year, month - 1, day, hour, minute);
  }
  return new Date(openingMs);
}

function sourceChain() {
  return [
    {
      sourceName: 'betexplorer-nl',
      sourceRegion: 'nl',
      socksAddress: String(process.env.TOR_SOCKS_NL || '127.0.0.1:9065').trim()
    },
    {
      sourceName: 'betexplorer-ca',
      sourceRegion: 'ca',
      socksAddress: String(process.env.TOR_SOCKS_CA || '127.0.0.1:9066').trim()
    },
    {
      sourceName: 'betexplorer-default-tor',
      sourceRegion: null,
      socksAddress: String(
        process.env.TOR_SOCKS_DEFAULT ||
        process.env.TOR_SOCKS ||
        '127.0.0.1:9050'
      ).trim()
    },
    {
      sourceName: 'betexplorer-direct',
      sourceRegion: null,
      socksAddress: null
    }
  ];
}

function curlArgs(source, endpoint) {
  const args = [
    '--silent', '--show-error', '--location', '--fail', '--compressed',
    '--connect-timeout', '10',
    '--max-time', '25',
    '--header', 'User-Agent: ' + USER_AGENT,
    '--header', 'Accept-Language: en-US,en;q=0.9',
    '--header', 'Accept: application/json,text/javascript,*/*;q=0.01',
    '--header', 'X-Requested-With: XMLHttpRequest',
    '--header', 'Referer: https://www.betexplorer.com/'
  ];
  if (source.socksAddress) {
    args.push('--socks5-hostname', source.socksAddress);
  }
  args.push(endpoint);
  return args;
}

async function requestJson(source, endpoint, maxBuffer = 12 * 1024 * 1024) {
  const { stdout } = await execFileAsync('curl', curlArgs(source, endpoint), {
    maxBuffer,
    timeout: 30000
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('BetExplorer did not return JSON.');
  }
}

async function fetch1x2Source(rawUrl, source) {
  const parsed = parseBetExplorerUrl(rawUrl);
  const endpoint =
    'https://www.betexplorer.com/match-odds/' +
    parsed.eventId + '/0/1x2/odds/?lang=en';

  const payload = await requestJson(source, endpoint);

  if (!payload || typeof payload.odds !== 'string' || !payload.odds.trim()) {
    throw new Error('BetExplorer 1X2 odds HTML is empty.');
  }

  const rows = parse1x2(payload.odds);
  if (rows.length < MIN_HEALTHY_BOOKMAKERS) {
    throw new Error(
      'Insufficient 1X2 bookmaker coverage: ' +
      rows.length + ' < ' + MIN_HEALTHY_BOOKMAKERS
    );
  }

  return {
    eventId: parsed.eventId,
    url: parsed.url,
    market: '1X2',
    capturedAt: new Date(),
    sourceName: source.sourceName,
    sourceRegion: source.sourceRegion,
    rows
  };
}

async function fetchArchiveOpening(cell, source) {
  if (!cell?.oid || !cell?.bid || !cell?.bt || !cell?.sc || !cell?.hcp) {
    return null;
  }

  const endpoint =
    'https://www.betexplorer.com/archive-odds/' +
    [cell.oid, cell.bid, cell.bt, cell.sc, cell.hcp]
      .map(encodeURIComponent)
      .join('/') +
    '/';

  const payload = await requestJson(source, endpoint, 4 * 1024 * 1024);
  if (!Array.isArray(payload) || !payload.length) return null;

  const first = payload[payload.length - 1];
  const odd = Number(String(first?.odd || '').replace(',', '.'));
  const openingAt = parseOpeningAt(first?.date, cell.created);

  if (!Number.isFinite(odd) || odd <= 1 || !openingAt) return null;

  return {
    odd,
    openingAt,
    sourceDate: first?.date || null
  };
}

async function fetchOpening1x2Source(rawUrl, source) {
  const parsed = parseBetExplorerUrl(rawUrl);
  const endpoint =
    'https://www.betexplorer.com/match-odds/' +
    parsed.eventId + '/0/1x2/odds/?lang=en';

  const payload = await requestJson(source, endpoint);
  if (!payload || typeof payload.odds !== 'string' || !payload.odds.trim()) {
    throw new Error('BetExplorer opening market HTML is empty.');
  }

  const detailed = parse1x2Detailed(payload.odds);
  if (detailed.length < MIN_HEALTHY_BOOKMAKERS) {
    throw new Error(
      'Insufficient opening market coverage: ' +
      detailed.length + ' < ' + MIN_HEALTHY_BOOKMAKERS
    );
  }

  const rows = [];
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= detailed.length) return;
      const row = detailed[index];

      try {
        const values = await Promise.all(
          row.cells.map(cell => fetchArchiveOpening(cell, source))
        );
        if (values.some(value => !value)) continue;

        const times = values.map(value => value.openingAt.getTime());
        rows.push({
          bookmakerId: row.bookmakerId,
          bookmakerName: row.bookmakerName,
          homeOdd: values[0].odd,
          drawOdd: values[1].odd,
          awayOdd: values[2].odd,
          capturedAt: new Date(Math.max(...times)),
          openingAtBySelection: {
            home: values[0].openingAt,
            draw: values[1].openingAt,
            away: values[2].openingAt
          }
        });
      } catch {
        // A single bookmaker archive failure must not destroy the full set.
      }
    }
  };

  const concurrency = Math.min(4, detailed.length);
  await Promise.all(Array.from({ length: concurrency }, worker));

  if (rows.length < MIN_OPENING_BOOKMAKERS) {
    throw new Error(
      'Insufficient opening archive coverage: ' +
      rows.length + ' < ' + MIN_OPENING_BOOKMAKERS
    );
  }

  rows.sort((a, b) => a.bookmakerName.localeCompare(b.bookmakerName));

  return {
    eventId: parsed.eventId,
    url: parsed.url,
    market: '1X2',
    sourceName: source.sourceName + '-archive',
    sourceRegion: source.sourceRegion,
    rows
  };
}

async function fetch1x2SingleSource(rawUrl, {
  socksAddress = '127.0.0.1:9050',
  sourceName = 'betexplorer-default-tor',
  sourceRegion = null
} = {}) {
  return fetch1x2Source(rawUrl, {
    socksAddress,
    sourceName,
    sourceRegion
  });
}

async function pull1x2WithFailover(rawUrl) {
  const attempts = [];
  const remote = remoteSourceConfig();

  if (remote) {
    try {
      const result = await fetchRemoteValidated(rawUrl, 'current');
      return {
        ...result,
        attempts: result.attempts || [],
        fallbackUsed: result.fallbackUsed === true
      };
    } catch (error) {
      attempts.push({
        sourceName: 'remote-validated',
        sourceRegion: null,
        error: String(error?.message || error)
      });
    }
  }

  for (const source of sourceChain()) {
    try {
      const result = await fetch1x2Source(rawUrl, source);
      return {
        ...result,
        attempts,
        fallbackUsed: attempts.length > 0
      };
    } catch (error) {
      attempts.push({
        sourceName: source.sourceName,
        sourceRegion: source.sourceRegion,
        error: String(error?.message || error)
      });
    }
  }

  const detail = attempts
    .map(item => item.sourceName + ': ' + item.error)
    .join(' | ');

  throw new Error('No validated 1X2 source. ' + detail);
}

async function pullOpening1x2WithFailover(rawUrl) {
  const attempts = [];
  const remote = remoteSourceConfig();

  if (remote) {
    try {
      const result = await fetchRemoteValidated(rawUrl, 'opening');
      return {
        ...result,
        attempts: result.attempts || [],
        fallbackUsed: result.fallbackUsed === true
      };
    } catch (error) {
      attempts.push({
        sourceName: 'remote-validated-opening',
        sourceRegion: null,
        error: String(error?.message || error)
      });
    }
  }

  for (const source of sourceChain()) {
    try {
      const result = await fetchOpening1x2Source(rawUrl, source);
      return {
        ...result,
        attempts,
        fallbackUsed: attempts.length > 0
      };
    } catch (error) {
      attempts.push({
        sourceName: source.sourceName,
        sourceRegion: source.sourceRegion,
        error: String(error?.message || error)
      });
    }
  }

  const detail = attempts
    .map(item => item.sourceName + ': ' + item.error)
    .join(' | ');

  throw new Error('No validated opening 1X2 source. ' + detail);
}

module.exports = {
  parseBetExplorerUrl,
  parse1x2,
  fetch1x2SingleSource,
  pull1x2WithFailover,
  pullOpening1x2WithFailover,
  sourceChain
};
