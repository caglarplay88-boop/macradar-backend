const {getContractRuntime}=require('./oddsContract/runtime');
const { pull1x2WithFailover, pullOpening1x2WithFailover } = require('./odds1x2');
const {
  pullOverUnderWithFailover,
  pullOpeningOverUnderWithFailover
} = require('./oddsOverUnder');

const {
  pullAsianWithFailover,
  pullOpeningAsianWithFailover
} = require('./oddsAsian');

const {
  pullKgWithFailover,
  pullOpeningKgWithFailover
} = require('./oddsKg');

const {
  pool,
  saveOdds1x2Batch,
  saveOddsOverUnderBatch,
  listDueTrackingJobs,
  markTrackingAttempt,
  markTrackingSuccess,
  markTrackingFailure,
  saveOddsAsianBatch,
  saveOddsKgBatch
} = require('./db');




// Versioned reference method; no optimality or calibration claim.


const WORKER_TICK_MS = Math.max(
  15000,
  Number(process.env.ODDS_WORKER_TICK_MS) || 20000
);
const runningEvents = new Set();
let tickRunning = false;
const dispatchedEvents = new Map();
let intervalHandle = null;
let initialHandle = null;

function periodicSequence(seed = Date.now()) {
  const value = Number(seed) * 10 + 2;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Invalid periodic 1X2 capture sequence.');
  }
  return value;
}


async function backfillOverUnderOpening(eventId, url) {
  const existing = await pool.query(
    `SELECT COUNT(*)::int AS count
       FROM odds_over_under_snapshots
      WHERE event_id = $1
        AND capture_type = 'opening'`,
    [eventId]
  );

  const existingCount =
    Number(existing.rows?.[0]?.count || 0);

  if (existingCount > 0) {
    return {
      skipped: true,
      reason: 'opening-already-exists',
      existing: existingCount
    };
  }

  const pulled =
    await pullOpeningOverUnderWithFailover(url);

  if (
    pulled.eventId &&
    pulled.eventId !== eventId
  ) {
    throw new Error(
      'Opening O/U event mismatch: ' +
      pulled.eventId + ' != ' + eventId
    );
  }

  const rows = (pulled.rows || [])
    .filter(row => {
      const line = Number(row.totalLine);
      return line === 1.5 || line === 2.5;
    })
    .map(row => ({
      ...row,
      capturedAt:
        row.capturedAt ||
        pulled.capturedAt
    }));

  const line15 = rows.filter(
    row => Number(row.totalLine) === 1.5
  );

  const line25 = rows.filter(
    row => Number(row.totalLine) === 2.5
  );

  if (!line15.length || !line25.length) {
    throw new Error(
      'Opening O/U incomplete: ' +
      '1.5=' + line15.length +
      ', 2.5=' + line25.length
    );
  }

  // Mevcut sequence formatıyla aynı ölçek:
  // epoch-ms * 10 + küçük suffix.
  const openingSequence =
    Date.now() * 10 + 3;

  const saved =
    await saveOddsOverUnderBatch({
      eventId,
      rows,
      captureType: 'opening',
      sourceName: pulled.sourceName,
      sourceRegion: pulled.sourceRegion,
      captureSequence: openingSequence
    });

  return {
    skipped: false,
    fetched: rows.length,
    inserted: saved.inserted,
    line15: line15.length,
    line25: line25.length,
    captureSequence: openingSequence
  };
}


