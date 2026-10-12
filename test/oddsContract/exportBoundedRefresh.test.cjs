'use strict';
const assert=require('node:assert/strict');
const {createExportBuilder}=require('../../src/oddsContract/exportCoordinator');
(async()=>{
 let finish,disabled=0,calls=0;
 const pending=new Promise(resolve=>{finish=resolve;});
 const state={odds_raw:{retained:{record_id:'retained'}},runs:[],raw_evidence:{}};
 const pool={async query(sql){return {rows:sql.includes('FROM matches')?
  [{event_id:'event123',url:'https://www.betexplorer.com/event123/',tracking_enabled:false}]:
  [{tracking_enabled:false}]};}};
 const runtime={settings:{},collectTrackedMatch(){calls++;return pending;},
  readState(){return state;},async setTracking(){disabled++;}};
 let options;
 const builder=createExportBuilder({pool,runtime,refreshWaitMs:10,
  async buildPackage(p,id,config){options=config;return {buffer:Buffer.from('fixture-package')};}});
 const result=await Promise.race([builder('event123'),new Promise((_,reject)=>{
  const timer=setTimeout(()=>reject(Error('EXPORT_STILL_BLOCKED_BY_HISTORY')),500);timer.unref();
 })]);
 assert.ok(result.buffer);
 assert.equal(calls,1);
 assert.equal(disabled,0,'one-shot collector must not be stopped while collecting');
 assert.equal(options.state,state);
 assert.equal(options.exportRefresh.outcome,'REFRESH_IN_PROGRESS');
 assert.equal(options.exportRefresh.success,false);
 assert.equal(options.exportRefresh.background_collection_continues,true);
 assert.equal(options.exportRefresh.history_reconciliation_performed,false);
 finish({success:true,skipped:false,run:{history_reconciliation_requested:true}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(disabled,1);
 assert.deepEqual(Object.keys(state.odds_raw),['retained']);
 console.log('BOUNDED_EXPORT_PRESERVES_SHARED_COLLECTOR_AND_RAW_STATE: PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});
