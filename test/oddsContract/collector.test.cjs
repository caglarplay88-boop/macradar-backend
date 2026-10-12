
'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const os=require('os');
const {OddsCollector}=require('../../src/oddsContract/collector');
(async()=>{
 const fixture=process.argv[2];
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'macradar-collector-'));
 try{
  const files={
   '1x2':'retry-1X2.json',ou:'retry-OU.json',
   ah:'ASIAN-source-response.json',bts:'KG-source-response.json'
  };
  let active=0,peak=0,archiveCalls=0,fail=false;
  let now='2026-10-11T12:00:00.000Z';
  const meta=()=>({
   capture_started_at:now,capture_finished_at:now,observed_at:now,
   source_context_id:'REPLAY_TEST_CONTEXT',
   source_context:{transport:'REPLAY_TEST',language:'en'},
   source:{sourceName:'betexplorer-direct',sourceRegion:null,socksAddress:null}
  });
  const transport={
   async fetchJsonWithFailover(url){
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,2));
    active--;
    if(fail) throw Error('TEST_HTTP_502');
    const code=url.match(/\/0\/([^/]+)\//)[1];
    return {...meta(),payload:JSON.parse(fs.readFileSync(
     path.join(fixture,files[code]),'utf8'))};
   },
   async fetchJsonFromSource(source,url){
    assert(url.startsWith('https://www.betexplorer.com/archive-odds/'));
    active++;peak=Math.max(peak,active);archiveCalls++;
    await new Promise(resolve=>setTimeout(resolve,1));active--;
    return {...meta(),payload:[{date:'22.09. 07:19',odd:'1.90',change:'0'}]};
   }
  };
  const collector=new OddsCollector({
   directory,transport,clock:()=>now,
   clockEvidence:{kind:'TEST_ONLY_SOURCE_RULE'}
  });
  collector.store.startTracking('0p1XkgIt',{test_only:true});
  const request={
   eventId:'0p1XkgIt',matchUrl:'https://www.betexplorer.com/',
   reason:'test',verification:{
    openingLabelEvidenceRef:'TEST_ONLY_OPENING_LABEL'
   }
  };
  const first=collector.collect(request);
  assert.equal(first,collector.collect(request));
  const result=await first;
  assert.equal(result.success,true);
  assert.equal(result.run.market_results.length,4);
  assert.equal(peak,2);
  assert(archiveCalls>0);
  const state=collector.store.read('0p1XkgIt');
  assert.equal(state.runs.length,1);
  assert(Object.keys(state.source_contexts).length>1);
  const observations=Object.values(state.odds_raw)
   .filter(r=>r.record_origin==='scraper_observation');
  assert.equal(observations.length,519);
  const history=Object.values(state.odds_raw)
   .filter(r=>r.record_origin==='source_opening');
  assert.equal(history.length,archiveCalls);
  assert(history.every(r=>r.source_timestamp===null));
  assert(history.every(r=>r.quote_group_id===null));
  assert(Object.values(state.coverage).some(c=>
   c.last_success.status==='current_only'));
  const count=Object.keys(state.odds_raw).length;
  now='2026-10-11T13:01:00.000Z';fail=true;
  const failed=await collector.collect(request);
  assert.equal(failed.success,false);
  const failedState=collector.store.read('0p1XkgIt');
  assert.equal(Object.keys(failedState.odds_raw).length,count);
  assert.equal(failedState.runs.length,2);
  assert.equal(failedState.interruptions.length,1);
  assert(failedState.tracking.retry_not_before);
  const backedOff=await collector.collect(request);
  assert.equal(backedOff.reason,'BACKOFF_ACTIVE');
  assert.equal(collector.store.read('0p1XkgIt').runs.length,2);
  console.log('GERCEK_YANIT_TEKRARINDA_519_HUCRE_VE_TARAF_ARSIVLERI: GECTI');
  console.log('TEK_IS_KUYRUK_KALICI_TUR_VE_GOMULU_KANIT: GECTI');
  console.log('BASARISIZ_TUR_ESKI_VERI_KORUMA_VE_BACKOFF: GECTI');
  console.log('BU_TEST_KAYITLI_YANIT_VE_SENTETIK_ARSIV_TESTIDIR; CANLI_CEKIM_DEGIL');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
