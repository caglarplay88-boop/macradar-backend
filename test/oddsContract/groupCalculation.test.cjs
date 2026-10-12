
'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const {calculateQuoteGroup}=require('../../src/oddsContract/groupCalculation');
const cutoff='2026-10-11T12:00:00.000Z';
const row=(selection,price)=>({
 record_id:selection,event_id:'event',source:'BetExplorer',
 bookmaker_id:'16',source_context_id:'context',market:'1X2',
 period:'FULL_TIME_90',line:null,selection,price_type:'SPORTSBOOK',
 status:'OPEN',odds_decimal:price,main_analysis_eligible:true,
 source_timestamp:cutoff,observed_at:cutoff,
 snapshot_id:'scan',quote_group_id:'group',
 record_origin:'scraper_observation'
});
const rows=[row('HOME',2),row('DRAW',3),row('AWAY',4)];
const original=JSON.stringify(rows);
const result=calculateQuoteGroup(rows,{cutoff});
assert(result.calculation);
assert(Math.abs(result.calculation.Q-13/12)<1e-12);
assert(Math.abs(result.calculation.overround-1/12)<1e-12);
assert(Math.abs(result.calculation.selections[0].normalized_price_share-6/13)<1e-12);
assert(Math.abs(result.calculation.selections.reduce(
 (sum,r)=>sum+r.normalized_price_share,0)-1)<1e-12);
assert.equal(result.winning_probability_claimed,false);
assert.equal(JSON.stringify(rows),original);
assert.equal(calculateQuoteGroup(rows.slice(0,2),{cutoff}).calculation,null);
for(const change of [
 {source_context_id:'different'},
 {price_type:'UNKNOWN'},
 {source_timestamp:null},
 {source_timestamp:'2026-10-11T11:00:00.000Z'},
 {source_timestamp:'2026-10-11T11:59:00.000Z'},
 {observed_at:'2026-10-11T12:01:00.000Z'},
 {quote_group_id:'other'},
 {snapshot_id:'other'},
 {status:'SUSPENDED'}
]){
 const result=calculateQuoteGroup([
  {...rows[0],...change},...rows.slice(1)
 ],{cutoff});
 assert.equal(result.calculation,null,JSON.stringify(change));
}
const carried=[{
 ...rows[0],source_timestamp:'2026-10-11T11:59:00.000Z',
 observed_at:'2026-10-11T11:59:00.000Z',quote_group_id:'older',
 snapshot_id:'older'
},...rows.slice(1)];
const reconstructed=calculateQuoteGroup(carried,{
 cutoff,reconstructed:true,maxSourceTimeSkewSeconds:120
});
assert(reconstructed.calculation);
assert.equal(reconstructed.reconstructed,true);
assert.equal(reconstructed.side_ages[0].source_age_seconds,60);
assert.equal(calculateQuoteGroup(carried,{
 cutoff,reconstructed:true,maxSourceTimeSkewSeconds:120,maxAgeSeconds:59
}).calculation,null);
const quarter=[
 {...row('UNDER',1.9),market:'OU',line:2.75},
 {...row('OVER',1.9),market:'OU',line:2.75}
];
assert(calculateQuoteGroup(quarter,{cutoff}).calculation);
const folder=process.argv[2];
let checked=0;
for(const market of ['1X2','OU','ASIAN','KG']){
 const data=JSON.parse(fs.readFileSync(
  path.join(folder,'raw-parser-'+market+'.json'),'utf8'));
 const byId=new Map(data.odds_raw.map(r=>[r.record_id,r]));
 for(const group of data.quote_groups){
  const actual=group.raw_record_ids.map(id=>byId.get(id));
  const output=calculateQuoteGroup(actual,{
   cutoff:'2026-10-11T12:13:00.000Z'
  });
  assert.equal(output.calculation,null);
  assert(output.exclusion_reasons.length);
  checked++;
 }
}
console.log('FIYAT_PAYI_OVERROUND_VE_EKSIK_UYUMSUZ_GRUP_REDDI: GECTI');
console.log('ACIKCA_ISARETLENMIS_YENIDEN_KURMA_VE_ESKILIK_SINIRI: GECTI');
console.log('GERCEK_DOGRULANMAMIS_GRUPLARDA_HESAP_URETMEME: GECTI; grup='+checked);
