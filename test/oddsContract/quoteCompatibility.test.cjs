'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {projectQuotes}=require('../../src/oddsContract/quoteCompatibility');
const folder=process.argv[2];
assert(folder,'FIXTURE_DIRECTORY_REQUIRED');
let count=0,groups=0;
for(const market of ['1X2','OU','ASIAN','KG']){
 const state=JSON.parse(fs.readFileSync(
  path.join(folder,'raw-parser-'+market+'.json'),'utf8'));
 const original=JSON.stringify(state);
 const result=projectQuotes(state);
 assert.equal(result.exclusions.length,0);
 const quotes=result.odds[market];
 assert.equal(quotes.length,state.quote_groups.length);
 const ids=quotes.flatMap(q=>q.raw_record_ids);
 assert.equal(ids.length,state.odds_raw.length);
 assert.deepEqual([...ids].sort(),state.odds_raw.map(r=>r.record_id).sort());
 assert.equal(JSON.stringify(state),original);
 for(const q of quotes){
  for(const r of state.odds_raw.filter(r=>q.raw_record_ids.includes(r.record_id))){
   assert.equal(q.selection_statuses[r.selection],r.status);
  }
 }
 count+=ids.length;groups+=quotes.length;
}
const record=(id,selection,price)=>({
 record_id:id,event_id:'e',source:'BetExplorer',source_context_id:'c',
 bookmaker_id:'b',bookmaker_name:'B',market:'KG',period:'FULL_TIME_90',
 selection,line:null,price_type:'UNKNOWN',snapshot_id:'s',
 quote_group_id:'q',record_origin:'scraper_observation',
 observed_at:'2026-10-11T12:00:00Z',source_timestamp:null,
 odds_decimal:price,status:'UNKNOWN',quality_flags:[],
 main_analysis_eligible:false
});
const state={odds_raw:[record('y','YES',1.9)],quote_groups:[
 {quote_group_id:'q',raw_record_ids:['y']}
]};
let q=projectQuotes(state).odds.KG[0];
assert.equal(q.no_odd,null);assert.equal(q.yes_closed,null);
assert.equal(q.no_closed,null);assert.equal(q.main_analysis_eligible,false);
state.odds_raw.push({...record('n','NO',2),source_context_id:'other'});
state.quote_groups[0].raw_record_ids.push('n');
assert.equal(projectQuotes(state).exclusions[0].reason,
 'GROUP_IDENTITY_OR_ORIGIN_MISMATCH');
console.log('GERCEK_HAM_KAYITTAN_UYUMLULUK: GECTI; hucre='+count+' grup='+groups);
console.log('EKSIK_FIYAT_BELIRSIZ_DURUM_VE_BAGLAM_KORUMA: GECTI');
