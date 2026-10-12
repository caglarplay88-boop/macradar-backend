
'use strict';
const {eligibleAtCutoff}=require('./sourceTime');
const CALCULATION_VERSION='betexplorer-basic-movement-v2-status-v1';
function point(record){
 return {
  record_id:record.record_id,price:record.odds_decimal,
  source_timestamp:record.source_timestamp,
  observed_at:record.observed_at,
  time_basis:record.source_timestamp?'source_timestamp':'observed_at',
  effective_time:record.source_timestamp||record.observed_at,
  status:record.status,record_origin:record.record_origin
 };
}
function stats(records,cutoff){
 const rows=records.map(point);
 const opened=rows.filter(r=>r.status==='OPEN');
 if(!opened.length) return null;
 const first=opened[0],last=opened.at(-1);
 let transitions=0,reversals=0,lastDirection=0,lastChange=null;
 let previous=first;
 for(const current of opened.slice(1)){
  const direction=Math.sign(current.price-previous.price);
  if(direction){
   transitions++;
   if(lastDirection&&lastDirection!==direction) reversals++;
   lastDirection=direction;
   lastChange={
    from_record_id:previous.record_id,to_record_id:current.record_id,
    previous_price:previous.price,new_price:current.price,
    source_reported_time:current.source_timestamp||null,
    observation_interval:{
     after:previous.observed_at,at_or_before:current.observed_at
    },
    continuous_price_between_observations_verified:false
   };
  }
  previous=current;
 }
 let statusTransitions=0;
 for(let i=1;i<rows.length;i++){
  if(rows[i].status!==rows[i-1].status) statusTransitions++;
 }
 const minimum=Math.min(...opened.map(r=>r.price));
 const maximum=Math.max(...opened.map(r=>r.price));
 const cutoffMs=Date.parse(cutoff);
 return {
  first,last,
  absolute_change:last.price-first.price,
  percentage_change:100*(last.price/first.price-1),
  minimum:{
   price:minimum,records:opened.filter(r=>r.price===minimum)
  },
  maximum:{
   price:maximum,records:opened.filter(r=>r.price===maximum)
  },
  different_price_transitions:transitions,
  direction_reversals:reversals,
  status_transitions:statusTransitions,
  last_observed_price_change:lastChange,
  source_age_seconds:last.source_timestamp?
   (cutoffMs-Date.parse(last.source_timestamp))/1000:null,
  observation_age_seconds:(cutoffMs-Date.parse(last.observed_at))/1000,
  used_record_ids:rows.map(r=>r.record_id),
  observation_count:rows.length,
  uninterrupted_price_stability_claimed:false
 };
}
function summarizeSeries(records,{
 cutoff,mode='strict_as_of',maxWindowCarrySeconds=300
}){
 if(!Number.isFinite(maxWindowCarrySeconds)||maxWindowCarrySeconds<0){
  throw Error('INVALID_WINDOW_CARRY_LIMIT');
 }
 const identities=[...new Set(records.map(r=>r.series_id))];
 if(identities.length>1) throw Error('MIXED_SERIES_IDENTITIES');
 const excluded=[],accepted=[];
 for(const record of records){
  const reasons=[...eligibleAtCutoff(record,cutoff,mode).reasons];
  if(record.main_analysis_eligible!==true&&
     record.historical_movement_eligible!==true){
   reasons.push('MAIN_ANALYSIS_INELIGIBLE');
  }
  if(!Number.isFinite(record.odds_decimal)||record.odds_decimal<=1){
   reasons.push('INVALID_DECIMAL_PRICE');
  }
  if(!['OPEN','SUSPENDED','CLOSED'].includes(record.status)){
   reasons.push('STATUS_UNVERIFIED');
  }
  if(record.record_origin!=='scraper_observation'&&!record.source_timestamp){
   reasons.push('HISTORY_TIME_UNVERIFIED');
  }
  if(reasons.length) excluded.push({
   record_id:record.record_id,reasons:[...new Set(reasons)]
  });
  else accepted.push(record);
 }
 accepted.sort((a,b)=>{
  const at=Date.parse(a.source_timestamp||a.observed_at);
  const bt=Date.parse(b.source_timestamp||b.observed_at);
  return at-bt || Date.parse(a.observed_at)-Date.parse(b.observed_at) ||
   String(a.record_id).localeCompare(String(b.record_id));
 });
 const open=accepted.filter(r=>r.status==='OPEN');
 const opening=open.find(r=>r.opening_type==='source_reported_opening');
 const histories=open.filter(r=>['source_history','source_opening']
  .includes(r.record_origin));
 const observations=open.filter(r=>r.record_origin==='scraper_observation')
  .sort((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at));
 const beginnings={
  source_reported_opening:opening?point(opening):null,
  earliest_available_history:histories.length?point(histories[0]):null,
  first_observed:observations.length?point(observations[0]):null
 };
 const chosen=opening||histories[0]||observations[0]||null;
 const chosenType=opening?'source_reported_opening':
  histories.length?'earliest_available_history':
  observations.length?'first_observed':null;
 const windows={};
 const cutoffMs=Date.parse(cutoff);
 for(const [name,seconds] of [
  ['last_24_hours',86400],['last_6_hours',21600],
  ['last_1_hour',3600],['last_15_minutes',900]
 ]){
  const boundary=cutoffMs-seconds*1000;
  const inside=accepted.filter(r=>
   Date.parse(r.source_timestamp||r.observed_at)>=boundary);
  const before=open.filter(r=>
   Date.parse(r.source_timestamp||r.observed_at)<boundary).at(-1);
  const age=before?(boundary-Date.parse(
   before.source_timestamp||before.observed_at))/1000:null;
  const carry=before&&age<=maxWindowCarrySeconds?before:null;
  const exact=inside.some(r=>r.status==='OPEN'&&
   Date.parse(r.source_timestamp||r.observed_at)===boundary);
  windows[name]={
   starts_at:new Date(boundary).toISOString(),ends_at:cutoff,
   max_carry_age_seconds:maxWindowCarrySeconds,
   boundary_record:carry?point(carry):null,
   boundary_record_age_seconds:carry?age:null,
   interpolation_used:false,
   result:carry||exact?stats(carry?[carry,...inside]:inside,cutoff):null,
   exclusion_reason:carry||exact?null:'NO_ACCEPTABLE_WINDOW_START_RECORD'
  };
 }

 const lastObserved=open.at(-1)||null;
 const timeOf=record=>Date.parse(record.source_timestamp||record.observed_at);
 const laterStatus=lastObserved?records.filter(record=>
  eligibleAtCutoff(record,cutoff,mode).reasons.length===0&&
  ['SUSPENDED','CLOSED'].includes(record.status)&&
  Number.isFinite(timeOf(record))&&timeOf(record)>=timeOf(lastObserved)
 ).sort((a,b)=>timeOf(a)-timeOf(b)).at(-1):null;
 const cutoffRecord=lastObserved&&
  lastObserved.cutoff_price_eligible===true&&!laterStatus?lastObserved:null;
 const cutoffReason=cutoffRecord?null:
  laterStatus?'LATEST_KNOWN_STATUS_NOT_OPEN':
  lastObserved?'LATEST_PRICE_NOT_VERIFIED_FRESH':'NO_ELIGIBLE_PRICE';
 const cutoffPoint=cutoffRecord?point(cutoffRecord):null;
 const cutoffChange=cutoffRecord&&chosen?{
  calculation_version:CALCULATION_VERSION,
  time_basis:cutoffRecord.source_timestamp?'SOURCE_TIMESTAMP':'OBSERVED_AT',
  first:point(chosen),last:cutoffPoint,
  absolute_change:cutoffRecord.odds_decimal-chosen.odds_decimal,
  percentage_change:100*(cutoffRecord.odds_decimal/chosen.odds_decimal-1),
  used_record_ids:[chosen.record_id,cutoffRecord.record_id]
 }:null;
 for(const window of Object.values(windows)){
  window.result_basis='OBSERVED_MOVEMENTS_NOT_A_CUTOFF_PRICE_CLAIM';
  window.cutoff_result=window.result&&cutoffRecord?{
   calculation_version:CALCULATION_VERSION,
   first:window.result.first,last:cutoffPoint,
   absolute_change:cutoffRecord.odds_decimal-window.result.first.price,
   percentage_change:100*(cutoffRecord.odds_decimal/window.result.first.price-1),
   used_record_ids:[window.result.first.record_id,cutoffRecord.record_id]
  }:null;
  window.cutoff_exclusion_reason=window.result?
   cutoffReason:window.exclusion_reason;
 }
 return {
  calculation_version:CALCULATION_VERSION,series_id:identities[0]||null,
  analysis_cutoff:cutoff,analysis_mode:mode,
  beginnings,selected_start_type:chosenType,
  cutoff_price:cutoffPoint,
  cutoff_price_exclusion_reason:cutoffReason,
  cutoff_price_source_age_seconds:cutoffRecord?.source_timestamp?
   (cutoffMs-Date.parse(cutoffRecord.source_timestamp))/1000:null,
  cutoff_price_observation_age_seconds:cutoffRecord?
   (cutoffMs-Date.parse(cutoffRecord.observed_at))/1000:null,
  cutoff_change:cutoffChange,
  since_start_basis:'OBSERVED_MOVEMENTS_NOT_A_CUTOFF_PRICE_CLAIM',

  since_start:chosen?stats(accepted.filter(r=>
   Date.parse(r.source_timestamp||r.observed_at)>=
   Date.parse(chosen.source_timestamp||chosen.observed_at)),cutoff):null,
  windows,used_record_ids:accepted.map(r=>r.record_id),
  excluded_records:excluded,
  history_range:{
   earliest_verified_timestamp:histories[0]?.source_timestamp||null,
   latest_verified_timestamp:histories.at(-1)?.source_timestamp||null,
   complete_history_guaranteed:false
  },
  collection_gaps:[],
  collection_gap_assessment:'REQUIRES_COLLECTION_RUN_AUDIT'
 };
}
module.exports={CALCULATION_VERSION,summarizeSeries};
