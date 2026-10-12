'use strict';

const {
  decodeMarketHtml,
  attr,
  plainText,
  bookmakerKey,
  pullWithFailover,
} = require('./oddsMarketCommon');

function numberOdd(raw) {
  const value = Number(
    String(raw || '')
      .replace(',', '.'),
  );

  if (
    !Number.isFinite(value) ||
    value <= 1
  ) {
    return null;
  }

  return value;
}

function parseHandicapFromHcp(raw) {
  const value = String(raw || '');

  // Gerçek BetExplorer örneği:
  // E-5-2-0--5-0  => -5
  // E-5-2-0--4.5-0 => -4.5
  // E-5-2-0-0.5-0 => 0.5
  const m = value.match(
    /^E-5-\d+-0-(-?\d+(?:\.\d+)?)-0$/i,
  );

  if (!m) return null;

  const line = Number(m[1]);

  return Number.isFinite(line)
    ? line
    : null;
}

function parseHandicapFromText(
  row,
  bookmakerName,
) {
  let text = plainText(row);

  if (bookmakerName) {
    const escaped =
      bookmakerName.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      );

    text = text.replace(
      new RegExp(
        '^' + escaped + '\\s*',
        'i',
      ),
      '',
    );
  }

  const matches = [
    ...text.matchAll(
      /(?:^|\s)([+-]?\d+(?:\.\d+)?)(?=\s|$)/g,
    ),
  ];

  if (!matches.length) {
    return null;
  }

  const line = Number(
    matches[matches.length - 1][1],
  );

  return Number.isFinite(line)
    ? line
    : null;
}

function parseAsianDetailed(rawHtml) {
  const html =
    decodeMarketHtml(rawHtml);

  const rows = html.match(
    /<tr\b[^>]*>[\s\S]*?<\/tr>/gi,
  ) || [];

  const result = [];
  const seen = new Set();

  for (const row of rows) {
    if (!row.includes('data-odd=')) {
      continue;
    }

    const cells = [
      ...row.matchAll(
        /<td\b([^>]*)>/gi,
      ),
    ]
      .map(m => m[1])
      .filter(
        attrs =>
          attr(attrs, 'data-odd') != null,
      );

    if (cells.length < 2) {
      continue;
    }

    const bookmakerName =
      attr(row, 'data-bookie') ||
      attr(cells[0], 'data-bookie');

    if (!bookmakerName) {
      continue;
    }

    const bookmakerId =
      attr(cells[0], 'data-bid') ||
      attr(
        cells[0],
        'data-bookmaker-id',
      ) ||
      '';

    const byPosition = new Map();

    for (const cell of cells) {
      const pos = String(
        attr(cell, 'data-pos') || '',
      ).toLowerCase();

      const odd = numberOdd(
        attr(cell, 'data-odd'),
      );

      if (odd != null) {
        byPosition.set(pos, {
          odd,
          cell,
        });
      }
    }

    const home =
      byPosition.get('1') ||
      (
        cells[0]
          ? {
              odd: numberOdd(
                attr(
                  cells[0],
                  'data-odd',
                ),
              ),
              cell: cells[0],
            }
          : null
      );

    const away =
      byPosition.get('2') ||
      (
        cells[1]
          ? {
              odd: numberOdd(
                attr(
                  cells[1],
                  'data-odd',
                ),
              ),
              cell: cells[1],
            }
          : null
      );

    if (
      !home?.odd ||
      !away?.odd
    ) {
      continue;
    }

    const hcpRaw =
      attr(home.cell, 'data-hcp') ||
      attr(away.cell, 'data-hcp');

    const handicapLine =
      parseHandicapFromHcp(hcpRaw) ??
      parseHandicapFromText(
        row,
        bookmakerName,
      );

    if (
      handicapLine == null ||
      !Number.isFinite(handicapLine)
    ) {
      continue;
    }

    const key =
      bookmakerKey(bookmakerName) +
      '|' +
      handicapLine;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    result.push({
      bookmakerId:
        String(bookmakerId || ''),
      bookmakerKey:
        bookmakerKey(bookmakerName),
      bookmakerName:
        String(bookmakerName).trim(),
      handicapLine,
      homeOdd: home.odd,
      awayOdd: away.odd,
      homeClosed: false,
      awayClosed: false,
      market: 'ASIAN_HANDICAP',
    });
  }

  result.sort((a, b) => {
    if (
      a.handicapLine !==
      b.handicapLine
    ) {
      return (
        a.handicapLine -
        b.handicapLine
      );
    }

    return a.bookmakerName.localeCompare(
      b.bookmakerName,
    );
  });

  return result;
}

