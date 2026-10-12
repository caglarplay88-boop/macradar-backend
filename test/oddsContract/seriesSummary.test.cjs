
'use strict';
const assert=require('node:assert/strict');
const {summarizeSeries}=require('../../src/oddsContract/seriesSummary');
const cutoff='2026-10-11T12:00:00.000Z';
const record=(id,minute,price,status='OPEN',extra={})=>({
 record_id:id,series_id:'series',odds_decimal:price,status,
 record_origin:'scraper_observation',opening_type:null,
 source_timestamp:null,observed_at:new Date(
 Date.parse(cutoff)-(30-minute)*60000).toISOString(),
 main_analysis_eligible:true,...extra
});
const rows=[
 record('a',0,2),record('repeat',1,2),record('b',5,1.8),
 record('closed',6,1.8,'CLOSED'),record('reopened',7,1.8),
 record('back',10,2)
];
const original=JSON.stringify(rows);
const result=summarizeSeries(rows,{cutoff,maxWindowCarrySeconds:600});
assert.equal(result.since_start.different_price_transitions,2);
assert.equal(result.since_start.direction_reversals,1);
assert.equal(result.since_start.status_transitions,2);
assert.equal(result.since_start.absolute_change,0);
assert.equal(result.since_start.percentage_change,0);
assert.equal(result.selected_start_type,'first_observed');
assert.equal(result.beginnings.source_reported_opening,null);
assert.equal(result.beginnings.earliest_available_history,null);
assert.equal(result.since_start.source_age_seconds,null);
assert.equal(result.since_start.observation_age_seconds,1200);

assert.equal(result.windows.last_15_minutes.boundary_record.record_id,'back');
assert.equal(result.windows.last_15_minutes.boundary_record_age_seconds,300);
assert.equal(result.windows.last_15_minutes.result.first.record_id,'back');
const tooOld=summarizeSeries(rows,{cutoff,maxWindowCarrySeconds:299});
assert.equal(tooOld.windows.last_15_minutes.result,null);
assert.equal(tooOld.windows.last_15_minutes.exclusion_reason,
 'NO_ACCEPTABLE_WINDOW_START_RECORD');

assert.equal(JSON.stringify(rows),original);
assert.deepEqual(summarizeSeries(rows,{cutoff,maxWindowCarrySeconds:600}),result);
const history=record('late-history',0,2.5,'OPEN',{
 record_origin:'source_opening',opening_type:'source_reported_opening',
 source_timestamp:'2026-10-10T12:00:00.000Z',
 observed_at:'2026-10-11T12:01:00.000Z'
});
const strict=summarizeSeries([...rows,history],{cutoff});
assert.equal(strict.selected_start_type,'first_observed');
assert(strict.excluded_records.find(r=>r.record_id==='late-history')
 .reasons.includes('OBSERVED_AFTER_CUTOFF'));
const retrospective=summarizeSeries([...rows,history],{
 cutoff,mode:'retrospective_source_history'
});
assert.equal(retrospective.selected_start_type,'source_reported_opening');
assert.equal(retrospective.beginnings.first_observed.record_id,'a');
assert.equal(retrospective.windows.last_24_hours.result.first.record_id,'late-history');
const bad=summarizeSeries([record('bad',1,2,'UNKNOWN',{
 main_analysis_eligible:false
})],{cutoff});
assert.equal(bad.since_start,null);
assert.equal(bad.used_record_ids.length,0);
assert.throws(()=>summarizeSeries([
 ...rows,record('other',1,2,'OPEN',{series_id:'other'})
],{cutoff}));
const exact=summarizeSeries([
 record('boundary',15,2),record('end',30,1.5)
],{cutoff});
assert.equal(exact.windows.last_15_minutes.result.absolute_change,-0.5);
console.log('ABA_TEKRARLAR_VE_ACIK_KAPALI_ACIK: GECTI');
console.log('UC_BASLANGIC_TURU_KESIM_PENCERE_VE_YENIDEN_URETIM: GECTI');
