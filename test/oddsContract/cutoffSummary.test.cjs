
'use strict';
const assert=require('node:assert/strict');
const {summarizeSeries}=require('../../src/oddsContract/seriesSummary');
const cutoff='2026-10-11T12:00:00.000Z';
function row(id,time,price,fresh){
 return {
  record_id:id,series_id:'s',odds_decimal:price,status:'OPEN',
  source_timestamp:time,observed_at:time,
  record_origin:'scraper_observation',main_analysis_eligible:true,
  cutoff_price_eligible:fresh,quality_flags:[]
 };
}
const opening={...row('opening','2026-10-10T12:00:00.000Z',2.0,false),
 record_origin:'source_opening',opening_type:'source_reported_opening'};
const recent=row('recent','2026-10-11T11:59:00.000Z',1.8,true);
const result=summarizeSeries([opening,recent],{cutoff});
assert.equal(result.beginnings.source_reported_opening.record_id,'opening');
assert.equal(result.cutoff_price.record_id,'recent');
assert(Math.abs(result.cutoff_change.absolute_change+0.2)<1e-9);
assert(Math.abs(result.cutoff_change.percentage_change+10)<1e-9);
assert.equal(result.cutoff_price_source_age_seconds,60);
assert.equal(result.since_start.different_price_transitions,1);
const stale=summarizeSeries([opening,{...recent,cutoff_price_eligible:false}],{cutoff});
assert.equal(stale.cutoff_price,null);
assert.equal(stale.cutoff_change,null);
assert.equal(stale.since_start.different_price_transitions,1);
assert.equal(stale.cutoff_price_exclusion_reason,'LATEST_PRICE_NOT_VERIFIED_FRESH');
const closed={...recent,record_id:'closed',
 source_timestamp:'2026-10-11T11:59:30.000Z',
 observed_at:'2026-10-11T11:59:30.000Z',
 status:'CLOSED',main_analysis_eligible:false,cutoff_price_eligible:false};
assert.equal(summarizeSeries([opening,recent,closed],{cutoff}).cutoff_price,null);
const reopened=row('reopened','2026-10-11T11:59:45.000Z',1.8,true);
assert.equal(summarizeSeries([opening,recent,closed,reopened],{cutoff})
 .cutoff_price.record_id,'reopened');
const late={...recent,record_id:'late-history',record_origin:'source_history',
 observed_at:'2026-10-11T12:01:00.000Z'};
assert.equal(summarizeSeries([opening,late],{cutoff}).cutoff_price,null);
console.log('GECMIS_HAREKET_KORUNDU_ESKI_KESIM_FIYATI_REDDEDILDI: GECTI');
console.log('KAPANMA_YENIDEN_ACILMA_VE_STRICT_AS_OF_KESIMI: GECTI');
