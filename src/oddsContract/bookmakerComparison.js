
'use strict';
function compareBookmakers({
 records,summaries,sourceContexts={},maxEndpointSkewSeconds=300
}){
 if(!Number.isFinite(maxEndpointSkewSeconds)||maxEndpointSkewSeconds<0){
  throw Error('INVALID_COMPARISON_TIME_SKEW');
 }
 const byId=new Map(records.map(r=>[r.record_id,r]));
 const buckets=new Map();
 for(const summary of summaries){
  const representative=records.find(r=>r.series_id===summary.series_id);
  if(!representative) continue;
  const context=sourceContexts[representative.source_context_id];
  const comparisonContext=context?.parent_source_context_id?
   JSON.stringify([context.parent_source_context_id,
    context.source_row_context?.origin_id_raw??null]):
   representative.source_context_id;
  for(const [name,window] of Object.entries(summary.windows||{})){
   const pair=window.cutoff_result;
   const first=pair?byId.get(pair.first.record_id):null;
   const last=pair?byId.get(pair.last.record_id):null;
   const timeBasis=pair?.first.time_basis||'UNVERIFIED';
   const identity={
    event_id:representative.event_id,source:representative.source,
    comparison_context_id:comparisonContext,
    market:representative.market,period:representative.period,
    line:representative.line,selection:representative.selection,
    price_type:representative.price_type,window:name,
    starts_at:window.starts_at,ends_at:window.ends_at,time_basis:timeBasis
   };
   const key=JSON.stringify(identity);
   if(!buckets.has(key)) buckets.set(key,{
    identity,candidates:[],excluded:[]
   });
   const bucket=buckets.get(key);
   const reasons=[];
   if(!pair) reasons.push(window.cutoff_exclusion_reason||'WINDOW_PRICE_PAIR_UNAVAILABLE');
   if(!comparisonContext) reasons.push('SOURCE_CONTEXT_UNVERIFIED');
   if(!representative.bookmaker_id) reasons.push('BOOKMAKER_ID_UNRESOLVED');
   if(!first||!last) reasons.push('RAW_RECORD_LINK_UNAVAILABLE');
   if(first&&last){
    if(first.series_id!==last.series_id) reasons.push('MIXED_SERIES');
    if(first.main_analysis_eligible!==true||
       last.cutoff_price_eligible!==true) reasons.push('PRICE_PAIR_INELIGIBLE');
    if(first.price_type==='UNKNOWN'||last.price_type==='UNKNOWN'){
     reasons.push('PRICE_TYPE_UNVERIFIED');
    }
    if(pair.first.time_basis!==pair.last.time_basis){
     reasons.push('MIXED_TIME_BASES');
    }
    const a=Date.parse(pair.first.effective_time);
    const b=Date.parse(pair.last.effective_time);
    if(!Number.isFinite(a)||!Number.isFinite(b)){
     reasons.push('TIME_UNVERIFIED');
    }
    if(a>Date.parse(window.starts_at)||b>Date.parse(window.ends_at)){
     reasons.push('PRICE_AFTER_WINDOW_BOUNDARY');
    }
   }
   const candidate={
    bookmaker_id:representative.bookmaker_id,
    bookmaker_name:representative.bookmaker_name,
    series_id:summary.series_id,
    source_context_id:representative.source_context_id,
    raw_record_ids:pair?[pair.first.record_id,pair.last.record_id]:[],
    first:pair?.first||null,last:pair?.last||null,
    absolute_change:pair?.absolute_change??null,
    percentage_change:pair?.percentage_change??null
   };
   if(reasons.length) bucket.excluded.push({...candidate,reasons:[...new Set(reasons)]});
   else bucket.candidates.push(candidate);
  }
 }
 const result=[];
 for(const bucket of buckets.values()){
  const counts=new Map();
  for(const item of bucket.candidates){
   counts.set(item.bookmaker_id,(counts.get(item.bookmaker_id)||0)+1);
  }
  let accepted=bucket.candidates.filter(item=>{
   if(counts.get(item.bookmaker_id)===1) return true;
   bucket.excluded.push({...item,reasons:['AMBIGUOUS_MULTIPLE_SERIES_FOR_BOOKMAKER']});
   return false;
  });
  const times=field=>accepted.map(x=>Date.parse(x[field].effective_time));
  const skew=values=>values.length?(Math.max(...values)-Math.min(...values))/1000:0;
  const firstSkew=skew(times('first')),lastSkew=skew(times('last'));
  if(firstSkew>maxEndpointSkewSeconds||lastSkew>maxEndpointSkewSeconds){
   bucket.excluded.push(...accepted.map(x=>({
    ...x,reasons:['COMPARISON_ENDPOINT_TIME_SKEW_EXCEEDED']
   })));
   accepted=[];
  }
  const rising=accepted.filter(x=>x.absolute_change>0);
  const falling=accepted.filter(x=>x.absolute_change<0);
  const unchanged=accepted.filter(x=>x.absolute_change===0);
  const values=accepted.map(x=>x.percentage_change).sort((a,b)=>a-b);
  const middle=Math.floor(values.length/2);
  const median=values.length<2?null:
   values.length%2?values[middle]:(values[middle-1]+values[middle])/2;
  result.push({
   ...bucket.identity,
   calculation_version:'betexplorer-basic-bookmaker-comparison-v1',
   comparison_basis:'ALIGNED_WINDOW_PRICE_MOVEMENT',
   max_endpoint_skew_seconds:maxEndpointSkewSeconds,
   observed_first_endpoint_skew_seconds:firstSkew,
   observed_last_endpoint_skew_seconds:lastSkew,
   rising:{count:rising.length,bookmakers:rising},
   falling:{count:falling.length,bookmakers:falling},
   unchanged:{count:unchanged.length,bookmakers:unchanged},
   excluded:bucket.excluded,
   median_percentage_change:median,
   sample_coverage:{
    included_bookmakers:accepted.length,
    excluded_series:bucket.excluded.length,
    median_minimum_bookmakers:2,
    entire_market_coverage_claimed:false
   },
   raw_series_merged:false,first_mover_ranking_produced:false,
   different_opening_dates_compared_as_simultaneous:false
  });
 }
 return result;
}
module.exports={compareBookmakers};
