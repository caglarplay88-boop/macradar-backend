'use strict';


const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';

const MIN_HEALTHY_BOOKMAKERS = 1;
const MIN_OPENING_BOOKMAKERS = 1;

function parseBetExplorerUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  const match = value.match(/\/([A-Za-z0-9]{6,16})\/?$/);

  if (!match) {
    throw new Error('Invalid BetExplorer match URL.');
  }

  return {
    url: value,
    eventId: match[1]
  };
}

function sourceChain() {
  return [
    {
      sourceName: 'betexplorer-nl',
      sourceRegion: 'nl',
      socksAddress: String(
        process.env.TOR_SOCKS_NL || '127.0.0.1:9065'
      ).trim()
    },
    {
      sourceName: 'betexplorer-ca',
      sourceRegion: 'ca',
      socksAddress: String(
        process.env.TOR_SOCKS_CA || '127.0.0.1:9066'
      ).trim()
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
    '--silent',
    '--show-error',
    '--location',
    '--fail',
    '--compressed',
    '--connect-timeout',
    '10',
    '--max-time',
    '25',
    '--header',
    'User-Agent: ' + USER_AGENT,
    '--header',
    'Accept-Language: en-US,en;q=0.9',
    '--header',
    'Accept: application/json,text/javascript,*/*;q=0.01',
    '--header',
    'X-Requested-With: XMLHttpRequest',
    '--header',
    'Referer: https://www.betexplorer.com/'
  ];

  if (source.socksAddress) {
    args.push('--socks5-hostname', source.socksAddress);
  }

  args.push(endpoint);
  return args;
}

async function requestJson(
  source,
  endpoint,
  maxBuffer = 12 * 1024 * 1024
) {
  const { stdout } = await execFileAsync(
    'curl',
    curlArgs(source, endpoint),
    {
      maxBuffer,
      timeout: 30000
    }
  );

  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('BetExplorer did not return JSON.');
  }
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

function cellAttr(tag, name) {
  const wanted = String(name || '').toLowerCase();
  const attrs = [
    ...String(tag).matchAll(
      /\b(data-[a-z0-9_-]+)\s*=\s*["']([^"']*)["']/gi
    )
  ];

  const match = attrs.find(
    item => String(item[1] || '').toLowerCase() === wanted
  );

  return match ? decodeHtml(match[2]) : null;
}

function extractBookmaker(rowHtml) {
  const patterns = [
    /data-bookie\s*=\s*["']([^"']+)["']/i,
    /<a\b[^>]*title\s*=\s*["']([^"']+)["'][^>]*>/i,
    /class\s*=\s*["'][^"']*table-main__participant[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i
  ];

  for (const pattern of patterns) {
    const match = String(rowHtml).match(pattern);
    if (!match) continue;

    const value = decodeHtml(match[1]);
    if (value) return value;
  }

  return '';
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

function extractTotalLine(rowHtml, oddTags) {
  const direct = String(rowHtml).match(
    /class\s*=\s*["'][^"']*table-main__doubleparameter[^"']*["'][^>]*>\s*(1[.,]5|2[.,]5)\s*</i
  );

  if (direct) {
    return Number(direct[1].replace(',', '.'));
  }

  for (const tag of oddTags) {
    const hcp = String(cellAttr(tag, 'data-hcp') || '');

    const match = hcp.match(
      /(?:^|-)(1[.,]5|2[.,]5)(?:-|$)/
    );

    if (match) {
      return Number(match[1].replace(',', '.'));
    }
  }

  return null;
}

function parseOverUnderDetailed(html) {
  const rows = [];
  const seen = new Set();

  const tableRows = [
    ...String(html).matchAll(
      /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    )
  ].map(match => match[1]);

  for (const rowHtml of tableRows) {
    const oddTags = [
      ...rowHtml.matchAll(
        /<td\b[^>]*\bdata-odd\s*=\s*["'][^"']+["'][^>]*>/gi
      )
    ].map(match => match[0]);

    if (oddTags.length < 2) continue;

    const totalLine = extractTotalLine(rowHtml, oddTags);

    if (totalLine !== 1.5 && totalLine !== 2.5) {
      continue;
    }

    // BetExplorer O/U tablosunda kolon sırası:
    // Over -> Under
    const cells = oddTags.slice(0, 2).map(tag => ({
      value: Number(
        String(cellAttr(tag, 'data-odd') || '').replace(',', '.')
      ),
      oid: cellAttr(tag, 'data-oid'),
      bid: cellAttr(tag, 'data-bid'),
      bt: cellAttr(tag, 'data-bt'),
      sc: cellAttr(tag, 'data-sc'),
      hcp: cellAttr(tag, 'data-hcp'),
      created: cellAttr(tag, 'data-created'),
      closed: /\bclass\s*=\s*["'][^"']*\binactive\b[^"']*["']/i.test(tag)
    }));

    if (
      cells.some(
        cell =>
          !Number.isFinite(cell.value) ||
          cell.value <= 1 ||
          cell.value >= 1000
      )
    ) {
      continue;
    }

    const bookmakerName = extractBookmaker(rowHtml);
    const key = bookmakerKey(bookmakerName);

    if (!key) continue;

    const uniqueKey = key + '|' + totalLine.toFixed(1);
    if (seen.has(uniqueKey)) continue;

    rows.push({
      bookmakerId: key,
      bookmakerName,
      totalLine,

      overOdd: cells[0].value,
      underOdd: cells[1].value,

      overClosed: cells[0].closed === true,
      underClosed: cells[1].closed === true,

      cells
    });

    seen.add(uniqueKey);
  }

  return rows;
}

function parseOverUnder(html) {
  return parseOverUnderDetailed(html).map(
    ({ cells, ...row }) => row
  );
}



async function fetchOverUnderSource(rawUrl, source) {
  const parsed = parseBetExplorerUrl(rawUrl);

  const endpoint =
    'https://www.betexplorer.com/match-odds/' +
    parsed.eventId +
    '/0/ou/odds/?lang=en';

  const payload = await requestJson(source, endpoint);

  if (
    !payload ||
    typeof payload.odds !== 'string' ||
    !payload.odds.trim()
  ) {
    throw new Error('BetExplorer Over/Under odds HTML is empty.');
  }

  const rows = parseOverUnder(payload.odds);

  const line15 = rows.filter(row => row.totalLine === 1.5);
  const line25 = rows.filter(row => row.totalLine === 2.5);

  if (line15.length < MIN_HEALTHY_BOOKMAKERS) {
    throw new Error(
      'Insufficient O/U 1.5 bookmaker coverage: ' +
      line15.length +
      ' < ' +
      MIN_HEALTHY_BOOKMAKERS
    );
  }

  if (line25.length < MIN_HEALTHY_BOOKMAKERS) {
    throw new Error(
      'Insufficient O/U 2.5 bookmaker coverage: ' +
      line25.length +
      ' < ' +
      MIN_HEALTHY_BOOKMAKERS
    );
  }

  return {
    eventId: parsed.eventId,
    url: parsed.url,
    market: 'OVER_UNDER',
    capturedAt: new Date(),
    sourceName: source.sourceName,
    sourceRegion: source.sourceRegion,
    rows
  };
}

async function pullOverUnderWithFailover(rawUrl) {
  const attempts = [];

  for (const source of sourceChain()) {
    try {
      const result = await fetchOverUnderSource(rawUrl, source);

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

  throw new Error('No validated Over/Under source. ' + detail);
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
    year,
    currentMonth - 1,
    currentDay,
    currentHour,
    currentMinute
  );

  let openingMs = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute
  );

  if (openingMs > currentMs + 45 * 86400000) {
    year -= 1;
    openingMs = Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute
    );
  }

  return new Date(openingMs);
}

async function fetchArchiveOpening(cell, source) {
  if (
    !cell?.oid ||
    !cell?.bid ||
    !cell?.bt ||
    !cell?.sc ||
    !cell?.hcp
  ) {
    return null;
  }

  const endpoint =
    'https://www.betexplorer.com/archive-odds/' +
    [
      cell.oid,
      cell.bid,
      cell.bt,
      cell.sc,
      cell.hcp
    ]
      .map(encodeURIComponent)
      .join('/') +
    '/';

  const payload = await requestJson(
    source,
    endpoint,
    4 * 1024 * 1024
  );

  if (!Array.isArray(payload) || !payload.length) {
    return null;
  }

  // BetExplorer archive dizisinde en eski kayıt sondadır.
  const first = payload[payload.length - 1];

  const odd = Number(
    String(first?.odd || '').replace(',', '.')
  );

  const openingAt = parseOpeningAt(
    first?.date,
    cell.created
  );

  if (
    !Number.isFinite(odd) ||
    odd <= 1 ||
    !openingAt
  ) {
    return null;
  }

  return {
    odd,
    openingAt,
    sourceDate: first?.date || null
  };
}

async function fetchOpeningOverUnderSource(rawUrl, source) {
  const parsed = parseBetExplorerUrl(rawUrl);

  const endpoint =
    'https://www.betexplorer.com/match-odds/' +
    parsed.eventId +
    '/0/ou/odds/?lang=en';

  const payload = await requestJson(source, endpoint);

  if (
    !payload ||
    typeof payload.odds !== 'string' ||
    !payload.odds.trim()
  ) {
    throw new Error(
      'BetExplorer opening Over/Under HTML is empty.'
    );
  }

  const detailed = parseOverUnderDetailed(payload.odds);

  const detailed15 = detailed.filter(
    row => row.totalLine === 1.5
  );

  const detailed25 = detailed.filter(
    row => row.totalLine === 2.5
  );

  if (
    detailed15.length < MIN_OPENING_BOOKMAKERS ||
    detailed25.length < MIN_OPENING_BOOKMAKERS
  ) {
    throw new Error(
      'Insufficient O/U opening market coverage.'
    );
  }

  const rows = [];
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor++;

      if (index >= detailed.length) {
        return;
      }

      const row = detailed[index];

      try {
        // Parser hücre sırası:
        // cells[0] = Over
        // cells[1] = Under
        const values = await Promise.all(
          row.cells.map(
            cell => fetchArchiveOpening(cell, source)
          )
        );

        if (
          values.length < 2 ||
          values.some(value => !value)
        ) {
          continue;
        }

        const times = values.map(
          value => value.openingAt.getTime()
        );

        rows.push({
          bookmakerId: row.bookmakerId,
          bookmakerName: row.bookmakerName,
          totalLine: row.totalLine,

          overOdd: values[0].odd,
          underOdd: values[1].odd,

          overClosed: false,
          underClosed: false,

          capturedAt: new Date(Math.max(...times)),

          openingAtBySelection: {
            over: values[0].openingAt,
            under: values[1].openingAt
          }
        });
      } catch {
        // Tek bookmaker archive hatası tüm marketi bozmasın.
      }
    }
  };

  const concurrency = Math.min(4, detailed.length);

  await Promise.all(
    Array.from(
      { length: concurrency },
      worker
    )
  );

  const line15 = rows.filter(
    row => row.totalLine === 1.5
  );

  const line25 = rows.filter(
    row => row.totalLine === 2.5
  );

  if (line15.length < MIN_OPENING_BOOKMAKERS) {
    throw new Error(
      'Insufficient O/U 1.5 opening archive coverage: ' +
      line15.length +
      ' < ' +
      MIN_OPENING_BOOKMAKERS
    );
  }

  if (line25.length < MIN_OPENING_BOOKMAKERS) {
    throw new Error(
      'Insufficient O/U 2.5 opening archive coverage: ' +
      line25.length +
      ' < ' +
      MIN_OPENING_BOOKMAKERS
    );
  }

  rows.sort((a, b) => {
    if (a.totalLine !== b.totalLine) {
      return a.totalLine - b.totalLine;
    }

    return a.bookmakerName.localeCompare(
      b.bookmakerName
    );
  });

  return {
    eventId: parsed.eventId,
    url: parsed.url,
    market: 'OVER_UNDER',
    sourceName: source.sourceName + '-archive',
    sourceRegion: source.sourceRegion,
    rows
  };
}

async function pullOpeningOverUnderWithFailover(rawUrl) {
  const attempts = [];

  for (const source of sourceChain()) {
    try {
      const result =
        await fetchOpeningOverUnderSource(
          rawUrl,
          source
        );

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
    .map(
      item =>
        item.sourceName + ': ' + item.error
    )
    .join(' | ');

  throw new Error(
    'No validated opening Over/Under source. ' +
    detail
  );
}

module.exports = {
  parseBetExplorerUrl,
  parseOverUnder,
  parseOverUnderDetailed,
  fetchOverUnderSource,
  pullOverUnderWithFailover,
  fetchOpeningOverUnderSource,
  pullOpeningOverUnderWithFailover,
  sourceChain
};

// MACRADAR_OPENING_INTERNALS_EXPORT
module.exports._openingInternals = {
  requestJson,
  parseBetExplorerUrl,
  fetchArchiveOpening,
  sourceChain
};
