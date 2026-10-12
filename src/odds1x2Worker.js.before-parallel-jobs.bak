const { pull1x2WithFailover } = require('./odds1x2');
const {
  saveOdds1x2Batch,
  listDueTrackingJobs,
  markTrackingAttempt,
  markTrackingSuccess,
  markTrackingFailure
} = require('./db');

const WORKER_TICK_MS = Math.max(
  15000,
  Number(process.env.ODDS_WORKER_TICK_MS) || 20000
);
const runningEvents = new Set();
let tickRunning = false;
let intervalHandle = null;
let initialHandle = null;

function periodicSequence(seed = Date.now()) {
  const value = Number(seed) * 10 + 2;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Invalid periodic 1X2 capture sequence.');
  }
  return value;
}

async function capturePeriodic1x2(job) {
  const eventId = String(job?.event_id || '').trim();
  const url = String(job?.url || '').trim();
  if (!eventId || !url) throw new Error('Periodic 1X2 job identity missing.');
  if (runningEvents.has(eventId)) {
    return { eventId, skipped: true, reason: 'already-running' };
  }

  runningEvents.add(eventId);
  try {
    const claimed = await markTrackingAttempt(eventId);
    if (!claimed) {
      return { eventId, skipped: true, reason: 'disabled-before-start' };
    }

    const pulled = await pull1x2WithFailover(url);
    if (pulled.eventId !== eventId) {
      throw new Error('Periodic 1X2 event mismatch.');
    }

    const rows = pulled.rows.map(row => ({
      ...row,
      capturedAt: pulled.capturedAt
    }));

    const saved = await saveOdds1x2Batch({
      eventId,
      rows,
      captureType: 'periodic',
      sourceName: pulled.sourceName,
      sourceRegion: pulled.sourceRegion,
      captureSequence: periodicSequence()
    });

    await markTrackingSuccess(eventId);
    return {
      eventId,
      skipped: false,
      fetched: rows.length,
      inserted: saved.inserted,
      sourceName: pulled.sourceName,
      sourceRegion: pulled.sourceRegion
    };
  } catch (error) {
    await markTrackingFailure(eventId, error?.message || String(error)).catch(() => {});
    throw error;
  } finally {
    runningEvents.delete(eventId);
  }
}

async function runOddsWorkerTick() {
  if (tickRunning) return { skipped: true, reason: 'tick-running', processed: 0 };
  tickRunning = true;
  let processed = 0;
  let failed = 0;

  try {
    const jobs = await listDueTrackingJobs(4);
    for (const job of jobs) {
      try {
        const result = await capturePeriodic1x2(job);
        if (!result.skipped) {
          processed++;
          console.log(
            '[odds-worker] event=' + result.eventId +
            ' inserted=' + result.inserted +
            ' source=' + result.sourceName
          );
        }
      } catch (error) {
        failed++;
        console.error(
          '[odds-worker] event=' + String(job?.event_id || '') +
          ' error=' + String(error?.message || error)
        );
      }

      if (jobs.length > 1) {
        await new Promise(resolve => setTimeout(resolve, 750));
      }
    }

    return { skipped: false, processed, failed, due: jobs.length };
  } finally {
    tickRunning = false;
  }
}

function startOdds1x2Worker() {
  if (intervalHandle) return intervalHandle;

  initialHandle = setTimeout(() => {
    runOddsWorkerTick().catch(error => {
      console.error('[odds-worker] initial tick error:', error);
    });
  }, 5000);
  initialHandle.unref?.();

  intervalHandle = setInterval(() => {
    runOddsWorkerTick().catch(error => {
      console.error('[odds-worker] tick error:', error);
    });
  }, WORKER_TICK_MS);
  intervalHandle.unref?.();

  console.log('[odds-worker] started tick_ms=' + WORKER_TICK_MS);
  return intervalHandle;
}

function stopOdds1x2Worker() {
  if (initialHandle) clearTimeout(initialHandle);
  if (intervalHandle) clearInterval(intervalHandle);
  initialHandle = null;
  intervalHandle = null;
}

module.exports = {
  periodicSequence,
  capturePeriodic1x2,
  runOddsWorkerTick,
  startOdds1x2Worker,
  stopOdds1x2Worker
};
