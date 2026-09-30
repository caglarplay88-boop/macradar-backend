const { execFile } = require('child_process');
const { promisify } = require('util');
const { parseBetExplorerUrl, sleep } = require('./util');

const execFileAsync = promisify(execFile);
const MIN_BOOKMAKERS = Math.max(1, Math.min(50,
  Number(process.env.ODDS_MIN_HEALTHY_BOOKMAKERS) || 8
));
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';

function bookmakerKey(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, '')
    .replace(/^https?:\/\//, '').replace(/^www\./, '')
    .replace(/\.(de|com|tr|eu|net|org)$/i, '');
}

function decodeHtml(value = '') {
  return String(value).replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#039;|&#39;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}

function parse1x2(html) {
  const seen = new Set();
  const rows = [];
  const trs = [...String(html).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(m => m[1]);

  for (const tr of trs) {
    const values = [...tr.matchAll(/data-odd\s*=\s*["']([^"']+)["']/gi)]
      .map(m => Number(String(m[1]).replace(',', '.')))
      .filter(v => Number.isFinite(v) && v > 1 && v < 1000);
    if (values.length < 3) continue;

    let bookmaker = '';
    let m = tr.match(/data-bookie\s*=\s*["']([^"']+)["']/i);
    if (m) bookmaker = decodeHtml(m[1]);
    if (!bookmaker) {
      m = tr.match(/<a\b[^>]*title\s*=\s*["']([^"']+)["'][^>]*>/i);
      if (m) bookmaker = decodeHtml(m[1]);
    }
    if (!bookmaker) {
      m = tr.match(/class\s*=\s*["'][^"']*table-main__participant[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i);
      if (m) bookmaker = decodeHtml(m[1]);
    }

    const key = bookmakerKey(bookmaker);
    if (!key || seen.has(key)) continue;

    const tags = [...tr.matchAll(/<td\b[^>]*\bdata-odd\s*=\s*["'][^"']+["'][^>]*>/gi)]
      .map(m => m[0]);
    const statuses = tags.map(tag => /\binactive\b/i.test(tag) ? 'suspended' : 'active');
    const [ms1, msx, ms2] = values;

    rows.push({
      bookmaker,
      ms1, ms1_status: statuses[0] || 'unknown',
      msx, msx_status: statuses[1] || 'unknown',
      ms2, ms2_status: statuses[2] || 'unknown'
    });
    seen.add(key);
  }
  return rows;
}

function sourceChain() {
  const nl = String(process.env.TOR_SOCKS_NL || '127.0.0.1:9065').trim();
  const ca = String(process.env.TOR_SOCKS_CA || '127.0.0.1:9066').trim();
  const def = String(process.env.TOR_SOCKS_DEFAULT ||
    process.env.TOR_SOCKS_PRIMARY || process.env.TOR_SOCKS ||
    '127.0.0.1:9050').trim();

  const sources = [
    { name: 'nl-primary', socks: nl, country: 'nl' },
    { name: 'ca-backup', socks: ca, country: 'ca' },
    { name: 'direct-backup', socks: null, country: null }
  ];
  if (def && def !== nl && def !== ca) {
    sources.push({ name: 'default-emergency', socks: def, country: null });
  }
  return sources;
}

async function requestJson(url, source, tag) {
  const args = [
    '--silent', '--show-error', '--location', '--fail', '--compressed',
    '--connect-timeout', '6', '--max-time', '25',
    '--header', 'User-Agent: ' + USER_AGENT,
    '--header', 'Accept-Language: en-US,en;q=0.9',
    '--header', 'Accept: application/json,text/javascript,*/*;q=0.01',
    '--header', 'X-Requested-With: XMLHttpRequest',
    '--header', 'Referer: https://www.betexplorer.com/'
  ];
  if (source.socks) {
    args.push('--socks5-hostname', source.socks, '--proxy-user', tag + ':macradar');
  }
  args.push(url);

  const { stdout } = await execFileAsync('curl', args, {
    maxBuffer: 12 * 1024 * 1024,
    timeout: 30000
  });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('BetExplorer did not return JSON.');
  }
}

async function fetchSource(parsed, source, attempt) {
  const url = 'https://www.betexplorer.com/match-odds/' +
    parsed.eventId + '/0/1x2/odds/?lang=en';
  const tag = 'macradar-v2-' + source.name + '-' +
    parsed.eventId + '-' + Date.now() + '-' + attempt;
  const data = await requestJson(url, source, tag);

  if (!data || typeof data.odds !== 'string' || !data.odds.trim()) {
    throw new Error('BetExplorer 1X2 response is empty.');
  }

  const rows = parse1x2(data.odds);
  if (rows.length < MIN_BOOKMAKERS) {
    throw new Error('Insufficient 1X2 bookmaker coverage: ' +
      rows.length + ' < ' + MIN_BOOKMAKERS);
  }
  return rows;
}

async function pullCurrent1x2(rawUrl) {
  const parsed = parseBetExplorerUrl(rawUrl);
  const errors = [];
  const sources = sourceChain();

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const rows = await fetchSource(parsed, source, attempt);
        return {
          ...parsed,
          capturedAt: new Date(),
          rows,
          meta: {
            source: 'betexplorer-1x2',
            market: '1X2',
            torSource: source.name,
            torCountry: source.country,
            coverage: { ms: rows.length },
            fallbackChecked: sourceIndex > 0,
            degraded: false
          }
        };
      } catch (error) {
        errors.push(source.name + '#' + attempt + ': ' +
          String(error?.message || error));
        if (attempt < 2) await sleep(500);
      }
    }
  }

  throw new Error('No validated 1X2 snapshot. ' + errors.join(' | '));
}

async function closeBrowser() {}

module.exports = { pullCurrent1x2, parse1x2, sourceChain, closeBrowser };

