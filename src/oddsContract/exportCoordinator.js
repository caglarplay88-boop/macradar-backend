
'use strict';
const path=require('node:path');
const {ExportJobs}=require('./exportJobs');
const {getContractRuntime}=require('./runtime');

function safeCode(error){
 const value=String(error?.message||'EXPORT_REFRESH_FAILED');
 return /^[A-Z0-9_]{1,100}$/.test(value)?value:'EXPORT_REFRESH_FAILED';
}
function createExportBuilder({pool,runtime,buildPackage,
 readStateInPackage=false,
 refreshWaitMs=15000,
 clock=()=>new Date().toISOString()}){
 if(!pool||!runtime||typeof buildPackage!=='function'){
  throw Error('EXPORT_COORDINATOR_CONFIGURATION_INVALID');
 }
 return async function build(eventId,{onProgress=()=>{}}={}){
  const row=(await pool.query(
   `SELECT m.event_id,m.url,s.tracking_enabled
    FROM matches m LEFT JOIN odds_tracking_settings s
    ON s.event_id=m.event_id WHERE m.event_id=$1`,[eventId]
  )).rows[0];
  if(!row){const error=Error('MATCH_NOT_FOUND');error.status=404;throw error;}
  const requestedAt=clock();
  const oneShot=row.tracking_enabled!==true;
  const job={...row,tracking_enabled:true};
  let result=null;
  let refresh={
   requested_at:requestedAt,reason:'export',current_scan_requested:true,
   history_reconciliation_requested:true,success:false
  };
  onProgress('COLLECTING');
  let refreshPending=false;
  const cleanup=async()=>{
   if(!oneShot)return;
   const latest=(await pool.query(
    'SELECT tracking_enabled FROM odds_tracking_settings WHERE event_id=$1',[eventId]
   )).rows[0];
   if(latest?.tracking_enabled!==true)await runtime.setTracking(job,false);
  };
  const collection=(async()=>{
   let collected=await runtime.collectTrackedMatch(job,{reason:'export',forceHistory:true});
   if(collected&&!collected.skipped&&collected.run?.history_reconciliation_requested===false){
    collected=await runtime.collectTrackedMatch(job,{reason:'export',forceHistory:true});
   }
   return {result:collected};
  })().catch(error=>({error}));
  let timer;
  try{
   const outcome=await Promise.race([collection,new Promise(resolve=>{
    timer=setTimeout(()=>resolve({pending:true}),refreshWaitMs);
   })]);
   if(outcome.pending){
    refreshPending=true;
    refresh={...refresh,finished_at:clock(),success:false,
     outcome:'REFRESH_IN_PROGRESS',error:'EXPORT_REFRESH_WAIT_LIMIT',
     refresh_wait_limit_ms:refreshWaitMs,background_collection_continues:true,
     history_reconciliation_performed:false};
    // Collection keeps its original queue slot; no second collector is created.
    collection.then(cleanup).catch(error=>console.error('[odds-export] cleanup:',safeCode(error)));
   }else{
   if(outcome.error)throw outcome.error;
   result=outcome.result;
   refresh={
    ...refresh,finished_at:clock(),
    success:result?.success===true&&!result?.skipped,
    skipped:result?.skipped===true,
    outcome:result?.reason||
     (result?.success===true?'COLLECTION_SUCCEEDED':'COLLECTION_FAILED'),
    run_id:result?.snapshotId||result?.run?.run_id||null,
    history_reconciliation_performed:
     result?.run?.history_reconciliation_requested===true,
    error:result?.success===true?null:
     (result?.reason||'PARTIAL_OR_FAILED_COLLECTION')
   };
   }
  }catch(error){
   refresh={...refresh,finished_at:clock(),error:safeCode(error),
    outcome:'COLLECTION_FAILED',success:false};
  }finally{
   clearTimeout(timer);
   if(!refreshPending)await cleanup();
  }
  onProgress('BUILDING_PACKAGE');
  return buildPackage(pool,eventId,{
   ...(readStateInPackage?{}:{state:runtime.readState(eventId)}),settings:runtime.settings,
   analysisCutoff:clock(),analysisMode:'strict_as_of',
   exportRefresh:refresh
  });
 };
}
let singleton=null;
let singletonPool=null;
function createProductionExportBuilder(pool){
 const runtime=getContractRuntime();
 const {processPackageBuilder}=require('./exportProcess');
 return createExportBuilder({pool,runtime,readStateInPackage:true,
  buildPackage:processPackageBuilder({directory:runtime.directory})});
}
function getExportJobs(pool){
 if(singleton){
  if(pool!==singletonPool) throw Error('EXPORT_POOL_MISMATCH');
  return singleton;
 }
 const runtime=getContractRuntime();
 singleton=new ExportJobs({
  directory:path.join(runtime.directory,'export-jobs'),
  concurrency:runtime.settings.scheduling.maxConcurrentMatches,
  build:createProductionExportBuilder(pool)
 });
 singletonPool=pool;
 return singleton;
}
module.exports={createExportBuilder,createProductionExportBuilder,getExportJobs};
