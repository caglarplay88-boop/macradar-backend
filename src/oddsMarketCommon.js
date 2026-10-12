'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const UA =
  'Mozilla/5.0 (Linux; Android 14) ' +
  'AppleWebKit/537.36 Chrome/131 Safari/537.36';

function decodeMarketHtml(raw) {
  let text = String(raw || '').trim();

  if (!text) return '';

  // Endpoint bazen HTML'i JSON string olarak döndürüyor.
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === 'string') {
        text = parsed;
      }
    } catch {}
  }

  return text
    .replace(/\\"/g, '"')
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

function attr(text, name) {
  const re = new RegExp(
    name + String.raw`\s*=\s*["']([^"']*)["']`,
    'i',
  );

  const m = String(text || '').match(re);
  return m ? m[1] : null;
}

function plainText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bookmakerKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function parseEventId(rawUrl) {
  const value = String(rawUrl || '').trim();

  let m = value.match(
    /\/match-odds\/([A-Za-z0-9]+)\//i,
  );

  if (m) return m[1];

  m = value.match(
    /\/([A-Za-z0-9]{6,20})\/?(?:[?#].*)?$/,
  );

  if (m) return m[1];

  throw new Error(
    'Invalid BetExplorer match URL.',
  );
}

function marketUrl(eventId, marketCode) {
  return (
    'https://www.betexplorer.com/match-odds/' +
    encodeURIComponent(eventId) +
    '/0/' +
    encodeURIComponent(marketCode) +
    '/odds/?lang=en'
  );
}

const SOURCES = [
  {
    name: 'betexplorer-nl',
    region: 'NL',
    socks: '127.0.0.1:9065',
  },
  {
    name: 'betexplorer-ca',
    region: 'CA',
    socks: '127.0.0.1:9066',
  },
  {
    name: 'betexplorer-default-tor',
    region: 'TOR',
    socks: '127.0.0.1:9050',
  },
  {
    name: 'betexplorer-direct',
    region: 'DIRECT',
    socks: null,
  },
];

async function fetchMarketSource(
  eventId,
  marketCode,
  source,
) {
  const url = marketUrl(
    eventId,
    marketCode,
  );

  const args = [
    '-fsSL',
    '--max-time',
    '20',
    '-A',
    UA,
  ];

  if (source.socks) {
    args.push(
      '--socks5-hostname',
      source.socks,
    );
  }

  args.push(url);

  const {
    stdout,
  } = await execFileAsync(
    'curl',
    args,
    {
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    },
  );

  const html = decodeMarketHtml(stdout);

  if (!html || !html.includes('data-odd=')) {
    throw new Error(
      'Market response has no odds.',
    );
  }

  return {
    eventId,
    url,
    html,
    sourceName: source.name,
    sourceRegion: source.region,
    capturedAt: new Date(),
  };
}

async function pullWithFailover({
  rawUrl,
  marketCode,
  parse,
  validate,
}) {
  const eventId = parseEventId(rawUrl);
  const errors = [];

  for (const source of SOURCES) {
    try {
      const fetched =
        await fetchMarketSource(
          eventId,
          marketCode,
          source,
        );

      const rows = parse(
        fetched.html,
        eventId,
      );

      if (
        !Array.isArray(rows) ||
        !rows.length
      ) {
        throw new Error(
          'Parsed market is empty.',
        );
      }

      if (validate) {
        validate(rows);
      }

      return {
        eventId,
        rows,
        capturedAt:
          fetched.capturedAt,
        sourceName:
          fetched.sourceName,
        sourceRegion:
          fetched.sourceRegion,
        url: fetched.url,
      };
    } catch (error) {
      errors.push(
        source.name +
        ': ' +
        error.message,
      );
    }
  }

  throw new Error(
    'No validated market source. ' +
    errors.join(' | '),
  );
}

module.exports = {
  decodeMarketHtml,
  attr,
  plainText,
  bookmakerKey,
  parseEventId,
  marketUrl,
  pullWithFailover,
};
