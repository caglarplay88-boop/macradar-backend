'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {readQuoteHistory}=require('../../src/oddsContract/quoteReader');
const folder=process.argv[2];
for(const market of ['1X2','OU','ASIAN','KG']){
 const state=JSON.parse(fs.readFileSync(
  path.join(folder,'raw-parser-'+market+'.json'),'utf8'));
 state.tracking={initialized:true};
 const parent=state.odds_raw[0];
 const archive={...parent,record_id:'history-'+market,
  quote_group_id:null,record_origin:'source_history',
  observed_at:'2026-10-11T13:00:00Z',source_timestamp:null};
 state.odds_raw.push(archive);
 const result=readQuoteHistory(state,market,{pageSize:300}).history;
 assert.equal(result.total_records,state.quote_groups.length);
 assert(result.raw_records.some(r=>r.record_id===archive.record_id));
 assert(result.rows.every(r=>!r.raw_record_ids.includes(archive.record_id)));
 assert.equal(result.archive_selections_grouped,false);
 assert.equal(result.raw_record_pagination.total_records,state.odds_raw.length);
 const filtered=readQuoteHistory(state,market,{
  bookmaker:parent.bookmaker_id,pageSize:300}).history;
 assert(filtered.rows.every(r=>r.bookmaker_id===parent.bookmaker_id));
 const paged=readQuoteHistory(state,market,{pageSize:1}).history;
 assert.equal(paged.rows.length,1);
}
const db=fs.readFileSync(path.join(__dirname,'../../src/db.js'),'utf8');
const cases={
 listOdds1x2History:'1X2',listOddsOverUnderHistory:'OU',
 listOddsAsianHistory:'ASIAN',listOddsKgHistory:'KG'
};
(async()=>{
 for(const [name,market] of Object.entries(cases)){
  const start=db.indexOf('async function '+name+'(');
  const end=Math.min(...['\nasync function ','\nfunction ','\nmodule.exports']
   .map(s=>db.indexOf(s,start+1)).filter(n=>n>=0));
  const expected={rows:[],raw_records:[{record_id:'raw'}]};
  const fn=new Function('require','pool',db.slice(start,end)+';return '+name+';')(
   module=>{
    assert.equal(module,'./oddsContract/quoteReader');
    return {readRuntimeHistory:(id,m)=>{
     assert.equal(id,'e');assert.equal(m,market);
     return {handled:true,history:expected};
    }};
   },{query(){throw Error('OLD_HISTORY_QUERY_MUST_NOT_RUN');}}
  );
  assert.equal(await fn({eventId:'e'}),expected);
 }
 console.log('DORT_GECMIS_API_OKUYUCUSU_TEK_HAM_DEPODAN: GECTI');
 console.log('ARSIV_TARAFLARI_SAHTE_GRUPLANMADI; HAM_SAYFALAMA_KORUNDU');
})().catch(e=>{console.error(e);process.exitCode=1;});
