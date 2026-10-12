'use strict';
const FIELDS={
 '1X2':{HOME:'home_odd',DRAW:'draw_odd',AWAY:'away_odd'},
 OU:{OVER:'over_odd',UNDER:'under_odd'},
 ASIAN:{HOME:'home_odd',AWAY:'away_odd'},
 KG:{YES:'yes_odd',NO:'no_odd'}
};
function projectQuotes(state){
 const records=Array.isArray(state.odds_raw)?
  state.odds_raw:Object.values(state.odds_raw||{});
 const byId=new Map(records.map(r=>[r.record_id,r]));
 const odds=Object.fromEntries(Object.keys(FIELDS).map(m=>[m,[]]));
 const exclusions=[];
 for(const group of state.quote_groups||[]){
  const ids=group.raw_record_ids||[];
  const rows=ids.map(id=>byId.get(id));
  const reject=reason=>exclusions.push({
   quote_group_id:group.quote_group_id,raw_record_ids:ids,reason
  });
  if(!rows.length||rows.some(r=>!r)){
   reject('GROUP_RECORD_MISSING');continue;
  }
  const first=rows[0],fields=FIELDS[first.market];
  if(!fields){reject('MARKET_UNSUPPORTED');continue;}
  const identity=r=>JSON.stringify([
   r.event_id,r.source,r.source_context_id,r.bookmaker_id,
   r.market,r.period,r.line,r.price_type,r.snapshot_id
  ]);
  if(rows.some(r=>identity(r)!==identity(first)||
     r.quote_group_id!==group.quote_group_id||
     r.record_origin!=='scraper_observation')){
   reject('GROUP_IDENTITY_OR_ORIGIN_MISMATCH');continue;
  }
  const selections=rows.map(r=>r.selection);
  if(new Set(selections).size!==rows.length||
     selections.some(s=>!fields[s])){
   reject('SELECTION_DUPLICATE_OR_UNRESOLVED');continue;
  }
  const times=rows.map(r=>Date.parse(r.observed_at));
  if(times.some(t=>!Number.isFinite(t))){
   reject('OBSERVATION_TIME_INVALID');continue;
  }
  const projected={
   event_id:first.event_id,market:first.market,bookmaker_id:first.bookmaker_id,
   bookmaker_name:first.bookmaker_name,
   source_context_id:first.source_context_id,period:first.period,
   price_type:first.price_type,snapshot_id:first.snapshot_id,
   quote_group_id:group.quote_group_id,
   source_group_id:group.source_group_id??null,
   captured_at:new Date(Math.max(...times)).toISOString(),
   captured_at_basis:'FETCH_OBSERVATION_TIME',
   capture_sequence:first.snapshot_id,capture_type:'current',
   source_name:first.source,source_region:null,
   raw_record_ids:[...ids],selection_statuses:{},
   source_timestamp_by_selection:{},
   quality_flags:[...new Set(rows.flatMap(r=>r.quality_flags||[]))],
   main_analysis_eligible:rows.length===Object.keys(fields).length&&
    rows.every(r=>r.main_analysis_eligible===true),
   simultaneous_source_updates_verified:
    group.simultaneous_source_updates_verified===true
  };
  for(const [selection,field] of Object.entries(fields)){
   const r=rows.find(r=>r.selection===selection);
   projected[field]=r&&Number.isFinite(r.odds_decimal)&&r.odds_decimal>1?
    r.odds_decimal:null;
   projected[field.replace(/_odd$/,'_closed')]=
    !r||r.status==='UNKNOWN'?null:r.status==='CLOSED';
   projected.selection_statuses[selection]=r?.status??'MISSING';
   projected.source_timestamp_by_selection[selection]=r?.source_timestamp??null;
  }
  if(first.market==='OU') projected.total_line=first.line;
  if(first.market==='ASIAN'){
   const home=rows.find(r=>r.selection==='HOME');
   const away=rows.find(r=>r.selection==='AWAY');
   projected.source_line=first.line;
   const verified=Number.isFinite(home?.home_handicap)&&
    Number.isFinite(away?.away_handicap)&&
    home.home_handicap===-away.away_handicap;
   projected.handicap_line=verified?home.home_handicap:null;
   if(!verified) projected.quality_flags.push('ASIAN_HOME_SIGN_UNVERIFIED');
  }
  odds[first.market].push(projected);
 }
 return {odds,exclusions};
}
module.exports={projectQuotes};
