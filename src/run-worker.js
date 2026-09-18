const {
  pool,
  listMatches,
  createWorkerRun,
  updateWorkerRun
} = require('./db');
const { pullAndSave } = require('./puller');
const { closeBrowser } = require('./odds');
const { sleep } = require('./util');

const LOCK_ID = 734221;
const MIN_REFRESH_MINUTES = Number(process.env.MIN_REFRESH_MINUTES || 50);
const BETWEEN_MATCH_MS = Number(process.env.BETWEEN_MATCH_MS || 3500);

function dueForRefresh(match, force) {
  if (force || !match.last_capture) return true;
  const ageMs = Date.now() - new Date(match.last_capture).getTime();
  return ageMs >= MIN_REFRESH_MINUTES * 60 * 1000;
}

async function runWorkerOnce({ force = false } = {}) {
  const lockClient = await pool.connect();
  let locked = false;
  let runId = null;

  try {
    const lock = await lockClient.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [LOCK_ID]
    );
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) {
      return { skipped: true, reason: 'worker_already_running' };
    }

    const matches = await listMatches({ activeOnly: true });
    matches.sort((a, b) => {
      const ta = a.last_capture ? new Date(a.last_capture).getTime() : 0;
      const tb = b.last_capture ? new Date(b.last_capture).getTime() : 0;
      return ta - tb;
    });

    const due = matches.filter(m => dueForRefresh(m, force));
    const skippedCount = matches.length - due.length;

    const run = await createWorkerRun(matches.length);
    runId = run.id;

    let processed = 0;
    let ok = 0;
    let fail = 0;
    const results = [];

    await updateWorkerRun(runId, { skipped_count: skippedCount });

    for (let i = 0; i < due.length; i++) {
      const m = due[i];
      const result = await pullAndSave(m.url, { attempts: 3 });
      processed++;
      if (result.ok) ok++;
      else fail++;

      results.push({
        eventId: m.event_id,
        slug: m.match_slug,
        ...result
      });

      await updateWorkerRun(runId, {
        processed,
        ok_count: ok,
        fail_count: fail,
        skipped_count: skippedCount
      });

      if (i < due.length - 1) {
        await sleep(result.ok ? BETWEEN_MATCH_MS : Math.max(BETWEEN_MATCH_MS, 6000));
      }
    }

    const status = fail === 0 ? 'ok' : (ok > 0 ? 'partial' : 'failed');
    await updateWorkerRun(runId, {
      processed,
      ok_count: ok,
      fail_count: fail,
      skipped_count: skippedCount,
      status,
      finished_at: new Date()
    });

    return {
      skipped: false,
      runId,
      total: matches.length,
      due: due.length,
      skippedFresh: skippedCount,
      processed,
      ok,
      fail,
      results
    };
  } catch (e) {
    if (runId) {
      try {
        await updateWorkerRun(runId, {
          status: 'failed',
          error: e.message || String(e),
          finished_at: new Date()
        });
      } catch {}
    }
    throw e;
  } finally {
    await closeBrowser();
    if (locked) {
      try { await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]); } catch {}
    }
    lockClient.release();
  }
}

module.exports = { runWorkerOnce };
