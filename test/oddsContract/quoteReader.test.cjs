'use strict';
const fs=require('node:fs'),path=require('node:path');
const assert=require('node:assert/strict');
const {readQuoteBatch}=require('../../src/oddsContract/quoteReader');
const folder=process.argv[2];
let checked=0;
for(const market of ['1X2','OU','ASIAN','KG']){
 const state=JSON.parse(fs.readFileSync(
  path.join(folder,'raw-parser-'+market+'.json'),'utf8'));
 state.tracking={initialized:true};state.runs=[{success:false,error:'TEST_502'}];
 const result=readQuoteBatch(state,market);
 assert.equal(result.handled,true);
 assert(result.batch.rows.length);
 assert.equal(result.batch.data_origin,'CONTRACT_RAW_QUOTE_GROUPS');
 assert.equal(result.batch.last_scan_result.success,false);
 if(['OU','ASIAN'].includes(market)){
  const unresolved=state.odds_raw.filter(r=>r.line===null);
  const ids=new Set(result.batch.rows.flatMap(r=>r.raw_record_ids));
  assert(unresolved.every(r=>ids.has(r.record_id)),
   'Unresolved lines must not overwrite one another');
 }

 assert(result.batch.rows.every(r=>r.raw_record_ids.length));
 assert.equal(readQuoteBatch(state,market,{captureType:'opening'}).batch,null);
 assert.throws(()=>readQuoteBatch(state,market,{captureType:'bad'}));
 if(market==='OU'){
  for(const line of [2.5,2.75,3]){
   const batch=readQuoteBatch(state,market,{line}).batch;
   assert(batch&&batch.rows.every(r=>r.total_line===line));
  }
 }
 checked+=result.batch.rows.length;
}
assert.equal(readQuoteBatch({tracking:{initialized:true}},'KG').batch,null);
assert.equal(readQuoteBatch({},'KG').handled,false);
const db=fs.readFileSync(path.join(__dirname,'../../src/db.js'),'utf8');
const cases={
 getLatestOdds1x2Batch:['1X2',['e','current']],
 getLatestLiveOdds1x2State:['1X2',['e']],
 getLatestOddsOverUnderBatch:['OU',['e','current',2.75]],
 getLatestLiveOddsOverUnderState:['OU',['e',2.75]],
 getLatestOddsAsianBatch:['ASIAN',['e','current',-0.25]],
 getLatestLiveOddsAsianState:['ASIAN',['e',-0.25]],
 getLatestOddsKgBatch:['KG',['e','current']],
 getLatestLiveOddsKgState:['KG',['e']]
};
(async()=>{
 for(const [name,[market,args]] of Object.entries(cases)){
  const start=db.indexOf('async function '+name+'(');
  const boundaries=['\nasync function ','\nfunction ','\nmodule.exports']
   .map(s=>db.indexOf(s,start+1)).filter(n=>n>=0);
  const source=db.slice(start,Math.min(...boundaries));
  const batch={rows:[{raw_record_ids:['raw']}],data_origin:'CONTRACT_RAW_QUOTE_GROUPS'};
  let calls=0;
  const fn=new Function('require','pool',source+';return '+name+';')(
   module=>{
    assert.equal(module,'./oddsContract/quoteReader');
    return {readRuntimeBatch:(id,m,options)=>{
     calls++;assert.equal(id,'e');assert.equal(m,market);
     if(args.length===3) assert.equal(options.line,args[2]);
     return {handled:true,batch};
    }};
   },
   {query(){throw Error('OLD_ODDS_QUERY_MUST_NOT_RUN');}}
  );
  assert.equal(await fn(...args),batch);assert.equal(calls,1);
 }
 console.log('SEKIZ_GERCEK_EKRAN_OKUYUCUSU_ESKI_TABLOYA_SORGU_YAPMADAN: GECTI');
 console.log('DORT_PIYASA_HAM_GRUP_CIZGI_HATA_VE_EKSIK_ACILIS_KORUMA: GECTI; grup='+checked);
})().catch(e=>{console.error(e);process.exitCode=1;});
