
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {ContractRuntime,legacyCurrent}=require('../../src/oddsContract/runtime');
const {parse1x2}=require('../../src/odds1x2');
const {parseOverUnder}=require('../../src/oddsOverUnder');
const {parseAsian}=require('../../src/oddsAsian');
const {parseKg}=require('../../src/oddsKg');
const folder=process.argv[2];
const fixtures={
 '1X2':['retry-1X2.json',parse1x2],
 OU:['retry-OU.json',parseOverUnder],
 ASIAN:['ASIAN-source-response.json',parseAsian],
 KG:['KG-source-response.json',parseKg]
};
const source={sourceName:'betexplorer-direct',sourceRegion:null};
const observed='2026-10-11T12:00:00.000Z';
const result={eventId:'0p1XkgIt',snapshotId:'REPLAY_ONLY',
 current_payloads:Object.entries(fixtures).map(([market,[filename]])=>({
  market,source,observed_at:observed,
  payload:JSON.parse(fs.readFileSync(path.join(folder,filename),'utf8'))
 }))
};
const converted=legacyCurrent(result);
for(const [market,[,parser]] of Object.entries(fixtures)){
 const payload=result.current_payloads.find(r=>r.market===market).payload;
 assert.deepEqual(converted[market].rows,parser(payload.odds));
 assert.equal(converted[market].capturedAt.toISOString(),observed);
 assert(converted[market].compatibilityWarnings.length>0);
}
assert.throws(()=>legacyCurrent({...result,current_payloads:[
 ...result.current_payloads,result.current_payloads[0]
]}),/DUPLICATE_CURRENT_MARKET_PAYLOAD/);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'macradar-runtime-test-'));
let requests=0;
const runtime=new ContractRuntime({directory,transport:{
 fetchJsonWithFailover(){requests++;throw Error('UNEXPECTED_SOURCE_REQUEST');}
}});
const job={event_id:'0p1XkgIt',
 url:'https://www.betexplorer.com/it/football/france/ligue-2/montpellier-grenoble/0p1XkgIt/'};
try{
 assert.throws(()=>runtime.setTracking({...job,event_id:'wrong'},true),
  /CONTRACT_MATCH_URL_ID_MISMATCH/);
 runtime.setTracking(job,true);
 runtime.collector.store.transaction(job.event_id,state=>{
  state.tracking.last_scan_run_id='PRESERVED_RUN';
 });
 runtime.setTracking(job,true);
 assert.equal(runtime.readState(job.event_id).tracking.last_scan_run_id,'PRESERVED_RUN');
 runtime.setTracking(job,false);
 assert.equal(runtime.readState(job.event_id).tracking.enabled,false);
 assert.throws(()=>runtime.collectTrackedMatch({...job,tracking_enabled:false}),
  /TRACKING_DISABLED/);
 assert.equal(requests,0);
 const restarted=new ContractRuntime({directory,transport:{}});
 assert.equal(restarted.readState(job.event_id).tracking.enabled,false);
 assert.equal(restarted.readState(job.event_id).tracking.last_scan_run_id,'PRESERVED_RUN');
 console.log('DORT_GERCEK_YANIT_ESKI_PARSER_UYUMLULUGU_VE_ZAMAN_ANLAMI: GECTI');
 console.log('URL_EVENT_KONTROLU_TEKRAR_TAKIP_DURDURMA_VE_YENIDEN_BASLATMA: GECTI');
 console.log('UYUMLULUK_SINIRLARI_ACIKCA_KAYDEDILDI; CANLI_CEKIM_YAPILMADI');
}finally{fs.rmSync(directory,{recursive:true,force:true});}
