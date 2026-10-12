'use strict';
const fs=require('node:fs'),path=require('node:path');
const assert=require('node:assert/strict');
const {projectQuotes}=require('../../src/oddsContract/quoteCompatibility');
const server=fs.readFileSync(path.join(__dirname,'../../src/server.js'),'utf8');
const extract=name=>{
 const start=server.indexOf('function '+name+'(');
 assert(start>=0);
 const end=server.indexOf('\nfunction ',start+1);
 assert(end>=0);
 return server.slice(start,end);
};
const helper=new Function(extract('oddsNullableNumber')+
 ';return oddsNullableNumber;')();
assert.equal(helper(null),null);assert.equal(helper(''),null);
assert.equal(helper(false),null);assert.equal(helper('invalid'),null);
assert.equal(helper('-0.25'),-0.25);assert.equal(helper(0),0);
const cases=[
 ['1X2','oddsBatchEnvelope',['home_odd','draw_odd','away_odd']],
 ['OU','oddsOverUnderBatchEnvelope',['over_odd','under_odd','total_line']],
 ['ASIAN','oddsAsianBatchEnvelope',['home_odd','away_odd','handicap_line']],
 ['KG','oddsKgBatchEnvelope',['yes_odd','no_odd']]
];
for(const [market,name,fields] of cases){
 const envelope=new Function('oddsNullableNumber',extract(name)+
  ';return '+name+';')(helper);
 const input={bookmaker_id:'b',bookmaker_name:'B',raw_record_ids:['r'],
  selection_statuses:{HOME:'UNKNOWN'},main_analysis_eligible:false,
  home_closed:null,draw_closed:null,away_closed:null,
  over_closed:null,under_closed:null,yes_closed:null,no_closed:null};
 for(const field of fields) input[field]=null;
 const wrap=rows=>({rows,capture_sequence:'s',capture_type:'current',
  captured_at:'2026-10-11T12:00:00Z',source_name:'BetExplorer'});
 const actual=envelope(wrap([input])).rows[0];
 for(const field of fields) assert.equal(actual[field],null,name+':'+field);
 for(const [field,value] of Object.entries(actual)){
  if(field.endsWith('_closed')) assert.equal(value,null,name+':'+field);
 }
 assert.deepEqual(actual.raw_record_ids,['r']);
 assert.equal(actual.main_analysis_eligible,false);
 const state=JSON.parse(fs.readFileSync(
  path.join(process.argv[2],'raw-parser-'+market+'.json'),'utf8'));
 const quotes=projectQuotes(state).odds[market];
 const result=envelope(wrap(quotes));
 assert.equal(result.rows.length,quotes.length);
 for(let i=0;i<quotes.length;i++){
  for(const field of fields) assert.equal(result.rows[i][field],quotes[i][field]);
  assert.deepEqual(result.rows[i].raw_record_ids,quotes[i].raw_record_ids);
 }
}
console.log('DORT_API_YANITINDA_NULL_FIYAT_CIZGI_DURUM_VE_HAM_BAGLAR: GECTI');
