
'use strict';
const assert=require('node:assert/strict');
const {reviewQuality}=require('../../src/oddsContract/quality');
const cutoff='2026-10-11T12:00:00Z';
const row=(id,extra={})=>({
 record_id:id,event_id:'e',series_id:'s',source:'BetExplorer',
 bookmaker_id:'16',source_context_id:'context',market:'OU',
 period:'FULL_TIME_90',selection:'OVER',line:2.5,
 price_type:'SPORTSBOOK',odds_decimal:2,status:'OPEN',
 source_timestamp:cutoff,observed_at:cutoff,snapshot_id:'run',
 quote_group_id:null,record_origin:'scraper_observation',
 quality_flags:[],main_analysis_eligible:true,...extra
});
const records=[
 row('a'),row('conflict',{odds_decimal:2.1}),
 row('old',{series_id:'old',observed_at:'2026-10-11T11:00:00Z'}),
 row('future',{observed_at:'2026-10-11T12:01:00Z'}),
 row('upper',{series_id:'upper',line:3,odds_decimal:1.8})
];
const original=JSON.stringify(records);
const reviewed=reviewQuality(records,{cutoff,runs:[{
 run_id:'run',expected_interval_seconds:120,seconds_since_previous_success:600
}]});
const byId=new Map(reviewed.odds_raw.map(r=>[r.record_id,r]));
assert(byId.get('a').quality_flags.includes('SAME_IDENTITY_REPORTED_TIME_PRICE_CONFLICT'));
assert(byId.get('old').quality_flags.includes('OBSERVATION_STALE'));
assert(byId.get('future').quality_flags.includes('OBSERVED_AFTER_CUTOFF'));
assert(byId.get('upper').quality_flags.includes('COMPARABLE_NEIGHBOR_LINE_PRICE_ORDER_REVIEW'));
assert(byId.get('a').quality_flags.includes('COLLECTION_GAP'));
assert.equal(reviewed.quality.raw_records_deleted,0);
assert.equal(JSON.stringify(records),original);
assert.equal(reviewed.odds_raw.length,records.length);
assert.equal(byId.get('future').main_analysis_eligible,false);
const different=reviewQuality([
 row('low'),row('high',{line:3,odds_decimal:1.8,
 source_context_id:'different',series_id:'different'})
],{cutoff});
assert.equal(different.quality.neighbor_line_reviews.length,0);
const group=['HOME','DRAW','AWAY'].map((selection,index)=>row('g'+index,{
 market:'1X2',selection,line:null,series_id:selection,
 quote_group_id:'group',odds_decimal:1.2
}));
const extreme=reviewQuality(group,{cutoff});
assert(extreme.odds_raw.every(r=>r.quality_flags.includes('UNUSUAL_OVERROUND')));
const incomplete=reviewQuality(group.slice(0,2),{cutoff});
assert(incomplete.odds_raw.every(r=>r.quality_flags.includes('INCOMPLETE_PRICE_GROUP')));
const kickoff=reviewQuality([row('live')],{cutoff,verifiedKickoff:cutoff});
assert.equal(kickoff.odds_raw[0].main_analysis_eligible,false);
assert(kickoff.odds_raw[0].quality_flags.includes('AT_OR_AFTER_VERIFIED_KICKOFF'));
console.log('CELISKI_EKSIK_GRUP_ESKILIK_KESIM_VE_KESINTI: GECTI');
console.log('KARSILASTIRILABILIR_CIZGI_SIRALAMASI_VE_BAGLAM_AYRIMI: GECTI');
console.log('HAM_KAYIT_KORUMA_VE_FIYAT_DUZELTMEME: GECTI');
