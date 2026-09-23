const { execFile } = require('child_process');
const { promisify } = require('util');
const { parseBetExplorerUrl, sleep } = require('./util');

const execFileAsync = promisify(execFile);

const TOR_SOCKS_PRIMARY =
  process.env.TOR_SOCKS_PRIMARY ||
  process.env.TOR_SOCKS ||
  '127.0.0.1:9050';

const TOR_SOCKS_FALLBACK =
  process.env.TOR_SOCKS_FALLBACK || '';

const TOR_COUNTRY_PRIMARY =
  String(process.env.TOR_COUNTRY_PRIMARY || '')
    .trim()
    .toLowerCase();

const TOR_COUNTRY_FALLBACK =
  String(process.env.TOR_COUNTRY_FALLBACK || '')
    .trim()
    .toLowerCase();

const ODDS_MIN_HEALTHY_BOOKMAKERS = Math.max(
  1,
  Math.min(
    50,
    Number(process.env.ODDS_MIN_HEALTHY_BOOKMAKERS) || 8
  )
);

const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36';

function bookmakerKey(name) {
  return String(name || '')
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
    .replace(/&#(\d+);/g, (_, n) =>
      String.fromCharCode(Number(n))
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueInPageOrder(rows) {
  const seen = new Set();
  const out = [];

  for (const row of rows) {
    const key = bookmakerKey(row.bookmaker);

    if (!key || seen.has(key)) continue;

    seen.add(key);
    out.push(row);
  }

  return out;
}

function findBookmaker(rows, bookmaker) {
  const wanted = bookmakerKey(bookmaker);

  if (!wanted) return null;

  return (
    rows.find(
      row => bookmakerKey(row.bookmaker) === wanted
    ) || null
  );
}

async function curlText(url, circuitTag, timeoutSeconds = 25, socksAddress = TOR_SOCKS_PRIMARY) {
  try {
    const { stdout } = await execFileAsync(
      'curl',
      [
        '--silent',
        '--show-error',
        '--location',
        '--fail',
        '--compressed',

        '--socks5-hostname',
        socksAddress,

        '--proxy-user',
        circuitTag + ':macradar',

        '--connect-timeout',
        '10',

        '--max-time',
        String(timeoutSeconds),

        '--header',
        'User-Agent: ' + USER_AGENT,

        '--header',
        'Accept-Language: en-US,en;q=0.9',

        '--header',
        'Accept: application/json,text/javascript,*/*;q=0.01',

        '--header',
        'X-Requested-With: XMLHttpRequest',

        '--header',
        'Referer: https://www.betexplorer.com/',

        url
      ],
      {
        maxBuffer: 12 * 1024 * 1024,
        timeout: (timeoutSeconds + 5) * 1000
      }
    );

    return stdout;
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const message = String(error?.message || error);

    throw new Error(
      stderr
        ? `curl: ${stderr}`
        : `curl: ${message}`
    );
  }
}

async function fetchMarket(eventId, type, circuitTag, socksAddress = TOR_SOCKS_PRIMARY) {
  const url =
    `https://www.betexplorer.com/match-odds/` +
    `${eventId}/0/${type}/odds/?lang=en`;

  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = await curlText(
        url,
        circuitTag,
        25,
        socksAddress
      );

      let data;

      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(
          `${type}: BetExplorer JSON döndürmedi`
        );
      }

      if (!data || typeof data.odds !== 'string') {
        throw new Error(
          `${type}: odds verisi boş`
        );
      }

      if (!data.odds.trim()) {
        throw new Error(
          `${type}: odds HTML boş`
        );
      }

      return data.odds;
    } catch (error) {
      lastError = error;

      if (attempt < 2) {
        await sleep(700);
      }
    }
  }

  throw lastError ||
    new Error(`${type}: market alınamadı`);
}

function extractRows(html) {
  return [
    ...String(html).matchAll(
      /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
    )
  ].map(match => match[1]);
}

function extractOdds(rowHtml) {
  const values = [];

  const re =
    /data-odd\s*=\s*["']([^"']+)["']/gi;

  let match;

  while ((match = re.exec(rowHtml))) {
    const value = Number(
      String(match[1]).replace(',', '.')
    );

    if (
      Number.isFinite(value) &&
      value > 1
    ) {
      values.push(value);
    }
  }

  return values;
}

