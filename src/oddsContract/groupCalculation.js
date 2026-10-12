
'use strict';
const {CALCULATION_VERSION}=require('./seriesSummary');
const {eligibleAtCutoff}=require('./sourceTime');
const SELECTIONS={
 '1X2':['HOME','DRAW','AWAY'],OU:['UNDER','OVER'],
 ASIAN:['HOME','AWAY'],KG:['YES','NO']
};
function calculateQuoteGroup(records,{
 cutoff,mode='strict_as_of',reconstructed=false,
 maxAgeSeconds=300,maxSourceTimeSkewSeconds=0
}={}){
 if(!Number.isFinite(maxAgeSeconds)||maxAgeSeconds<0||
    !Number.isFinite(maxSourceTimeSkewSeconds)||maxSourceTimeSkewSeconds<0){
  throw Error('INVALID_GROUP_TIME_LIMIT');
 }
 const reasons=[],exclusions=[];
 const first=records[0];
 const expected=SELECTIONS[first?.market]||[];
 const shared=[
  'event_id','source','bookmaker_id','source_context_id',
  'market','period','line','price_type'
 ];
 if(!first||!expected.length) reasons.push('UNSUPPORTED_OR_EMPTY_GROUP');
 const identities=records.map(record=>JSON.stringify(
  shared.map(key=>record[key]??null)));
 if(new Set(identities).size>1) reasons.push('INCOMPATIBLE_GROUP_IDENTITY');
 if(records.length!==expected.length||
    expected.some(selection=>records.filter(r=>r.selection===selection).length!==1)){
  reasons.push('INCOMPLETE_OR_DUPLICATE_SELECTIONS');
 }
 if(!reconstructed && (
  new Set(records.map(r=>r.quote_group_id)).size!==1 ||
  !records.every(r=>r.quote_group_id) ||
  new Set(records.map(r=>r.snapshot_id)).size!==1 ||
  new Set(records.map(r=>r.observed_at)).size!==1
 )){
  reasons.push('NOT_A_SINGLE_OBSERVED_QUOTE_GROUP');
 }
 const cutoffMs=Date.parse(cutoff);
 const ages=[];
 for(const record of records){
  const denied=[...eligibleAtCutoff(record,cutoff,mode).reasons];
  if(record.main_analysis_eligible!==true) denied.push('MAIN_ANALYSIS_INELIGIBLE');
  if(record.status!=='OPEN') denied.push('PRICE_NOT_VERIFIED_OPEN');
  if(!Number.isFinite(record.odds_decimal)||record.odds_decimal<=1){
   denied.push('INVALID_DECIMAL_PRICE');
  }
  if(!['SPORTSBOOK','EXCHANGE_BACK','EXCHANGE_LAY'].includes(record.price_type)){
   denied.push('PRICE_TYPE_UNVERIFIED');
  }
  if(!record.source_timestamp || !Number.isFinite(Date.parse(record.source_timestamp))){
   denied.push('SOURCE_TIME_UNVERIFIED');
  }
  const sourceAge=record.source_timestamp?
   (cutoffMs-Date.parse(record.source_timestamp))/1000:null;
  const observationAge=(cutoffMs-Date.parse(record.observed_at))/1000;
  if(sourceAge!==null&&(sourceAge<0||sourceAge>maxAgeSeconds)){
   denied.push('SOURCE_PRICE_OUTSIDE_AGE_LIMIT');
  }
  if(mode==='strict_as_of'&&
     (observationAge<0||observationAge>maxAgeSeconds)){
   denied.push('OBSERVATION_OUTSIDE_AGE_LIMIT');
  }
  ages.push({
   record_id:record.record_id,selection:record.selection,
   source_age_seconds:sourceAge,observation_age_seconds:observationAge
  });
  if(denied.length) exclusions.push({
   record_id:record.record_id,reasons:[...new Set(denied)]
  });
 }
 const times=records.filter(r=>r.source_timestamp)
  .map(r=>Date.parse(r.source_timestamp)).filter(Number.isFinite);
 if(times.length===records.length&&times.length&&
    (Math.max(...times)-Math.min(...times))/1000>maxSourceTimeSkewSeconds){
  reasons.push('SOURCE_TIMES_OUTSIDE_COMPARABILITY_LIMIT');
 }
 if(exclusions.length) reasons.push('EXCLUDED_SIDE_RECORDS');
 const base={
  calculation_version:CALCULATION_VERSION,
  analysis_cutoff:cutoff,analysis_mode:mode,
  reconstructed:reconstructed===true,
  grouping_basis:reconstructed?'EXPLICIT_CARRY_FORWARD':
   'SAME_FETCHED_SOURCE_TABLE_ROW',
  raw_record_ids:records.map(r=>r.record_id),
  quote_group_ids:[...new Set(records.map(r=>r.quote_group_id))],
  snapshot_ids:[...new Set(records.map(r=>r.snapshot_id))],
  time_basis:'VERIFIED_SOURCE_TIME_WITH_OBSERVATION_CUTOFF',
  max_age_seconds:maxAgeSeconds,
  max_source_time_skew_seconds:maxSourceTimeSkewSeconds,
  side_ages:ages,
  exclusion_reasons:[...new Set(reasons)],
  excluded_records:exclusions,
  value_label:'normalize fiyat payı',
  winning_probability_claimed:false,
  bookmaker_profit_claimed:false,
  interpretation_notes:['OU ve Asian çizgilerinde iade ve yarım sonuçlar olabilir; fiyat payları kazanma olasılığı değildir.']
 };
 if(reasons.length) return {...base,calculation:null};
 const reciprocal=records.map(r=>({
  selection:r.selection,record_id:r.record_id,q:1/r.odds_decimal
 }));
 const total=reciprocal.reduce((sum,row)=>sum+row.q,0);
 return {...base,calculation:{
  Q:total,overround:total-1,
  selections:reciprocal.map(row=>({
   ...row,normalized_price_share:row.q/total
  }))
 }};
}
module.exports={calculateQuoteGroup};
