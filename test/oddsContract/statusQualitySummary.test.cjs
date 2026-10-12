'use strict';
const assert=require('node:assert/strict');
const {reviewQuality}=require('../../src/oddsContract/quality');
const {summarizeSeries}=require('../../src/oddsContract/seriesSummary');
const cutoff='2026-10-11T12:06:00Z';
const row=(id,minute,status,extra={})=>({
 record_id:id,event_id:'e',series_id:'s',source:'BetExplorer',
 bookmaker_id:'16',source_context_id:'context',market:'KG',
 period:'FULL_TIME_90',selection:'YES',line:null,
 price_type:'SPORTSBOOK',odds_decimal:2,status,
 source_timestamp:`2026-10-11T12:0${minute}:00Z`,
 observed_at:`2026-10-11T12:0${minute}:00Z`,
 snapshot_id:id,quote_group_id:null,record_origin:'scraper_observation',
 quality_flags:[],main_analysis_eligible:true,...extra
});
const raw=[row('open',0,'OPEN'),row('closed',2,'CLOSED'),
 row('reopened',4,'OPEN')];
const original=JSON.stringify(raw);
const reviewed=reviewQuality(raw,{cutoff});
const closed=reviewed.odds_raw[1];
assert.equal(closed.main_analysis_eligible,false);
assert.equal(closed.cutoff_price_eligible,false);
assert.equal(closed.historical_movement_eligible,true);
const result=summarizeSeries(reviewed.odds_raw,{cutoff});
assert.equal(result.since_start.status_transitions,2);
assert.equal(result.since_start.different_price_transitions,0);
assert(result.used_record_ids.includes('closed'));
assert.equal(result.cutoff_price.record_id,'reopened');
assert.equal(JSON.stringify(raw),original);
const suspended=reviewQuality([
 row('a',0,'OPEN'),row('suspend',2,'SUSPENDED'),row('b',4,'OPEN')
],{cutoff});
assert.equal(summarizeSeries(suspended.odds_raw,{cutoff})
 .since_start.status_transitions,2);
const ended=reviewQuality(raw.slice(0,2),{cutoff});
assert.equal(summarizeSeries(ended.odds_raw,{cutoff}).cutoff_price,null);
const invalid=reviewQuality([
 row('unknown',2,'UNKNOWN'),
 row('unverified',3,'CLOSED',{main_analysis_eligible:false})
],{cutoff});
assert(invalid.odds_raw.every(r=>r.historical_movement_eligible===false));
assert.equal(summarizeSeries(invalid.odds_raw,{cutoff}).since_start,null);
console.log('KALITE_SONRASI_ACIK_KAPALI_ACIK_VE_ASKI_GECISLERI: GECTI');
console.log('KAPALI_KESIM_FIYATI_VE_DOGRULANMAMIS_KAYIT_REDDI: GECTI');
