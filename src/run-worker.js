const {
  pool,
  listMatches,
  createWorkerRun,
  updateWorkerRun,
  getRefreshMinutes,
  archiveStartedMatch
} = require('./db');
const { pullAndSave } = require('./puller');
const { closeBrowser } = require('./odds');
const { sleep } = require('./util');

const LOCK_ID = 734221;
const BETWEEN_MATCH_MS = Number(process.env.BETWEEN_MATCH_MS || 3500);

function dueForRefresh(match, force, refreshMinutes) {
  if (force || !match.last_capture) return true;
  const ageMs = Date.now() - new Date(match.last_capture).getTime();
  return ageMs >= refreshMinutes * 60 * 1000;
}

function kickoffAtMs(match) {
  if (!match?.match_date || !match?.kickoff_time) return null;

  const rawDate = match.match_date;
  const date =
    rawDate instanceof Date && Number.isFinite(rawDate.getTime())
      ? rawDate.toISOString().slice(0, 10)
      : (String(rawDate).match(/\d{4}-\d{2}-\d{2}/)?.[0] || '');

  const m = String(match.kickoff_time).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !m) return null;

  const hh = String(Number(m[1])).padStart(2, '0');
  const mm = String(Number(m[2])).padStart(2, '0');
  const ms = new Date(`${date}T${hh}:${mm}:00+03:00`).getTime();

  return Number.isFinite(ms) ? ms : null;
}

function hasStarted(match, now = Date.now()) {
  const kickoff = kickoffAtMs(match);
  return kickoff !== null && now >= kickoff;
}

async function runWorkerOnce({ force = false, eventIds = null } = {}) {
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
      console.log('[worker] başka tur zaten çalışıyor, bu tetik atlandı');
      return { skipped: true, reason: 'worker_already_running' };
    }

    const refreshMinutes = await getRefreshMinutes();
    let matches = await listMatches({ activeOnly: true });

    // Bu sistem yalnızca PRE-MATCH oranlarını takip eder.
    // Başlama saati gelen maçları otomatik pasife al; live oranları asla kaydetme.
    const startedMatches = matches.filter(m => hasStarted(m));
    for (const m of startedMatches) {
      await archiveStartedMatch(m.event_id);
      console.log(`[worker] maç başladı, takip durduruldu: ${m.match_slug || m.event_id} (${m.match_date || ''} ${m.kickoff_time || ''})`);
    }
    if (startedMatches.length) {
      const startedIds = new Set(startedMatches.map(m => String(m.event_id)));
      matches = matches.filter(m => !startedIds.has(String(m.event_id)));
    }

    if (Array.isArray(eventIds) && eventIds.length) {
      const wanted = new Set(eventIds.map(String));
      matches = matches.filter(m => wanted.has(String(m.event_id)));
    }
    matches.sort((a, b) => {
      const ta = a.last_capture ? new Date(a.last_capture).getTime() : 0;
      const tb = b.last_capture ? new Date(b.last_capture).getTime() : 0;
      return ta - tb;
    });

    const due = matches.filter(m => dueForRefresh(m, force, refreshMinutes));
    const skippedCount = matches.length - due.length;

    console.log(`[worker] aralık=${refreshMinutes}dk aktif=${matches.length} çekilecek=${due.length} taze=${skippedCount}`);

    const run = await createWorkerRun(matches.length);
    runId = run.id;

    let processed = 0;
    let ok = 0;
    let fail = 0;
    const results = [];

    await updateWorkerRun(runId, { skipped_count: skippedCount });

    for (let i = 0; i < due.length; i++) {
      const m = due[i];
      console.log(`[worker] ${i + 1}/${due.length} başlıyor: ${m.match_slug || m.event_id}`);

      const result = await pullAndSave(m.url, { attempts: 3 });

      processed++;
      if (result.ok) ok++;
      else fail++;

      console.log(
        `[worker] ${m.event_id} ${result.ok ? 'OK' : 'HATA'} ` +
        `${result.ok ? (result.rows + ' satır') : result.error}`
      );

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

    console.log(
      `[worker] bitti: processed=${processed} ok=${ok} fail=${fail} skipped=${skippedCount}`
    );

    return {
      skipped: false,
      runId,
      total: matches.length,
      due: due.length,
      skippedFresh: skippedCount,
      refreshMinutes,
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
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
      } catch {}
    }

    lockClient.release();
  }
}

module.exports = { runWorkerOnce };