function parseAsian(rawHtml) {
  return parseAsianDetailed(rawHtml);
}

function validateAsianRows(rows) {
  if (!rows.length) {
    throw new Error(
      'Asian Handicap rows empty.',
    );
  }

  if (
    rows.some(
      row =>
        !Number.isFinite(
          row.handicapLine,
        ) ||
        !(row.homeOdd > 1) ||
        !(row.awayOdd > 1)
    )
  ) {
    throw new Error(
      'Invalid Asian Handicap row.',
    );
  }
}

async function pullAsianWithFailover(
  rawUrl,
) {
  return pullWithFailover({
    rawUrl,
    marketCode: 'ah',
    parse: parseAsianDetailed,
    validate: validateAsianRows,
  });
}

module.exports = {
  parseHandicapFromHcp,
  parseAsianDetailed,
  parseAsian,
  pullAsianWithFailover,
};

// MACRADAR_ASIAN_OPENING
function asianOpeningCell(attrs) {
  return {
    oid: attr(attrs, 'data-oid'),
    bid: attr(attrs, 'data-bid'),
    bt: attr(attrs, 'data-bt'),
    sc: attr(attrs, 'data-sc'),
    hcp: attr(attrs, 'data-hcp'),
    created: attr(attrs, 'data-created')
  };
}

function parseAsianOpeningDetailed(rawHtml) {
  const html = decodeMarketHtml(rawHtml);

  const rows =
    html.match(
      /<tr\b[^>]*>[\s\S]*?<\/tr>/gi
    ) || [];

  const result = [];
  const seen = new Set();

  for (const row of rows) {
    if (!row.includes('data-odd=')) {
      continue;
    }

    const cellAttrs = [
      ...row.matchAll(
        /<td\b([^>]*)>/gi
      )
    ]
      .map(m => m[1])
      .filter(
        x => attr(x, 'data-odd') != null
      );

    if (cellAttrs.length < 2) {
      continue;
    }

    const bookmakerName =
      attr(row, 'data-bookie') ||
      attr(
        cellAttrs[0],
        'data-bookie'
      );

    if (!bookmakerName) {
      continue;
    }

    const byPos = new Map();

    for (const cell of cellAttrs) {
      const pos = String(
        attr(cell, 'data-pos') || ''
      ).toLowerCase();

      if (pos === '1' || pos === '2') {
        byPos.set(pos, cell);
      }
    }

    const homeCell =
      byPos.get('1') ||
      cellAttrs[0];

    const awayCell =
      byPos.get('2') ||
      cellAttrs[1];

    if (!homeCell || !awayCell) {
      continue;
    }

    const hcp =
      attr(homeCell, 'data-hcp') ||
      attr(awayCell, 'data-hcp');

    const handicapLine =
      parseHandicapFromHcp(hcp) ??
      parseHandicapFromText(
        row,
        bookmakerName
      );

    if (
      handicapLine == null ||
      !Number.isFinite(handicapLine)
    ) {
      continue;
    }

    const key =
      bookmakerKey(bookmakerName) +
      '|' +
      handicapLine;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    result.push({
      bookmakerId:
        String(
          attr(
            homeCell,
            'data-bid'
          ) || ''
        ),
      bookmakerKey:
        bookmakerKey(bookmakerName),
      bookmakerName:
        String(bookmakerName).trim(),
      handicapLine,
      cells: [
        asianOpeningCell(homeCell),
        asianOpeningCell(awayCell)
      ]
    });
  }

  return result;
}