async function backfillAsianOpening(eventId, url) {
  const existing = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM odds_asian_snapshots
     WHERE event_id=$1
       AND capture_type='opening'`,
    [eventId]
  );

  if (existing.rows[0].count > 0) {
    return {
      skipped: true,
      reason: 'opening-exists',
      existing: existing.rows[0].count
    };
  }

  const pulled =
    await pullOpeningAsianWithFailover(url);

  if (
    pulled.eventId &&
    pulled.eventId !== eventId
  ) {
    throw new Error(
      'Opening Asian event mismatch: ' +
      pulled.eventId + ' != ' + eventId
    );
  }

  const rows =
    pulled.rows || [];

  if (!rows.length) {
    throw new Error(
      'Opening Asian rows empty.'
    );
  }

  const openingSequence =
    Date.now() * 10 + 4;

  const saved =
    await saveOddsAsianBatch({
      eventId,
      rows,
      captureType: 'opening',
      sourceName:
        pulled.sourceName,
      sourceRegion:
        pulled.sourceRegion,
      captureSequence:
        openingSequence
    });

  return {
    skipped: false,
    fetched: rows.length,
    inserted: saved.inserted,
    captureSequence:
      openingSequence
  };
}

async function backfillKgOpening(eventId, url) {
  const existing = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM odds_kg_snapshots
     WHERE event_id=$1
       AND capture_type='opening'`,
    [eventId]
  );

  if (existing.rows[0].count > 0) {
    return {
      skipped: true,
      reason: 'opening-exists',
      existing: existing.rows[0].count
    };
  }

  const pulled =
    await pullOpeningKgWithFailover(url);

  if (
    pulled.eventId &&
    pulled.eventId !== eventId
  ) {
    throw new Error(
      'Opening KG event mismatch: ' +
      pulled.eventId + ' != ' + eventId
    );
  }

  const rows =
    pulled.rows || [];

  if (!rows.length) {
    throw new Error(
      'Opening KG rows empty.'
    );
  }

  const openingSequence =
    Date.now() * 10 + 5;

  const saved =
    await saveOddsKgBatch({
      eventId,
      rows,
      captureType: 'opening',
      sourceName:
        pulled.sourceName,
      sourceRegion:
        pulled.sourceRegion,
      captureSequence:
        openingSequence
    });

  return {
    skipped: false,
    fetched: rows.length,
    inserted: saved.inserted,
    captureSequence:
      openingSequence
  };
}

async function backfill1x2Opening(eventId, url) {
  const existing = await pool.query(
    `SELECT 1 FROM odds_1x2_snapshots
     WHERE event_id=$1 AND capture_type='opening' LIMIT 1`,
    [eventId]
  );
  if (existing.rows.length) return { skipped: true };
  const pulled = await pullOpening1x2WithFailover(url);
  if (String(pulled.eventId) !== String(eventId)) {
    throw new Error('1X2 opening event identity mismatch.');
  }
  if (!Array.isArray(pulled.rows) || !pulled.rows.length) {
    throw new Error('1X2 opening rows missing.');
  }
  return saveOdds1x2Batch({
    eventId,
    rows: pulled.rows.map(row => ({
      ...row,
      capturedAt: row.capturedAt ?? pulled.capturedAt
    })),
    captureType: 'opening',
    sourceName: pulled.sourceName,
    sourceRegion: pulled.sourceRegion,
    captureSequence: Date.now() * 10
  });
}


