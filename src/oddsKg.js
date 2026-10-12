'use strict';

const {
  decodeMarketHtml,
  attr,
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

function parseKgDetailed(rawHtml) {
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
        byPosition.set(pos, odd);
      }
    }

    const yesOdd =
      byPosition.get('y') ??
      numberOdd(
        attr(cells[0], 'data-odd'),
      );

    const noOdd =
      byPosition.get('n') ??
      numberOdd(
        attr(cells[1], 'data-odd'),
      );

    if (
      !(yesOdd > 1) ||
      !(noOdd > 1)
    ) {
      continue;
    }

    const key =
      bookmakerKey(bookmakerName);

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
      yesOdd,
      noOdd,
      yesClosed: false,
      noClosed: false,
      market: 'BTTS',
    });
  }

  result.sort(
    (a, b) =>
      a.bookmakerName.localeCompare(
        b.bookmakerName,
      ),
  );

  return result;
}

function parseKg(rawHtml) {
  return parseKgDetailed(rawHtml);
}

function validateKgRows(rows) {
  if (!rows.length) {
    throw new Error(
      'KG/BTTS rows empty.',
    );
  }

  if (
    rows.some(
      row =>
        !(row.yesOdd > 1) ||
        !(row.noOdd > 1)
    )
  ) {
    throw new Error(
      'Invalid KG/BTTS row.',
    );
  }
}

async function pullKgWithFailover(
  rawUrl,
) {
  return pullWithFailover({
    rawUrl,
    marketCode: 'bts',
    parse: parseKgDetailed,
    validate: validateKgRows,
  });
}

module.exports = {
  parseKgDetailed,
  parseKg,
  pullKgWithFailover,
};

// MACRADAR_KG_OPENING
function kgOpeningCell(attrs) {
  return {
    oid: attr(attrs, 'data-oid'),
    bid: attr(attrs, 'data-bid'),
    bt: attr(attrs, 'data-bt'),
    sc: attr(attrs, 'data-sc'),
    hcp: attr(attrs, 'data-hcp'),
    created: attr(attrs, 'data-created')
  };
}

function parseKgOpeningDetailed(rawHtml) {
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

    const cells = [
      ...row.matchAll(
        /<td\b([^>]*)>/gi
      )
    ]
      .map(m => m[1])
      .filter(
        x => attr(x, 'data-odd') != null
      );

    if (cells.length < 2) {
      continue;
    }

    const bookmakerName =
      attr(row, 'data-bookie') ||
      attr(
        cells[0],
        'data-bookie'
      );

    if (!bookmakerName) {
      continue;
    }

    const byPos = new Map();

    for (const cell of cells) {
      const pos = String(
        attr(cell, 'data-pos') || ''
      ).toLowerCase();

      if (pos === 'y' || pos === 'n') {
        byPos.set(pos, cell);
      }
    }

    const yesCell =
      byPos.get('y') ||
      cells[0];

    const noCell =
      byPos.get('n') ||
      cells[1];

    if (!yesCell || !noCell) {
      continue;
    }

    const key =
      bookmakerKey(bookmakerName);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    result.push({
      bookmakerId:
        String(
          attr(
            yesCell,
            'data-bid'
          ) || ''
        ),
      bookmakerKey:
        bookmakerKey(bookmakerName),
      bookmakerName:
        String(bookmakerName).trim(),
      cells: [
        kgOpeningCell(yesCell),
        kgOpeningCell(noCell)
      ]
    });
  }

  return result;
}

async function fetchOpeningKgSource(
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
    '/0/bts/odds/?lang=en';

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
      'KG opening market HTML empty.'
    );
  }

  const detailed =
    parseKgOpeningDetailed(
      payload.odds
    );

  if (!detailed.length) {
    throw new Error(
      'KG opening detailed rows empty.'
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
          yesOdd:
            values[0].odd,
          noOdd:
            values[1].odd,
          yesClosed: false,
          noClosed: false,
          capturedAt:
            new Date(
              Math.max(...times)
            ),
          openingAtBySelection: {
            yes:
              values[0].openingAt,
            no:
              values[1].openingAt
          },
          market: 'BTTS'
        });
      } catch {}
    }
  };

  const concurrency =
    Math.min(
      6,
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
      'KG archive opening rows empty.'
    );
  }

  rows.sort(
    (a, b) =>
      a.bookmakerName.localeCompare(
        b.bookmakerName
      )
  );

  return {
    eventId: parsed.eventId,
    url: parsed.url,
    market: 'BTTS',
    sourceName:
      source.sourceName +
      '-archive',
    sourceRegion:
      source.sourceRegion,
    rows
  };
}

async function pullOpeningKgWithFailover(
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
        await fetchOpeningKgSource(
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
    'No validated KG opening source. ' +
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

module.exports.parseKgOpeningDetailed =
  parseKgOpeningDetailed;

module.exports.fetchOpeningKgSource =
  fetchOpeningKgSource;

module.exports.pullOpeningKgWithFailover =
  pullOpeningKgWithFailover;
