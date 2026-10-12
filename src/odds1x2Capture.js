const {
  parseBetExplorerUrl,
  pullOpening1x2WithFailover,
  pull1x2WithFailover
} = require('./odds1x2');
const {
  pullOverUnderWithFailover,
  pullOpeningOverUnderWithFailover
} = require('./oddsOverUnder');
const { pool, saveOdds1x2Batch, saveOddsOverUnderBatch } = require('./db');

function captureSequences(seed = Date.now()) {
  const base = Number(seed) * 10;
  if (!Number.isSafeInteger(base) || base <= 0) {
    throw new Error('Invalid initial 1X2 capture sequence.');
  }
  return {
    opening: base,
    current: base + 1
  };
}

async function pullInitial1x2(rawUrl) {
  const parsed = parseBetExplorerUrl(rawUrl);

  const current = await pull1x2WithFailover(rawUrl);
  if (current.eventId !== parsed.eventId) {
    throw new Error('Current 1X2 event mismatch.');
  }

  let opening = null;
  let openingError = null;
  try {
    opening = await pullOpening1x2WithFailover(rawUrl);
    if (opening.eventId !== parsed.eventId) {
      throw new Error('Opening 1X2 event mismatch.');
    }
  } catch (error) {
    opening = null;
    openingError = String(error?.message || error);
  }

  return {
    eventId: parsed.eventId,
    opening,
    openingError,
    current
  };
}


async function pullInitialOverUnder(rawUrl) {
  const current = await pullOverUnderWithFailover(rawUrl);

  let opening = null;
  let openingError = null;

  try {
    opening = await pullOpeningOverUnderWithFailover(rawUrl);

    if (opening.eventId !== current.eventId) {
      throw new Error('Opening Over/Under event mismatch.');
    }
  } catch (error) {
    opening = null;
    openingError = String(error?.message || error);
  }

  return {
    eventId: current.eventId,
    opening,
    openingError,
    current
  };
}

async function captureInitial1x2(rawUrl, eventId, externalClient = null) {
  const parsed = parseBetExplorerUrl(rawUrl);
  const expectedEventId = String(eventId || '').trim();

  if (!expectedEventId || parsed.eventId !== expectedEventId) {
    throw new Error('Initial 1X2 eventId/url mismatch.');
  }

  const pulled = await pullInitial1x2(rawUrl);

  // Mevcut 1X2 davranışını aynen koru.
  if (!pulled.opening) {
    return {
      eventId: expectedEventId,
      opening: null,
      openingError: pulled.openingError,
      current: {
        fetched: pulled.current.rows.length,
        inserted: 0,
        sourceName: pulled.current.sourceName,
        sourceRegion: pulled.current.sourceRegion,
        capturedAt: pulled.current.capturedAt,
        captureSequence: null
      },
      overUnder: null,
      overUnderError: '1X2 opening unavailable; initial transaction not started.'
    };
  }

  let pulledOverUnder = null;
  let overUnderError = null;

  try {
    pulledOverUnder = await pullInitialOverUnder(rawUrl);

    if (pulledOverUnder.eventId !== expectedEventId) {
      throw new Error('Initial Over/Under event mismatch.');
    }
  } catch (error) {
    pulledOverUnder = null;
    overUnderError = String(error?.message || error);
  }

  const sequences = captureSequences();

  const currentRows = pulled.current.rows.map(row => ({
    ...row,
    capturedAt: pulled.current.capturedAt
  }));

  const currentOverUnderRows = pulledOverUnder
    ? pulledOverUnder.current.rows.map(row => ({
        ...row,
        capturedAt: pulledOverUnder.current.capturedAt
      }))
    : [];

  const ownClient = !externalClient;
  const client = externalClient || await pool.connect();

  try {
    if (ownClient) await client.query('BEGIN');

    const openingSaved = await saveOdds1x2Batch({
      eventId: expectedEventId,
      rows: pulled.opening.rows,
      captureType: 'opening',
      sourceName: pulled.opening.sourceName,
      sourceRegion: pulled.opening.sourceRegion,
      captureSequence: sequences.opening
    }, client);

    const currentSaved = await saveOdds1x2Batch({
      eventId: expectedEventId,
      rows: currentRows,
      captureType: 'current',
      sourceName: pulled.current.sourceName,
      sourceRegion: pulled.current.sourceRegion,
      captureSequence: sequences.current
    }, client);

    let overUnderOpeningSaved = null;
    let overUnderCurrentSaved = null;

    if (pulledOverUnder?.opening) {
      overUnderOpeningSaved = await saveOddsOverUnderBatch({
        eventId: expectedEventId,
        rows: pulledOverUnder.opening.rows,
        captureType: 'opening',
        sourceName: pulledOverUnder.opening.sourceName,
        sourceRegion: pulledOverUnder.opening.sourceRegion,
        captureSequence: sequences.opening
      }, client);
    }

    if (pulledOverUnder) {
      overUnderCurrentSaved = await saveOddsOverUnderBatch({
        eventId: expectedEventId,
        rows: currentOverUnderRows,
        captureType: 'current',
        sourceName: pulledOverUnder.current.sourceName,
        sourceRegion: pulledOverUnder.current.sourceRegion,
        captureSequence: sequences.current
      }, client);
    }

    if (ownClient) {
      await client.query('COMMIT');
      
    }

    return {
      eventId: expectedEventId,

      opening: {
        fetched: pulled.opening.rows.length,
        inserted: openingSaved.inserted,
        sourceName: pulled.opening.sourceName,
        sourceRegion: pulled.opening.sourceRegion,
        captureSequence: sequences.opening
      },

      openingError: pulled.openingError,

      current: {
        fetched: pulled.current.rows.length,
        inserted: currentSaved.inserted,
        sourceName: pulled.current.sourceName,
        sourceRegion: pulled.current.sourceRegion,
        capturedAt: pulled.current.capturedAt,
        captureSequence: sequences.current
      },

      overUnder: pulledOverUnder ? {
        opening: pulledOverUnder.opening ? {
          fetched: pulledOverUnder.opening.rows.length,
          inserted: overUnderOpeningSaved?.inserted || 0,
          sourceName: pulledOverUnder.opening.sourceName,
          sourceRegion: pulledOverUnder.opening.sourceRegion,
          captureSequence: sequences.opening
        } : null,

        openingError: pulledOverUnder.openingError,

        current: {
          fetched: pulledOverUnder.current.rows.length,
          inserted: overUnderCurrentSaved?.inserted || 0,
          sourceName: pulledOverUnder.current.sourceName,
          sourceRegion: pulledOverUnder.current.sourceRegion,
          capturedAt: pulledOverUnder.current.capturedAt,
          captureSequence: sequences.current
        }
      } : null,

      overUnderError
    };
  } catch (error) {
    if (ownClient) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownClient) client.release();
  }
}

module.exports = {
  pullInitialOverUnder,
  captureSequences,
  pullInitial1x2,
  captureInitial1x2
};
