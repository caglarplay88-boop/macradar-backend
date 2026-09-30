const {
  parseBetExplorerUrl,
  pullOpening1x2WithFailover,
  pull1x2WithFailover
} = require('./odds1x2');
const { pool, saveOdds1x2Batch } = require('./db');

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

  const opening = await pullOpening1x2WithFailover(rawUrl);
  if (opening.eventId !== parsed.eventId) {
    throw new Error('Opening 1X2 event mismatch.');
  }

  const current = await pull1x2WithFailover(rawUrl);
  if (current.eventId !== parsed.eventId) {
    throw new Error('Current 1X2 event mismatch.');
  }

  return {
    eventId: parsed.eventId,
    opening,
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
  const sequences = captureSequences();
  const currentRows = pulled.current.rows.map(row => ({
    ...row,
    capturedAt: pulled.current.capturedAt
  }));

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

    if (ownClient) await client.query('COMMIT');

    return {
      eventId: expectedEventId,
      opening: {
        fetched: pulled.opening.rows.length,
        inserted: openingSaved.inserted,
        sourceName: pulled.opening.sourceName,
        sourceRegion: pulled.opening.sourceRegion,
        captureSequence: sequences.opening
      },
      current: {
        fetched: pulled.current.rows.length,
        inserted: currentSaved.inserted,
        sourceName: pulled.current.sourceName,
        sourceRegion: pulled.current.sourceRegion,
        capturedAt: pulled.current.capturedAt,
        captureSequence: sequences.current
      }
    };
  } catch (error) {
    if (ownClient) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownClient) client.release();
  }
}

module.exports = {
  captureSequences,
  pullInitial1x2,
  captureInitial1x2
};