function extractOddStatuses(rowHtml) {
  const out = [];
  const re = /<td\b[^>]*\bdata-odd\s*=\s*["'][^"']+["'][^>]*>/gi;
  let match;
  while ((match = re.exec(rowHtml))) {
    const tag = match[0];
    const cm = tag.match(/\bclass\s*=\s*["']([^"']*)["']/i);
    const classes = cm ? cm[1] : "";
    out.push(/\binactive\b/i.test(classes) ? "suspended" : "active");
  }
  return out;
}

function extractBookmaker(rowHtml) {
  let match = rowHtml.match(
    /data-bookie\s*=\s*["']([^"']+)["']/i
  );

  if (match) {
    const value = decodeHtml(match[1]);
    if (value) return value;
  }

  match = rowHtml.match(
    /<a\b[^>]*title\s*=\s*["']([^"']+)["'][^>]*>/i
  );

  if (match) {
    const value = decodeHtml(match[1]);

    if (value) return value;
  }

  match = rowHtml.match(
    /class\s*=\s*["'][^"']*table-main__participant[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i
  );

  if (match) {
    const value = decodeHtml(match[1]);

    if (value) return value;
  }

  match = rowHtml.match(
    /<td\b[^>]*>([\s\S]*?)<\/td>/i
  );

  if (match) {
    const value = decodeHtml(match[1]);

    if (value) return value;
  }

  return 'Bookmaker';
}

function extractTotal(rowHtml) {
  const match = rowHtml.match(
    /class\s*=\s*["'][^"']*table-main__doubleparameter[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i
  );

  if (!match) return '';

  return decodeHtml(match[1])
    .replace(',', '.')
    .trim();
}

function parseMarketHtml(html, mode) {
  const rows = [];

  for (const tr of extractRows(html)) {
    const values = extractOdds(tr);
    const statuses = extractOddStatuses(tr);

    if (!values.length) continue;

    const bookmaker = extractBookmaker(tr);

    if (mode === '1x2') {
      if (values.length >= 3) {
        rows.push({
          bookmaker,
          values: values.slice(0, 3),
          statuses: statuses.slice(0, 3)
        });
      }

      continue;
    }

    if (mode === 'bts') {
      if (values.length >= 2) {
        rows.push({
          bookmaker,
          values: values.slice(0, 2),
          statuses: statuses.slice(0, 2)
        });
      }

      continue;
    }

    if (mode === 'ou') {
      const total = extractTotal(tr);

      if (
        (total === '1.5' || total === '2.5') &&
        values.length >= 2
      ) {
        rows.push({
          bookmaker,
          total,
          values: values.slice(0, 2),
          statuses: statuses.slice(0, 2)
        });
      }
    }
  }

  return rows;
}

async function pullOdds(rawUrl) {
  const parsed = parseBetExplorerUrl(rawUrl);
  let lastError = null;

  const sources = [
    {
      name: 'primary',
      socks: TOR_SOCKS_PRIMARY,
      country: TOR_COUNTRY_PRIMARY || null
    }
  ];

  if (
    TOR_SOCKS_FALLBACK &&
    TOR_SOCKS_FALLBACK !== TOR_SOCKS_PRIMARY
  ) {
    sources.push({
      name: 'fallback',
      socks: TOR_SOCKS_FALLBACK,
      country: TOR_COUNTRY_FALLBACK || null
    });
  }

  function marketCoverage(oneXtwo, ou15Rows, ou25Rows, btsRows) {
    return {
      ms: uniqueInPageOrder(oneXtwo).length,
      ou15: uniqueInPageOrder(ou15Rows).length,
      ou25: uniqueInPageOrder(ou25Rows).length,
      btts: uniqueInPageOrder(btsRows).length
    };
  }

  function suspiciousCoverage(c) {
    if (c.ms <= 0) return true;

    const reference = Math.max(
      c.ms,
      c.ou15,
      c.ou25,
      c.btts
    );

    // Tüm marketler birlikte çökerse oranları birbirine
    // dengeli görünse bile snapshot sağlıklı sayılmaz.
    if (reference < ODDS_MIN_HEALTHY_BOOKMAKERS) {
      return true;
    }

    const floor = Math.max(
      2,
      Math.floor(reference * 0.45)
    );

    return (
      c.ms < floor ||
      c.ou15 < floor ||
      c.ou25 < floor ||
      c.btts < floor
    );
  }

  async function pullFromSource(source, circuit) {
    const circuitTag =
      'macradar-' +
      source.name +
      '-' +
      parsed.eventId +
      '-' +
      Date.now() +
      '-' +
      circuit;

    const [h1x2, hou, hbts] = await Promise.all([
      fetchMarket(parsed.eventId, '1x2', circuitTag, source.socks),
      fetchMarket(parsed.eventId, 'ou', circuitTag, source.socks),
      fetchMarket(parsed.eventId, 'bts', circuitTag, source.socks)
    ]);

    const oneXtwo = parseMarketHtml(h1x2, '1x2');
    const ou = parseMarketHtml(hou, 'ou');
    const bts = parseMarketHtml(hbts, 'bts');

    const uniqueMs = uniqueInPageOrder(oneXtwo);

    const ou15Rows = uniqueInPageOrder(
      ou.filter(row => row.total === '1.5')
    );

    const ou25Rows = uniqueInPageOrder(
      ou.filter(row => row.total === '2.5')
    );

    const btsRows = uniqueInPageOrder(bts);

    const coverage = marketCoverage(
      uniqueMs,
      ou15Rows,
      ou25Rows,
      btsRows
    );

    // Bookmaker birleşimi:
    // MS + O/U 1.5 + O/U 2.5 + KG.
    const allMarketRows = [
      ...uniqueMs,
      ...ou15Rows,
      ...ou25Rows,
      ...btsRows
    ];

    const candidateMap = new Map();

    for (const row of allMarketRows) {
      const key = bookmakerKey(row.bookmaker);
      if (!key || candidateMap.has(key)) continue;

      candidateMap.set(key, {
        bookmaker: row.bookmaker
      });
    }

    // Sadece sıralama kolaylığı için üç bilinen isim öne alınır;
    // veri filtresi değildir.
    const priorityNames = ['1xBet', '888sport', 'bet365'];
    const orderedNames = [];

    for (const wanted of priorityNames) {
      const key = bookmakerKey(wanted);
      if (candidateMap.has(key)) {
        orderedNames.push(key);
      }
    }

    for (const key of candidateMap.keys()) {
      if (!orderedNames.includes(key)) {
        orderedNames.push(key);
      }
    }

    const rows = [];

    for (const key of orderedNames) {
      const base = candidateMap.get(key);
      const bookmaker = base.bookmaker;

      const ms = findBookmaker(uniqueMs, bookmaker);
      const a15 = findBookmaker(ou15Rows, bookmaker);
      const a25 = findBookmaker(ou25Rows, bookmaker);
      const kg = findBookmaker(btsRows, bookmaker);

      const row = {
        bookmaker
      };

      if (ms) Object.assign(row, {
  ms1: ms.values[0],
  ms1_status: ms.statuses?.[0] || "unknown",
  msx: ms.values[1],
  msx_status: ms.statuses?.[1] || "unknown",
  ms2: ms.values[2],
  ms2_status: ms.statuses?.[2] || "unknown"
});

      if (a15) Object.assign(row, {
  ou15_over: a15.values[0],
  ou15_over_status: a15.statuses?.[0] || "unknown",
  ou15_under: a15.values[1],
  ou15_under_status: a15.statuses?.[1] || "unknown"
});

      if (a25) Object.assign(row, {
  ou25_over: a25.values[0],
  ou25_over_status: a25.statuses?.[0] || "unknown",
  ou25_under: a25.values[1],
  ou25_under_status: a25.statuses?.[1] || "unknown"
});

      if (kg) Object.assign(row, {
  btts_yes: kg.values[0],
  btts_yes_status: kg.statuses?.[0] || "unknown",
  btts_no: kg.values[1],
  btts_no_status: kg.statuses?.[1] || "unknown"
});

      const available = [
        row.ms1, row.msx, row.ms2,
        row.ou15_over, row.ou15_under,
        row.ou25_over, row.ou25_under,
        row.btts_yes, row.btts_no
      ];

      if (available.some(x => Number.isFinite(Number(x)))) {
        rows.push(row);
      }
    }

    if (!rows.length) {
      throw new Error('Geçerli bookmaker oranı bulunamadı.');
    }

    return {
      rows,
      coverage,
      source
    };
  }

  function qualityOf(result) {
    const c = result.coverage;

    const values = [
      Number(c.ms) || 0,
      Number(c.ou15) || 0,
      Number(c.ou25) || 0,
      Number(c.btts) || 0
    ];

    const min = Math.min(...values);
    const max = Math.max(...values);
    const sum = values.reduce((a, b) => a + b, 0);

    return {
      healthy: !suspiciousCoverage(c),
      min,
      sum,
      spread: max - min,
      rows: result.rows.length
    };
  }

  function betterCandidate(current, incoming) {
    if (!current) return incoming;

    const a = qualityOf(incoming.result);
    const b = qualityOf(current.result);

    if (a.healthy !== b.healthy) {
      return a.healthy ? incoming : current;
    }

    if (a.min !== b.min) {
      return a.min > b.min ? incoming : current;
    }

    if (a.sum !== b.sum) {
      return a.sum > b.sum ? incoming : current;
    }

    if (a.spread !== b.spread) {
      return a.spread < b.spread ? incoming : current;
    }

    if (a.rows !== b.rows) {
      return a.rows > b.rows ? incoming : current;
    }

    if (
      incoming.result.source.name === 'primary' &&
      current.result.source.name !== 'primary'
    ) {
      return incoming;
    }

    return current;
  }

  function buildResult(candidate, degraded = false) {
    const meta = {
      source: 'betexplorer-direct-tor',
      browser: false,
      torCircuit: candidate.circuit,
      torSource: candidate.result.source.name,
      torCountry: candidate.result.source.country || null,
      coverage: candidate.result.coverage
    };

    if (candidate.fallbackChecked) {
      meta.fallbackChecked = true;
    }

    if (degraded) {
      meta.degraded = true;
    }

    return {
      ...parsed,
      meta,
      rows: candidate.result.rows,
      capturedAt: new Date()
    };
  }

  let bestDegraded = null;

  for (let circuit = 1; circuit <= 8; circuit++) {
    let primaryResult = null;
    let fallbackResult = null;

    try {
      primaryResult = await pullFromSource(
        sources[0],
        circuit
      );

      if (!suspiciousCoverage(primaryResult.coverage)) {
        console.log(
          '[odds] ' +
          parsed.eventId +
          ' source=' +
          primaryResult.source.name +
          ' tor=' +
          circuit +
          ' coverage=' +
          JSON.stringify(primaryResult.coverage) +
          ' bookmakers=' +
          primaryResult.rows.length
        );

        return buildResult({
          result: primaryResult,
          circuit,
          fallbackChecked: false
        });
      }

      console.log(
        '[odds] ' +
        parsed.eventId +
        ' primary coverage şüpheli: ' +
        JSON.stringify(primaryResult.coverage)
      );
    } catch (error) {
      lastError = error;

      console.log(
        '[odds] ' +
        parsed.eventId +
        ' primary tor=' +
        circuit +
        ' başarısız: ' +
        String(error?.message || error)
      );
    }

    if (sources.length > 1) {
      try {
        fallbackResult = await pullFromSource(
          sources[1],
          circuit
        );

        if (!suspiciousCoverage(fallbackResult.coverage)) {
          console.log(
            '[odds] ' +
            parsed.eventId +
            ' source=' +
            fallbackResult.source.name +
            ' tor=' +
            circuit +
            ' coverage=' +
            JSON.stringify(fallbackResult.coverage) +
            ' bookmakers=' +
            fallbackResult.rows.length
          );

          return buildResult({
            result: fallbackResult,
            circuit,
            fallbackChecked: true
          });
        }

        console.log(
          '[odds] ' +
          parsed.eventId +
          ' fallback coverage şüpheli: ' +
          JSON.stringify(fallbackResult.coverage)
        );
      } catch (error) {
        lastError = error;

        console.log(
          '[odds] ' +
          parsed.eventId +
          ' fallback tor=' +
          circuit +
          ' başarısız: ' +
          String(error?.message || error)
        );
      }
    }

    const degradedOptions = [
      primaryResult,
      fallbackResult
    ].filter(Boolean);

    for (const result of degradedOptions) {
      bestDegraded = betterCandidate(
        bestDegraded,
        {
          result,
          circuit,
          fallbackChecked: sources.length > 1
        }
      );
    }

    if (circuit < 8) {
      await sleep(500);
    }
  }

  if (bestDegraded) {
    console.log(
      '[odds] ' +
      parsed.eventId +
      ' DEGRADED source=' +
      bestDegraded.result.source.name +
      ' tor=' +
      bestDegraded.circuit +
      ' coverage=' +
      JSON.stringify(bestDegraded.result.coverage) +
      ' bookmakers=' +
      bestDegraded.result.rows.length
    );

    return buildResult(bestDegraded, true);
  }

  throw lastError ||
    new Error('8 Tor devresinde uygun oran seti alınamadı.');
}

async function closeBrowser() {
  // Browser kullanılmıyor.
}

module.exports = {
  pullOdds,
  closeBrowser
};
