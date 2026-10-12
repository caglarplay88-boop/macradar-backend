
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {legacyCurrent}=require('../../src/oddsContract/runtime');
const source=fs.readFileSync(path.join(__dirname,'../../src/odds1x2Worker.js'),'utf8');
const folder=process.argv[2];
const meta={sourceName:'betexplorer-direct',sourceRegion:null};
const files={'1X2':'retry-1X2.json',OU:'retry-OU.json',
 ASIAN:'ASIAN-source-response.json',KG:'KG-source-response.json'};
let mode='success',claimed=0,successes=0,failures=0,collects=0;
const writes=[],queries=[];
let rawRecords=[];
const store={transaction(id,fn){fn({compatibility_write_errors:[]});}};
const runtime={
 collector:{store},
 readState(){return {odds_raw:rawRecords,tracking:{
  next_current_scan_at:'2026-10-12T12:00:00.000Z',
  retry_not_before:mode==='partial'?'2026-10-11T13:00:00.000Z':null
 }};},
 async collectTrackedMatch(job){
  collects++;
  await new Promise(resolve=>setTimeout(resolve,2));
  if(mode==='ended') return {
   reason:'PRE_MATCH_ENDED',skipped:true,snapshotId:'ended'
  };
  if(mode==='backoff') return {reason:'BACKOFF_ACTIVE',skipped:true};
  const current_payloads=Object.entries(files)
   .filter(([market])=>mode!=='partial'||market!=='KG')
   .map(([market,file])=>({
    market,source:meta,observed_at:'2026-10-11T12:00:00.000Z',
    payload:JSON.parse(fs.readFileSync(path.join(folder,file),'utf8'))
   }));
  const snapshotId='replay-'+collects;
  for(const market of Object.keys(files).filter(m=>mode!=='partial'||m!=='KG')){
   const fixture=JSON.parse(fs.readFileSync(
    path.join(folder,'raw-parser-'+market+'.json'),'utf8'));
   rawRecords.push(...fixture.odds_raw.map(r=>({
    ...r,record_id:r.record_id+'-'+collects,snapshot_id:snapshotId
   })));
  }
  return {eventId:job.event_id,snapshotId,
   success:mode==='success',skipped:false,current_payloads,
   run:{error:mode==='partial'?'PARTIAL_OR_FAILED_COLLECTION':null}};
 }
};
const writer=market=>async data=>{
 writes.push({market,data});return {inserted:data.rows.length};
};
const db={
 pool:{query:async(sql,args)=>{queries.push({sql,args});return {rows:[]};}},
 markTrackingAttempt:async()=>{
  claimed++;return {tracking_enabled:true};
 },
 markTrackingSuccess:async()=>{successes++;},
 markTrackingFailure:async()=>{failures++;},
 saveOdds1x2Batch:writer('1X2'),saveOddsOverUnderBatch:writer('OU'),
 saveOddsAsianBatch:writer('ASIAN'),saveOddsKgBatch:writer('KG')
};
const moduleObject={exports:{}};
vm.runInNewContext(source,{
 module:moduleObject,exports:moduleObject.exports,
 require(name){
  if(name==='./db') return db;
  if(name==='./oddsContract/runtime'){
   return {getContractRuntime:()=>runtime,
    legacyCurrent(){throw Error('LEGACY_REPARSING_MUST_NOT_RUN');}};
  }
  if(['./odds1x2','./oddsOverUnder','./oddsAsian','./oddsKg'].includes(name)){
   return {};
  }
  throw Error('UNEXPECTED_REQUIRE:'+name);
 },
 console,process:{env:{}},setTimeout,clearTimeout,setInterval,clearInterval
});
const worker=moduleObject.exports.capturePeriodic1x2;
assert.equal(typeof worker,'function');
const job={event_id:'0p1XkgIt',
 url:'https://www.betexplorer.com/it/football/france/ligue-2/montpellier-grenoble/0p1XkgIt/'};
(async()=>{
 const first=worker(job);
 const duplicate=await worker(job);
 assert.equal(duplicate.reason,'already-running');
 const result=await first;
 assert(result.inserted>0);
 assert.equal(claimed,1);assert.equal(collects,1);
 assert.equal(writes.length,0);assert.equal(successes,1);
 assert.equal(result.storage_basis,'SINGLE_CONTRACT_RAW_STORE');
 assert.equal(result.legacyOddsWrites,0);
 assert.equal(result.rawRecordCount,519);
 assert.equal(result.fetched1x2,30);
 assert.equal(result.fetchedOverUnder,153);
 assert.equal(result.fetchedAsian,322);
 assert.equal(result.fetchedKg,14);
 assert(writes.every(w=>w.data.rows.every(r=>
  r.capturedAt.toISOString()==='2026-10-11T12:00:00.000Z')));
 assert(queries.some(q=>q.args?.[1]==='2026-10-12T12:00:00.000Z'));
 mode='partial';
 const before=writes.length;
 await assert.rejects(worker(job),/PARTIAL_OR_FAILED_COLLECTION/);
 assert.equal(writes.length-before,0);
 assert(rawRecords.length>519,'Partial successful raw captures must survive');
 assert.equal(failures,1);
 assert(queries.some(q=>q.args?.[1]==='2026-10-11T13:00:00.000Z'));
 mode='backoff';
 assert.equal((await worker(job)).reason,'BACKOFF_ACTIVE');
 mode='ended';
 assert.equal((await worker(job)).reason,'PRE_MATCH_ENDED');
 assert(queries.some(q=>q.sql.includes('tracking_enabled=FALSE')));
 console.log('GERCEK_ISCI_TEK_HAM_DEPO_ESKI_ORAN_TABLOLARINA_SIFIR_YAZIM: GECTI');
 console.log('KISMI_HATA_DIGER_PIYASALARI_KORUMA_BACKOFF_VE_PREMATCH_BITISI: GECTI');
 console.log('KAYNAK_VE_DB_TESTTE_TAKLIT_EDILDI; CANLI_YAZIM_YAPILMADI');
})().catch(e=>{console.error(e);process.exitCode=1;});
