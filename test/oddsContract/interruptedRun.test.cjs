
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const modulePath=path.resolve(__dirname,'../../src/oddsContract/stateStore.js');
const {StateStore}=require(modulePath);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'interrupted-run-'));
try{
 execFileSync(process.execPath,['-e',`
 const {StateStore}=require(process.argv[1]);
 const store=new StateStore(process.argv[2]);
 store.startTracking('event123',{source:'BetExplorer'});
 store.saveCapture('event123',{
  evidence:{proof:{kind:'TEST_ONLY'}},
  records:[{event_id:'event123',record_id:'saved',raw_evidence_ref:'proof',
   odds_decimal:2}]
 });
 store.beginRun('event123',{
  run_id:'interrupted',started_at:new Date().toISOString(),reason:'test'
 });
 `,modulePath,directory]);
 const recovered=new StateStore(directory);
 const state=recovered.read('event123');
 assert.equal(state.pending_run,undefined);
 assert.equal(state.tracking.enabled,true);
 assert.equal(state.odds_raw.saved.odds_decimal,2);
 assert.equal(state.runs.length,1);
 assert.equal(state.runs[0].success,false);
 assert.equal(state.runs[0].error,'PROCESS_INTERRUPTED_DURING_COLLECTION');
 assert.equal(state.interruptions.length,1);
 assert.equal(new StateStore(directory).read('event123').runs.length,1);
 recovered.beginRun('event123',{
  run_id:'live-run',started_at:new Date().toISOString(),reason:'test'
 });
 assert.equal(new StateStore(directory).read('event123').pending_run.run_id,'live-run');
 recovered.recordRun('event123',{
  run_id:'live-run',started_at:recovered.read('event123').pending_run.started_at,
  finished_at:new Date().toISOString(),success:true
 });
 assert.equal(recovered.read('event123').pending_run,undefined);
 console.log('AYRI_SURECTE_YARIM_TUR_YENIDEN_BASLATMA_VE_HAM_KAYIT_KORUMA: GECTI');
 console.log('CALISAN_SURECI_KESINTI_SAYMAMA_VE_TEK_KURTARMA_KAYDI: GECTI');
}finally{fs.rmSync(directory,{recursive:true,force:true});}
