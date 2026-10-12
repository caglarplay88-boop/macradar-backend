
'use strict';
const {eligibleAtCutoff}=require('./sourceTime');
const {calculateQuoteGroup}=require('./groupCalculation');
const DEFAULT_THRESHOLDS={
 maxSourceAgeSeconds:300,maxObservationAgeSeconds:300,
 maxSourceTimeSkewSeconds:0,maxGapMultiple:2,
 minimumOverround:-0.05,maximumOverround:0.30
};
const critical=new Set([
 'INVALID_DECIMAL_PRICE','SELECTION_UNRESOLVED','BOOKMAKER_ID_UNRESOLVED',
 'PERIOD_UNVERIFIED','PRE_MATCH_SCOPE_UNVERIFIED','ASIAN_HOME_SIGN_UNVERIFIED',
 'SOURCE_LINE_UNRESOLVED','SOURCE_LINE_CONFLICT','INVALID_TOTAL_LINE',
 'SOURCE_TIME_INVALID','SOURCE_TIMEZONE_UNVERIFIED','SOURCE_YEAR_UNVERIFIED',
 'EXCHANGE_PRICE_TYPE_UNVERIFIED','PRICE_TYPE_UNVERIFIED',
 'OBSERVED_AFTER_CUTOFF','SOURCE_TIME_AFTER_CUTOFF',
 'AT_OR_AFTER_VERIFIED_KICKOFF','LIVE_RECORD',
 'OBSERVATION_TIME_INVALID','HISTORY_TIME_UNVERIFIED','SOURCE_TIME_FORMAT_UNKNOWN'
]);
function reviewQuality(raw,{
 cutoff,mode='strict_as_of',verifiedKickoff=null,runs=[],thresholds={}
}){
 const config={...DEFAULT_THRESHOLDS,...thresholds};
 for(const key of Object.keys(config)){
  if(!(key in DEFAULT_THRESHOLDS)||!Number.isFinite(config[key])){
   throw Error('INVALID_QUALITY_THRESHOLD:'+key);
  }
 }
 for(const key of ['maxSourceAgeSeconds','maxObservationAgeSeconds',
  'maxSourceTimeSkewSeconds','maxGapMultiple']){
  if(config[key]<0) throw Error('NEGATIVE_QUALITY_THRESHOLD:'+key);
 }
 if(config.minimumOverround>config.maximumOverround){
  throw Error('INVALID_OVERROUND_LIMITS');
 }
 const records=JSON.parse(JSON.stringify(raw));
 const byId=new Map(records.map(r=>[r.record_id,r]));
 const add=(record,flag)=>{
  record.quality_flags=[...new Set([...(record.quality_flags||[]),flag])];
 };
 const cutoffMs=Date.parse(cutoff);
 const kickoffMs=verifiedKickoff==null?null:Date.parse(verifiedKickoff);
 if(verifiedKickoff!=null&&(
  !Number.isFinite(kickoffMs)||!/(?:Z|[+-]\d{2}:\d{2})$/.test(verifiedKickoff)
 )) throw Error('VERIFIED_KICKOFF_TIME_INVALID');
 const gaps=[];
 for(const run of runs){
  const expected=run.expected_interval_seconds;
  if(Number.isFinite(expected)&&expected>0&&
     run.seconds_since_previous_success>expected*config.maxGapMultiple){
   gaps.push({
    run_id:run.run_id,seconds_since_previous_success:run.seconds_since_previous_success,
    expected_interval_seconds:expected,threshold_multiple:config.maxGapMultiple,
    reason:'COLLECTION_GAP',price_continuity_known:false
   });
  }
 }
 for(const record of records){
  for(const reason of eligibleAtCutoff(record,cutoff,mode).reasons) add(record,reason);
  if(!Number.isFinite(record.odds_decimal)||record.odds_decimal<=1){
   add(record,'INVALID_DECIMAL_PRICE');
  }
  const observed=Date.parse(record.observed_at);
  const source=record.source_timestamp?Date.parse(record.source_timestamp):null;
  if(source!==null&&Number.isFinite(source)&&
     (cutoffMs-source)/1000>config.maxSourceAgeSeconds){
   add(record,'SOURCE_PRICE_STALE');
  }
  if(mode==='strict_as_of'&&
     (cutoffMs-observed)/1000>config.maxObservationAgeSeconds){
   add(record,'OBSERVATION_STALE');
  }
  if(kickoffMs!==null&&
     (observed>=kickoffMs||(source!==null&&source>=kickoffMs))){
   add(record,'AT_OR_AFTER_VERIFIED_KICKOFF');
  }
  if(record.period!=='FULL_TIME_90') add(record,'PERIOD_UNVERIFIED');
  if(record.is_live===true) add(record,'LIVE_RECORD');
  if(gaps.some(g=>g.run_id===record.snapshot_id)) add(record,'COLLECTION_GAP');
 }
 const sameTime=new Map(),groups=new Map(),neighbors=new Map(),contexts=new Map();
 for(const record of records){
  if(record.source_timestamp&&Number.isFinite(record.odds_decimal)){
   const key=JSON.stringify([record.series_id,record.source_timestamp]);
   if(!sameTime.has(key)) sameTime.set(key,[]);
   sameTime.get(key).push(record);
  }
  if(record.quote_group_id){
   if(!groups.has(record.quote_group_id)) groups.set(record.quote_group_id,[]);
   groups.get(record.quote_group_id).push(record);
  }
  const base=JSON.stringify([
   record.event_id,record.source,record.bookmaker_id,record.market,
   record.period,record.line,record.selection,record.price_type
  ]);
  if(!contexts.has(base)) contexts.set(base,[]);
  contexts.get(base).push(record);
  if(['OU','ASIAN'].includes(record.market)&&record.status==='OPEN'&&
     record.main_analysis_eligible===true&&Number.isFinite(record.line)&&
     record.source_timestamp&&Number.isFinite(record.odds_decimal)){
   const key=JSON.stringify([
    record.event_id,record.source,record.bookmaker_id,record.source_context_id,
    record.market,record.period,record.selection,record.price_type,
    record.source_timestamp
   ]);
   if(!neighbors.has(key)) neighbors.set(key,[]);
   neighbors.get(key).push(record);
  }
 }
 for(const same of sameTime.values()){
  if(new Set(same.map(r=>r.odds_decimal)).size>1){
   for(const record of same) add(record,'SAME_IDENTITY_REPORTED_TIME_PRICE_CONFLICT');
  }
 }
 for(const timeline of contexts.values()){
  timeline.sort((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at));
  for(let i=1;i<timeline.length;i++){
   if(timeline[i].source_context_id!==timeline[i-1].source_context_id){
    add(timeline[i],'SOURCE_CONTEXT_TRANSITION');
   }
  }
 }
 const groupReviews=[];
 for(const [id,group] of groups){
  const calculation=calculateQuoteGroup(group,{
   cutoff,mode,maxAgeSeconds:config.maxSourceAgeSeconds,
   maxSourceTimeSkewSeconds:config.maxSourceTimeSkewSeconds
  });
  if(calculation.exclusion_reasons.includes('INCOMPLETE_OR_DUPLICATE_SELECTIONS')){
   group.forEach(r=>add(r,'INCOMPLETE_PRICE_GROUP'));
  }
  if(calculation.exclusion_reasons.includes('SOURCE_TIMES_OUTSIDE_COMPARABILITY_LIMIT')){
   group.forEach(r=>add(r,'INCOMPATIBLE_GROUP_SOURCE_TIMES'));
  }
  const overround=calculation.calculation?.overround;
  if(overround!=null&&(
   overround<config.minimumOverround||overround>config.maximumOverround
  )){
   group.forEach(r=>add(r,'UNUSUAL_OVERROUND'));
  }
  groupReviews.push({quote_group_id:id,...calculation});
 }
 const neighborReviews=[];
 for(const candidates of neighbors.values()){
  const sorted=candidates.sort((a,b)=>a.line-b.line);
  for(let i=1;i<sorted.length;i++){
   const lower=sorted[i-1],higher=sorted[i];
   if(lower.line===higher.line) continue;
   const risingExpected=(lower.market==='OU'&&lower.selection==='OVER')||
    (lower.market==='ASIAN'&&lower.selection==='AWAY');
   const reversed=risingExpected?
    higher.odds_decimal<lower.odds_decimal:
    higher.odds_decimal>lower.odds_decimal;
   if(reversed){
    add(lower,'COMPARABLE_NEIGHBOR_LINE_PRICE_ORDER_REVIEW');
    add(higher,'COMPARABLE_NEIGHBOR_LINE_PRICE_ORDER_REVIEW');
    neighborReviews.push({
     raw_record_ids:[lower.record_id,higher.record_id],
     source_timestamp:lower.source_timestamp,
     flag:'COMPARABLE_NEIGHBOR_LINE_PRICE_ORDER_REVIEW',
     manipulation_proven:false,price_correction_applied:false
    });
   }
  }
 }
 let readable=0,eligible=0,suspicious=0;
 const flags={};
 for(const record of records){
  const technical=Number.isFinite(record.odds_decimal)&&record.odds_decimal>1&&
   Boolean(record.event_id)&&Boolean(record.market)&&Boolean(record.selection);
  if(technical) readable++;
  record.historical_movement_eligible=record.main_analysis_eligible===true&&
   ['OPEN','SUSPENDED','CLOSED'].includes(record.status)&&
   !record.quality_flags.some(f=>critical.has(f));
  record.main_analysis_eligible=record.historical_movement_eligible&&
   record.status==='OPEN';
  record.cutoff_price_eligible=record.main_analysis_eligible&&
    !record.quality_flags.some(f=>
     f==='SOURCE_PRICE_STALE'||f==='OBSERVATION_STALE');
   record.eligibility_basis={
    historical_movement:'IDENTITY_SCOPE_TIME_AND_PRICE_VALIDITY',
    cutoff_price:'HISTORICAL_VALIDITY_PLUS_CONFIGURED_FRESHNESS'
   };
   if(record.main_analysis_eligible) eligible++;
  if(record.quality_flags.length) suspicious++;
  for(const flag of record.quality_flags) flags[flag]=(flags[flag]||0)+1;
 }
 return {
  odds_raw:records,
  quality:{
   version:'betexplorer-quality-v3',analysis_cutoff:cutoff,analysis_mode:mode,
   thresholds:config,threshold_basis:'CONFIGURABLE_PROGRAM_SETTINGS',
   counts:{raw_records:records.length,technically_readable:readable,
    main_analysis_eligible:eligible,flagged_records:suspicious},
   flag_counts:flags,collection_gaps:gaps,
   group_reviews:groupReviews,neighbor_line_reviews:neighborReviews,
   raw_records_deleted:0,prices_corrected:0,
   suspicion_is_manipulation_proof:false
  }
 };
}
module.exports={DEFAULT_THRESHOLDS,reviewQuality};
