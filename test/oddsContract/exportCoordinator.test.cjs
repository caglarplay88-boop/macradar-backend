
'use strict';
const assert=require('node:assert/strict');
const {createExportBuilder}=require('../../src/oddsContract/exportCoordinator');

async function scenario({tracked=true,results=[],fail=false,
 startedDuringExport=false}={}){
 let calls=0,disabled=0,options=null;
 const phases=[];
 const state={runs:[],odds_raw:{},raw_evidence:{}};
 const pool={async query(sql){
  if(sql.includes('FROM matches')) return {rows:[{
   event_id:'event123',url:'https://www.betexplorer.com/event123/',
   tracking_enabled:tracked
  }]};
  return {rows:[{tracking_enabled:startedDuringExport||tracked}]};
 }};
 const runtime={
  settings:{scheduling:{maxConcurrentMatches:2}},
  async collectTrackedMatch(job,config){
   assert.equal(job.tracking_enabled,true);
   assert.equal(config.forceHistory,true);
   assert.equal(config.reason,'export');
   const index=calls++;
   if(fail) throw Error('TEST_HTTP_502');
   return results[index]||{
    success:true,skipped:false,snapshotId:'final-run',
    run:{history_reconciliation_requested:true}
   };
  },
  setTracking(job,enabled){
   assert.equal(enabled,false);disabled++;
  },
  readState(){return state;}
 };
 const build=createExportBuilder({
  pool,runtime,clock:()=> '2026-10-11T14:00:00.000Z',
  async buildPackage(p,id,config){
   assert.equal(p,pool);assert.equal(id,'event123');
   assert.equal(config.state,state);options=config;
   return {buffer:Buffer.from('test-package'),filename:'test.zip'};
  }
 });
 await build('event123',{onProgress:p=>phases.push(p)});
 assert.deepEqual(phases,['COLLECTING','BUILDING_PACKAGE']);
 assert.equal(options.analysisMode,'strict_as_of');
 return {calls,disabled,options};
}
(async()=>{
 const success=await scenario();
 assert.equal(success.calls,1);
 assert.equal(success.options.exportRefresh.success,true);
 const failed=await scenario({fail:true});
 assert.equal(failed.options.exportRefresh.success,false);
 assert.equal(failed.options.exportRefresh.error,'TEST_HTTP_502');
 const shared=await scenario({results:[{
  success:true,skipped:false,
  run:{history_reconciliation_requested:false}
 }]});
 assert.equal(shared.calls,2);
 assert.equal(shared.options.exportRefresh.history_reconciliation_performed,true);
 const backoff=await scenario({results:[{
  skipped:true,reason:'BACKOFF_ACTIVE'
 }]});
 assert.equal(backoff.calls,1);
 assert.equal(backoff.options.exportRefresh.success,false);
 assert.equal(backoff.options.exportRefresh.outcome,'BACKOFF_ACTIVE');
 const oneShot=await scenario({tracked:false});
 assert.equal(oneShot.disabled,1);
 const newlyTracked=await scenario({tracked:false,startedDuringExport:true});
 assert.equal(newlyTracked.disabled,0);
 const ended=await scenario({results:[{
  skipped:true,reason:'PRE_MATCH_ENDED'
 }]});
 assert.equal(ended.options.exportRefresh.success,false);
 console.log('SON_TARAMA_GECMIS_UZLASTIRMASI_HATA_VE_BACKOFF: GECTI');
 console.log('TEK_SEFERLIK_INDIRME_KALICI_TAKIBI_ACIK_BIRAKMADI: GECTI');
})().catch(error=>{console.error(error);process.exitCode=1;});
