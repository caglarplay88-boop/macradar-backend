'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ContractRuntime}=require('../../src/oddsContract/runtime');
const {installProcessCollector}=require('../../src/oddsContract/collectorProcess');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'collector-process-test-'));
const runtime=installProcessCollector(new ContractRuntime({directory:folder}));
const job={event_id:'ABCDEFGH',url:'https://www.betexplorer.com/football/italy/serie-a/home-away/ABCDEFGH/'};
(async()=>{
 const result=await runtime.setTracking(job,true);
 assert.notEqual(result.process_id,process.pid,'Collection must run outside the HTTP event loop');
 assert.equal(runtime.readState(job.event_id).tracking.enabled,true);
 await runtime.setTracking(job,false);
 assert.equal(runtime.readState(job.event_id).tracking.enabled,false);
 await assert.rejects(runtime.collectTrackedMatch({...job,url:'https://www.betexplorer.com/football/italy/serie-a/home-away/XXXXXXXX/'}),/CONTRACT_MATCH_URL_ID_MISMATCH/);
 runtime.collector.store.transaction(job.event_id,state=>{
  state.match_identity={identity_verified:true,kickoff_verified:true,kickoff:'2000-01-01T00:00:00.000Z'};
  return true;
 });
 const ended=await runtime.collectTrackedMatch(job,{reason:'export',forceHistory:true});
 assert.equal(ended.reason,'PRE_MATCH_ENDED');
 assert.equal(runtime.readState(job.event_id).tracking.enabled,false);
 assert.equal(runtime.readState(job.event_id).pending_run,undefined,'Past verified kickoff must not queue a source fetch');
 console.log('SEPARATE_COLLECTOR_PROCESS_REAL_SHARED_STORE_AND_RPC_ERRORS: PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{runtime.closeProcessCollector();setTimeout(()=>fs.rmSync(folder,{recursive:true,force:true}),300);});