async function capturePeriodic1x2(job) {
  const eventId=String(job?.event_id||'').trim();
  const url=String(job?.url||'').trim();
  if(!eventId||!url) throw Error('Periodic odds job identity missing.');
  if(runningEvents.has(eventId)){
    return {eventId,skipped:true,reason:'already-running'};
  }
  const runtime=getContractRuntime();
  runningEvents.add(eventId);
  const syncNext=async()=>{
    const state=runtime.readState(eventId);
    const next=state.tracking.retry_not_before||
      state.tracking.next_current_scan_at;
    if(next&&Number.isFinite(Date.parse(next))){
      await pool.query(`
        UPDATE odds_tracking_settings
        SET next_pull_at=$2::timestamptz,updated_at=NOW()
        WHERE event_id=$1 AND tracking_enabled=TRUE
      `,[eventId,next]);
    }
  };
  try{
    const claimed=await markTrackingAttempt(eventId);
    if(!claimed) return {eventId,skipped:true,reason:'not-due-or-disabled'};
    const beforeState=runtime.readState(eventId);
    const rawCountBefore=Array.isArray(beforeState.odds_raw)?
      beforeState.odds_raw.length:Object.keys(beforeState.odds_raw||{}).length;
    const collected=await runtime.collectTrackedMatch({
      ...job,event_id:eventId,url,
      tracking_enabled:claimed.tracking_enabled===true
    },{reason:'periodic'});
    if(collected.reason==='PRE_MATCH_ENDED'){
      await pool.query(`
        UPDATE odds_tracking_settings
        SET tracking_enabled=FALSE,next_pull_at=NULL,updated_at=NOW()
        WHERE event_id=$1
      `,[eventId]);
      return {eventId,skipped:true,reason:'PRE_MATCH_ENDED',
        contractSnapshotId:collected.snapshotId};
    }
    if(collected.skipped){
      await syncNext();
      return {eventId,skipped:true,reason:collected.reason};
    }
    if(!collected.success){
      const error=Error(collected.run?.error||'CONTRACT_COLLECTION_FAILED');
      error.contractSnapshotId=collected.snapshotId;
      throw error;
    }
    const counts=(()=>{
      const state=runtime.readState(eventId);
      const raw=Array.isArray(state.odds_raw)?state.odds_raw:Object.values(state.odds_raw||{});
      const observed=raw.filter(r=>r.snapshot_id===collected.snapshotId&&r.record_origin==='scraper_observation');
      return {total:raw.length,markets:Object.fromEntries(['1X2','OU','ASIAN','KG'].map(m=>[m,observed.filter(r=>r.market===m).length]))};
    })();
    const count=market=>counts.markets[market];
    const captureSequence=periodicSequence();
    await markTrackingSuccess(eventId,captureSequence);
    await syncNext();
    return {
      eventId,skipped:false,
      inserted:Math.max(0,counts.total-rawCountBefore),
      rawRecordCount:counts.total,
      fetched1x2:count('1X2'),fetchedOverUnder:count('OU'),
      fetchedAsian:count('ASIAN'),fetchedKg:count('KG'),
      count_basis:'RAW_SELECTION_RECORDS',
      storage_basis:'SINGLE_CONTRACT_RAW_STORE',
      legacyOddsWrites:0,sourceName:null,sourceRegion:null,
      captureSequence,contractSnapshotId:collected.snapshotId
    };
  }catch(error){
    await markTrackingFailure(eventId,error?.message||String(error)).catch(()=>{});
    await syncNext().catch(()=>{});
    throw error;
  }finally{
    runningEvents.delete(eventId);
  }
}

async function runOddsWorkerTick({waitForJobs=true}={}) {
  if (tickRunning) return {skipped:true,reason:'tick-running',processed:0};
  tickRunning=true;
  let processed=0,failed=0,due=0;
  const started=[];
  try {
    const configured=getContractRuntime().settings?.scheduling?.maxConcurrentMatches;
    const limit=Math.max(1,Math.floor(Number(configured)||4));
    const available=Math.max(0,limit-dispatchedEvents.size);
    if(!available) return {skipped:true,reason:'worker-capacity',processed:0,
      in_flight:dispatchedEvents.size};
    const found=await listDueTrackingJobs(Math.max(4,dispatchedEvents.size+available));
    due=found.length;
    const jobs=found.filter(job=>{
      const id=String(job?.event_id||'').trim();
      return id&&!dispatchedEvents.has(id)&&!runningEvents.has(id);
    }).slice(0,available);
    for(const [index,job] of jobs.entries()){
      const id=String(job.event_id).trim();
      const task=(async()=>{
        try {
          if(index>0) await new Promise(resolve=>setTimeout(resolve,index*750));
          const result=await capturePeriodic1x2(job);
          if(!result.skipped){
            processed++;
            console.log('[odds-worker] event='+result.eventId+
              ' inserted='+result.inserted+' source='+result.sourceName);
          }
        } catch(error){
          failed++;
          console.error('[odds-worker] event='+id+' error='+String(error?.message||error));
        } finally {dispatchedEvents.delete(id);}
      })();
      dispatchedEvents.set(id,task);
      started.push(task);
    }
  } finally {tickRunning=false;}
  if(waitForJobs) await Promise.all(started);
  return {skipped:false,processed,failed,due,admitted:started.length,
    in_flight:dispatchedEvents.size};
}

function startOdds1x2Worker() {
  if (intervalHandle) return intervalHandle;
  

  initialHandle = setTimeout(() => {
    runOddsWorkerTick({waitForJobs:false}).catch(error => {
      console.error('[odds-worker] initial tick error:', error);
    });
  }, 5000);
  initialHandle.unref?.();

  intervalHandle = setInterval(() => {
    runOddsWorkerTick({waitForJobs:false}).catch(error => {
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
  backfillOverUnderOpening,
  periodicSequence,
  capturePeriodic1x2,
  runOddsWorkerTick,
  startOdds1x2Worker,
  stopOdds1x2Worker,
  backfillAsianOpening,
  backfillKgOpening
};
