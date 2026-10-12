
'use strict';
const assert=require('node:assert/strict');
const {reviewQuality}=require('../../src/oddsContract/quality');
const {summarizeSeries}=require('../../src/oddsContract/seriesSummary');
const cutoff='2026-10-11T12:00:00.000Z';
const row=(id,time,price,extra={})=>({
 record_id:id,event_id:'fixture',source:'BetExplorer',bookmaker_id:'16',
 bookmaker_name:'Test',source_context_id:'context',series_id:'series',
 market:'1X2',period:'FULL_TIME_90',selection:'HOME',line:null,
 price_type:'SPORTSBOOK',odds_decimal:price,status:'OPEN',
 source_timestamp:time,observed_at:time,snapshot_id:id,quote_group_id:id,
 record_origin:'scraper_observation',quality_flags:[],
 main_analysis_eligible:true,...extra
});
const raw=[
 row('opening','2026-10-10T12:00:00.000Z',2.2,{
  record_origin:'source_opening',opening_type:'source_reported_opening'
 }),
 row('latest','2026-10-11T11:59:00.000Z',1.9)
];
const original=JSON.stringify(raw);
const reviewed=reviewQuality(raw,{cutoff});
const opening=reviewed.odds_raw.find(r=>r.record_id==='opening');
assert(opening.quality_flags.includes('SOURCE_PRICE_STALE'));
assert.equal(opening.main_analysis_eligible,true);
assert.equal(opening.cutoff_price_eligible,false);
assert.equal(reviewed.odds_raw.find(r=>r.record_id==='latest').cutoff_price_eligible,true);
const summary=summarizeSeries(reviewed.odds_raw,{cutoff});
assert.equal(summary.selected_start_type,'source_reported_opening');
assert.equal(summary.since_start.different_price_transitions,1);
assert(summary.used_record_ids.includes('opening'));
assert.equal(JSON.stringify(raw),original);
const invalid=reviewQuality([row('invalid',cutoff,1.9,{
 quality_flags:['OBSERVATION_TIME_INVALID']
})],{cutoff});
assert.equal(invalid.odds_raw[0].main_analysis_eligible,false);
console.log('GECMIS_ACILIS_KORUMA_VE_KESIM_ESKILIK_REDDI: GECTI');
