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

function computeNextScheduledAt(
  scheduledAt,
  refreshMinutes,
  now = new Date()
) {
  const scheduledMs = new Date(scheduledAt).getTime();
  const nowMs = new Date(now).getTime();
  const minutes = Number(refreshMinutes);
  const intervalMs = minutes * 60 * 1000;

  if (
    !Number.isFinite(scheduledMs) ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0
  ) {
    throw new Error('Invalid periodic 1X2 schedule.');
  }

  let nextMs = scheduledMs + intervalMs;
  if (nextMs <= nowMs) {
    const missedSlots =
      Math.floor((nowMs - nextMs) / intervalMs) + 1;
    nextMs += missedSlots * intervalMs;
  }

  return new Date(nextMs);
}

function isoTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : null;
}

async function capturePeriodic1x2(job) {
  const eventId = String(job?.event_id || '').trim();
  const url = String(job?.url || '').trim();
  const intervalMinutes = Number(job?.refresh_minutes);
  const scheduledAt = new Date(job?.next_pull_at);
  const startedAt = new Date();

  if (!eventId || !url) {
    throw new Error('Periodic 1X2 job identity missing.');
  }
  if (
    !Number.isFinite(scheduledAt.getTime()) ||
    !Number.isFinite(intervalMinutes) ||
    intervalMinutes <= 0
  ) {
    throw new Error('Periodic 1X2 job schedule invalid.');
  }
  if (runningEvents.has(eventId)) {
    return {
      eventId,
      skipped: true,
      reason: 'already-running'
    };
  }

  runningEvents.add(eventId);
  let requestStartedAt = null;
  let responseReceivedAt = null;
  let savedAt = null;

  try {
    const claimed = await markTrackingAttempt(eventId);
    if (!claimed) {
      return {
        eventId,
        skipped: true,
        reason: 'disabled-before-start'
      };
    }

    requestStartedAt = new Date();
    const pulled = await pull1x2WithFailover(url);
    responseReceivedAt = new Date();

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
    savedAt = new Date();

    const nextRunAt = computeNextScheduledAt(
      scheduledAt,
      intervalMinutes,
      savedAt
    );
    const success = await markTrackingSuccess(
      eventId,
      intervalMinutes,
      nextRunAt
    );

    return {
      eventId,
      skipped: false,
      fetched: rows.length,
      inserted: saved.inserted,
      sourceName: pulled.sourceName,
      sourceRegion: pulled.sourceRegion,
      intervalMinutes,
      scheduleApplied: success?.schedule_applied === true,
      scheduledAt: isoTime(scheduledAt),
      startedAt: isoTime(startedAt),
      requestStartedAt: isoTime(requestStartedAt),
      responseReceivedAt: isoTime(responseReceivedAt),
      savedAt: isoTime(savedAt),
      nextRunAt: isoTime(success?.next_pull_at || nextRunAt)
    };
  } catch (error) {
    await markTrackingFailure(
      eventId,
      error?.message || String(error),
      intervalMinutes
    ).catch(() => {});
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
            ' source=' + result.sourceName +
            ' intervalMinutes=' + result.intervalMinutes +
            ' scheduledAt=' + result.scheduledAt +
            ' startedAt=' + result.startedAt +
            ' requestStartedAt=' + result.requestStartedAt +
            ' responseReceivedAt=' + result.responseReceivedAt +
            ' savedAt=' + result.savedAt +
            ' nextRunAt=' + result.nextRunAt +
            ' scheduleApplied=' + result.scheduleApplied
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
  computeNextScheduledAt,
  capturePeriodic1x2,
  runOddsWorkerTick,
  startOdds1x2Worker,
  stopOdds1x2Worker
};
