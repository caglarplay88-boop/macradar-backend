
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {ContractRuntime}=require('../../src/oddsContract/runtime');
const folder=process.argv[2];
const actual=fs.readFileSync(path.join(folder,'match-page.html'),'utf8');
const future=actual.replace('/EventEnded','/EventScheduled')
 .replace('value="1" id="isFinished"','value="0" id="isFinished"');
const files={ '1x2':'retry-1X2.json',ou:'retry-OU.json',
 ah:'ASIAN-source-response.json',bts:'KG-source-response.json'};
const job={event_id:'0p1XkgIt',
 url:'https://www.betexplorer.com/it/football/france/ligue-2/montpellier-grenoble/0p1XkgIt/'};
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'macradar-runtime-identity-'));
let now='2026-10-08T12:00:00.000Z',pages=0,current=0,fail=false,changed=false;
const meta=()=>({
 observed_at:now,capture_started_at:now,capture_finished_at:now,
 source_context_id:'REPLAY_TEST_CONTEXT',source_context:{transport:'REPLAY_TEST'},
 source:{sourceName:'betexplorer-direct',sourceRegion:null}
});
const transport={
 async fetchTextWithFailover(){
  pages++;
  if(fail){const e=Error('EXPECTED_PAGE_FAILURE');e.attempts=[];throw e;}
  let html=now.startsWith('2026-10-11')?actual:future;
  if(changed) html=html.replace('2026-10-09T20:00:00+02:00',
   '2026-10-09T21:00:00+02:00').replace('data-dt="9,10,2026,19,00"',
   'data-dt="9,10,2026,20,00"');
  return {...meta(),html,attempts:[]};
 },
 async fetchJsonWithFailover(url){
  current++;
  const code=url.match(/\/0\/([^/]+)\//)[1];
  return {...meta(),payload:JSON.parse(fs.readFileSync(
   path.join(folder,files[code]),'utf8'))};
 },
 async fetchJsonFromSource(){return {...meta(),payload:[]};}
};
const runtime=new ContractRuntime({directory,transport,clock:()=>now});
(async()=>{
 try{
  const first=runtime.collectTrackedMatch(job);
  assert.strictEqual(first,runtime.collectTrackedMatch(job));
  const result=await first;
  assert.equal(result.success,true);
  assert.equal(pages,1);assert.equal(current,4);
  let state=runtime.readState(job.event_id);
  assert.equal(state.runs.length,1);
  assert.equal(state.runs[0].run_id,state.identity_checks[0].snapshot_id);
  const raw=Object.values(state.odds_raw);
  assert.equal(raw.length,519);
  assert(raw.every(r=>r.snapshot_id===result.snapshotId));
  assert(raw.every(r=>state.raw_evidence[r.match_identity_evidence_ref]));
  assert(raw.every(r=>r.main_analysis_eligible===false));
  assert.equal(state.match_identity.kickoff_verified,true);
  now='2026-10-08T12:10:00.000Z';changed=true;
  await runtime.collectTrackedMatch(job,{reason:'download',forceHistory:true});
  state=runtime.readState(job.event_id);
  assert.equal(state.kickoff_changes.length,1);
  assert.equal(state.kickoff_changes[0].new_kickoff,'2026-10-09T19:00:00.000Z');
  const records=Object.keys(state.odds_raw).length;
  fail=true;now='2026-10-08T12:20:00.000Z';
  const failed=await runtime.collectTrackedMatch(job);
  assert.equal(failed.success,false);
  const pageCount=pages;
  const waiting=await runtime.collectTrackedMatch(job);
  assert.equal(waiting.reason,'BACKOFF_ACTIVE');
  assert.equal(pages,pageCount);
  assert.equal(Object.keys(runtime.readState(job.event_id).odds_raw).length,records);
  fail=false;now='2026-10-11T12:00:00.000Z';
  const before=current;
  const ended=await runtime.collectTrackedMatch(job);
  assert.equal(ended.reason,'PRE_MATCH_ENDED');
  assert.equal(current,before);
  assert.equal(runtime.readState(job.event_id).tracking.enabled,false);
  console.log('KIMLIK_KONTROLU_VE_DORT_PIYASA_TEK_TUR_KIMLIGI: GECTI');
  console.log('BASLAMA_SAATI_DEGISIMI_SAYFA_HATASI_BACKOFF_VE_PREMATCH_BITISI: GECTI');
  console.log('GELECEK_MAC_SENARYOSU_SENTETIKTIR; CANLI_KAYNAK_TESTI_DEGILDIR');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
