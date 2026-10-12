'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const server=fs.readFileSync(path.join(__dirname,'../../src/server.js'),'utf8');
const helperStart=server.indexOf('function oddsNullableNumber(');
const helperEnd=server.indexOf('\nfunction ',helperStart+1);
const number=new Function(server.slice(helperStart,helperEnd)+
 ';return oddsNullableNumber;')();
function callEnd(text,start){
 const opening=text.indexOf('(',start);
 let depth=0,quote=null,escape=false;
 for(let i=opening;i<text.length;i++){
  const c=text[i];
  if(quote){
   if(escape) escape=false;
   else if(c==='\\') escape=true;
   else if(c===quote) quote=null;
   continue;
  }
  if(["'",'"','`'].includes(c)) quote=c;
  else if(c==='(') depth++;
  else if(c===')'&&--depth===0) return i+1;
 }
 throw Error('JSON_CALL_END_MISSING');
}
for(const name of ['listOdds1x2History','listOddsOverUnderHistory',
 'listOddsAsianHistory','listOddsKgHistory']){
 const match=new RegExp('await\\s+'+name+'\\(').exec(server);
 assert(match);
 const response=/return\s+json\(\s*res,\s*200,\s*\{/.exec(server.slice(match.index));
 assert(response);
 const start=match.index+response.index;
 const code=server.slice(start,callEnd(server,start));
 const row={
  id:'q',home_odd:null,draw_odd:null,away_odd:null,
  over_odd:null,under_odd:null,yes_odd:null,no_odd:null,
  total_line:null,handicap_line:null,
  home_closed:null,draw_closed:null,away_closed:null,
  over_closed:null,under_closed:null,yes_closed:null,no_closed:null,
  raw_record_ids:['raw'],source_context_id:'context',
  main_analysis_eligible:false
 };
 const history={rows:[row],raw_records:[{record_id:'raw'}],
  archive_selections_grouped:false};
 const invoke=new Function('history','eventId','oddsNullableNumber','json','res',code);
 const result=invoke(history,'e',number,(_res,status,body)=>{
  assert.equal(status,200);return body;
 },{});
 assert.deepEqual(result.raw_records,history.raw_records);
 assert.deepEqual(result.rows[0].raw_record_ids,['raw']);
 for(const [field,value] of Object.entries(result.rows[0])){
  if(field.endsWith('_odd')||field.endsWith('_closed')||
     field==='total_line'||field==='handicap_line'){
   assert.equal(value,null,name+':'+field);
  }
 }

}

const pack=fs.readFileSync(path.join(__dirname,'../../src/matchDataExport.js'),'utf8');
const begin=pack.indexOf('const key=JSON.stringify(');
const finish=pack.indexOf(';',begin);
const key=new Function('row','market','return '+pack.slice(begin+10,finish));
const base={bookmaker_id:'b',total_line:2.5,source_context_id:'c',
 period:'FULL_TIME_90',price_type:'SPORTSBOOK'};
const market={key:'OU',line:'total_line'};
assert.notEqual(key(base,market),key({...base,source_context_id:'other'},market));
assert.notEqual(key(base,market),key({...base,price_type:'EXCHANGE_BACK'},market));
console.log('DORT_GECMIS_API_NULL_HAM_ALANLAR_VE_GRAFIK_BAGLAM_AYRIMI: GECTI');