async function fetchOpeningAsianSource(
  rawUrl,
  source
) {
  const {
    requestJson,
    parseBetExplorerUrl,
    fetchArchiveOpening
  } =
    require('./oddsOverUnder')
      ._openingInternals;

  const parsed =
    parseBetExplorerUrl(rawUrl);

  const endpoint =
    'https://www.betexplorer.com/match-odds/' +
    parsed.eventId +
    '/0/ah/odds/?lang=en';

  const payload =
    await requestJson(
      source,
      endpoint
    );

  if (
    !payload ||
    typeof payload.odds !== 'string' ||
    !payload.odds.trim()
  ) {
    throw new Error(
      'Asian opening market HTML empty.'
    );
  }

  const detailed =
    parseAsianOpeningDetailed(
      payload.odds
    );

  if (!detailed.length) {
    throw new Error(
      'Asian opening detailed rows empty.'
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
        const values =
          await Promise.all(
            row.cells.map(
              cell =>
                fetchArchiveOpening(
                  cell,
                  source
                )
            )
          );

        if (
          values.length < 2 ||
          values.some(v => !v)
        ) {
          continue;
        }

        const times = values.map(
          v => v.openingAt.getTime()
        );

        rows.push({
          bookmakerId:
            row.bookmakerId,
          bookmakerKey:
            row.bookmakerKey,
          bookmakerName:
            row.bookmakerName,
          handicapLine:
            row.handicapLine,
          homeOdd:
            values[0].odd,
          awayOdd:
            values[1].odd,
          homeClosed: false,
          awayClosed: false,
          capturedAt:
            new Date(
              Math.max(...times)
            ),
          openingAtBySelection: {
            home:
              values[0].openingAt,
            away:
              values[1].openingAt
          },
          market:
            'ASIAN_HANDICAP'
        });
      } catch {}
    }
  };

  const concurrency =
    Math.min(
      8,
      detailed.length
    );

  await Promise.all(
    Array.from(
      { length: concurrency },
      worker
    )
  );

  if (!rows.length) {
    throw new Error(
      'Asian archive opening rows empty.'
    );
  }

  rows.sort((a, b) => {
    if (
      a.handicapLine !==
      b.handicapLine
    ) {
      return (
        a.handicapLine -
        b.handicapLine
      );
    }

    return a.bookmakerName.localeCompare(
      b.bookmakerName
    );
  });

  return {
    eventId: parsed.eventId,
    url: parsed.url,
    market: 'ASIAN_HANDICAP',
    sourceName:
      source.sourceName +
      '-archive',
    sourceRegion:
      source.sourceRegion,
    rows
  };
}

async function pullOpeningAsianWithFailover(
  rawUrl
) {
  const {
    sourceChain
  } =
    require('./oddsOverUnder')
      ._openingInternals;

  const attempts = [];

  for (const source of sourceChain()) {
    try {
      const result =
        await fetchOpeningAsianSource(
          rawUrl,
          source
        );

      return {
        ...result,
        attempts,
        fallbackUsed:
          attempts.length > 0
      };
    } catch (error) {
      attempts.push({
        sourceName:
          source.sourceName,
        sourceRegion:
          source.sourceRegion,
        error:
          String(
            error?.message ||
            error
          )
      });
    }
  }

  throw new Error(
    'No validated Asian opening source. ' +
    attempts
      .map(
        x =>
          x.sourceName +
          ': ' +
          x.error
      )
      .join(' | ')
  );
}

module.exports.parseAsianOpeningDetailed =
  parseAsianOpeningDetailed;

module.exports.fetchOpeningAsianSource =
  fetchOpeningAsianSource;

module.exports.pullOpeningAsianWithFailover =
  pullOpeningAsianWithFailover;
