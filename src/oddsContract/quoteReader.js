'use strict';
const {projectQuotes}=require('./quoteCompatibility');
const {AsyncLocalStorage}=require('node:async_hooks');
const quoteReadScope=new AsyncLocalStorage();
const fs=require('node:fs');
const readModels=new Map();
const modelProjections=new WeakMap();
const readModelStates=new WeakSet();
function fileVersion(filename){
 try{const s=fs.statSync(filename);return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join('|');}
 catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function compactReaderState(state){
 // API quotes need these fields; full evidence remains in the canonical store/export.
 const model={event_id:state.event_id,storage_version:state.storage_version,
  tracking:state.tracking,odds_raw:state.odds_raw,quote_groups:state.quote_groups,
  runs:state.runs,match_identity:state.match_identity,pending_run:state.pending_run};
 readModelStates.add(model);return model;
}

function withQuoteReadScope(operation){
 return quoteReadScope.run({states:new Map(),projections:new WeakMap()},operation);
}
function readRuntimeState(eventId){
 const id=String(eventId||'').trim();
 const scope=quoteReadScope.getStore();
 if(scope?.states.has(id)) return scope.states.get(id);
 const {getContractRuntime}=require('./runtime');
 const runtime=getContractRuntime();
 const filename=runtime.collector?.store?.file?.(id);
 const version=filename?fileVersion(filename):null;
 let state;
 const cached=filename&&readModels.get(filename);
 if(version&&cached?.version===version){
  state=cached.state;
  // LRU is bounded; a modified/renamed canonical file always invalidates it.
  readModels.delete(filename);readModels.set(filename,cached);
 }else{
  state=compactReaderState(runtime.readState(id));
  if(filename&&version&&fileVersion(filename)===version){
   readModels.set(filename,{version,state});
   while(readModels.size>2)readModels.delete(readModels.keys().next().value);
  }
 }

 if(scope) scope.states.set(id,state);
 return state;
}
function quoteProjection(state){
 const scope=quoteReadScope.getStore();
 if(!scope&&!readModelStates.has(state)) return projectQuotes(state);
 const projections=scope?.projections||modelProjections;
 if(!projections.has(state)) projections.set(state,projectQuotes(state));
 return projections.get(state);
}

function readQuoteBatch(state,market,{
 captureType='current',line=null,latestOnly=false
}={}){
 if(!['opening','current','periodic'].includes(captureType)){
  throw Error('INVALID_CAPTURE_TYPE');
 }
 if(!['1X2','OU','ASIAN','KG'].includes(market)) throw Error('INVALID_MARKET');
 const records=Array.isArray(state.odds_raw)?
  state.odds_raw:Object.values(state.odds_raw||{});
 if(!state.tracking?.initialized&&!records.length) return {handled:false};
 // Archive selections have no observed quote group. Never fabricate one.
 if(captureType==='opening') return {handled:true,batch:null};
 const projected=quoteProjection(state);
 let rows=[...projected.odds[market]];
 if(line!==null){
  const value=typeof line==='string'&&line.trim()===''?NaN:Number(line);
  if(!Number.isFinite(value)) throw Error('INVALID_LINE_FILTER');
  const field=market==='OU'?'total_line':'handicap_line';
  rows=rows.filter(r=>Number.isFinite(r[field])&&r[field]===value);
 }
 rows.sort((a,b)=>Date.parse(a.captured_at)-Date.parse(b.captured_at)||
  String(a.quote_group_id).localeCompare(String(b.quote_group_id)));
 if(latestOnly&&rows.length){
  const latest=rows.at(-1).snapshot_id;
  rows=rows.filter(r=>r.snapshot_id===latest);
 }else{
  const groups=new Map();
  for(const row of rows){
   const key=JSON.stringify([
    row.bookmaker_id,row.source_context_id,row.period,row.price_type,
    market==='OU'?row.total_line:market==='ASIAN'?row.source_line:null,
    ['OU','ASIAN'].includes(market)&&
     !Number.isFinite(market==='OU'?row.total_line:row.source_line)?
      row.quote_group_id:null
   ]);
   groups.set(key,row);
  }
  rows=[...groups.values()];
 }
 if(!rows.length) return {handled:true,batch:null};
 const newest=rows.reduce((a,b)=>
  Date.parse(a.captured_at)>=Date.parse(b.captured_at)?a:b);
 const lastRun=(state.runs||[]).at(-1)||null;
 return {handled:true,batch:{
  capture_sequence:newest.snapshot_id,capture_type:captureType,
  captured_at:newest.captured_at,source_name:newest.source_name,
  source_region:null,rows,data_origin:'CONTRACT_RAW_QUOTE_GROUPS',
  last_scan_result:lastRun,projection_exclusions:projected.exclusions
 }};
}
function readRuntimeBatch(eventId,market,options){
 return readQuoteBatch(readRuntimeState(eventId),market,options);
}

function readQuoteHistory(state,market,{
 bookmaker=null,line=null,sourceLine=null,sourceContextId=undefined,
 period=undefined,priceType=undefined,page=1,pageSize=50
}={}){
 const raw=Array.isArray(state.odds_raw)?
  state.odds_raw:Object.values(state.odds_raw||{});
 if(!state.tracking?.initialized&&!raw.length){
  const scoped=sourceLine!==null||
   [sourceContextId,period,priceType].some(v=>v!==undefined);
  if(scoped) return {handled:true,history:{
   bookmaker_key:bookmaker,page:Math.max(1,Number(page)||1),
   page_size:Math.max(1,Math.min(300,Number(pageSize)||50)),
   total_records:0,total_pages:0,has_previous:false,has_next:false,
   rows:[],raw_records:[],archive_selections_grouped:false,
   compatibility_warnings:['LEGACY_CONTEXT_OR_SOURCE_LINE_FILTER_UNSUPPORTED']
  }};
  return {handled:false};
 }
 if(!['1X2','OU','ASIAN','KG'].includes(market)) throw Error('INVALID_MARKET');
 const normalize=value=>String(value??'').trim().toLowerCase()
  .replace(/[^a-z0-9]/g,'');
 const book=bookmaker===null?null:normalize(bookmaker);
 if(bookmaker!==null&&!book) throw Error('INVALID_BOOKMAKER');
 const wantedLine=line===null?null:Number(line);
 if(line!==null&&(String(line).trim()===''||!Number.isFinite(wantedLine))){
  throw Error('INVALID_LINE_FILTER');
 }
 const wantedSourceLine=sourceLine===null?null:Number(sourceLine);
 if(sourceLine!==null&&(market!=='ASIAN'||String(sourceLine).trim()===''||
    !Number.isFinite(wantedSourceLine))) throw Error('INVALID_SOURCE_LINE_FILTER');
 const matchIdentity=r=>
  (sourceContextId===undefined||r.source_context_id===sourceContextId)&&
  (period===undefined||r.period===period)&&
  (priceType===undefined||r.price_type===priceType);
 const safePage=Math.max(1,Math.min(100000,Math.floor(Number(page)||1)));
 const safeSize=Math.max(1,Math.min(300,Math.floor(Number(pageSize)||50)));
 const matchBook=r=>book===null||
  [r.bookmaker_id,r.bookmaker_key,r.bookmaker_name].some(v=>normalize(v)===book);
 const quotes=quoteProjection(state).odds[market].filter(r=>
  matchBook(r)&&matchIdentity(r)&&(wantedLine===null||
   (market==='OU'?r.total_line:r.handicap_line)===wantedLine)&&
  (wantedSourceLine===null||
   (r.source_line===wantedSourceLine&&r.handicap_line===null)));
 quotes.sort((a,b)=>Date.parse(b.captured_at)-Date.parse(a.captured_at)||
  String(a.quote_group_id).localeCompare(String(b.quote_group_id)));
 const records=raw.filter(r=>r.market===market&&matchBook(r)&&matchIdentity(r)&&
  (wantedLine===null||(market==='ASIAN'?r.home_handicap:r.line)===wantedLine)&&
  (wantedSourceLine===null||(r.line===wantedSourceLine&&r.home_handicap===null)));
 records.sort((a,b)=>Date.parse(b.observed_at)-Date.parse(a.observed_at)||
  String(a.record_id).localeCompare(String(b.record_id)));
 const offset=(safePage-1)*safeSize;
 const totalPages=Math.ceil(quotes.length/safeSize);
 return {handled:true,history:{
  bookmaker_key:book,page:safePage,page_size:safeSize,
  source_line:wantedSourceLine,handicap_line:market==='ASIAN'?wantedLine:null,
  total_line:market==='OU'?wantedLine:null,
  line_basis:wantedSourceLine!==null?'SOURCE_TABLE_LINE_HOME_SIGN_UNVERIFIED':
   wantedLine!==null?(market==='ASIAN'?'VERIFIED_HOME_HANDICAP':'GOAL_LINE'):'UNFILTERED_LINES',
  total_records:quotes.length,total_pages:totalPages,
  has_previous:safePage>1&&quotes.length>0,has_next:safePage<totalPages,
  rows:quotes.slice(offset,offset+safeSize).map(r=>({...r,id:r.quote_group_id})),
  data_origin:'CONTRACT_RAW_QUOTE_GROUPS',
  raw_records:records.slice(offset,offset+safeSize),
  raw_record_pagination:{
   total_records:records.length,total_pages:Math.ceil(records.length/safeSize),
   page:safePage,page_size:safeSize,
   has_next:offset+safeSize<records.length
  },
  archive_selections_grouped:false,
  last_scan_result:(state.runs||[]).at(-1)||null
 }};
}
function readRuntimeHistory(eventId,market,options){
 return readQuoteHistory(readRuntimeState(eventId),market,options);
}

function readSourceOpenings(state,market){
 if(!['1X2','OU','ASIAN','KG'].includes(market)) throw Error('INVALID_MARKET');
 const raw=Array.isArray(state.odds_raw)?state.odds_raw:Object.values(state.odds_raw||{});
 const handled=state.tracking?.initialized===true||raw.length>0;
 const latest=new Map();
 for(const record of raw){
  if(record.market!==market||record.record_origin!=='source_opening') continue;
  const key=record.series_id||JSON.stringify([
   record.event_id,record.source,record.bookmaker_id,record.source_context_id,
   record.market,record.period,record.line,record.selection,record.price_type
  ]);
  const previous=latest.get(key);
  const time=Date.parse(record.observed_at),oldTime=Date.parse(previous?.observed_at);
  if(!previous||(Number.isFinite(time)&&(!Number.isFinite(oldTime)||time>oldTime))||
   (time===oldTime&&String(record.record_id)>String(previous.record_id))){
   latest.set(key,record);
  }
 }
 return {handled,records:[...latest.values()],
  data_origin:'CONTRACT_SOURCE_OPENING_SELECTIONS',
  archive_selections_grouped:false,time_basis:'PER_SELECTION_SOURCE_TIMESTAMP',
  missing_reason:handled?(latest.size?null:'NO_SOURCE_OPENING_RECORDS'):'NO_CONTRACT_STATE'};
}
function readRuntimeSourceOpenings(eventId,market){
 return readSourceOpenings(readRuntimeState(eventId),market);
}


function historyIdentityFilters(url){
 const filters={};
 for(const [query,field] of [
  ['source_context_id','sourceContextId'],['period','period'],['price_type','priceType']
 ]){
  if(url.searchParams.has(query)){
   const value=url.searchParams.get(query);
   filters[field]=value==='unknown'?null:value;
  }
 }
 return filters;
}

module.exports={readRuntimeState,readQuoteBatch,readRuntimeBatch,readQuoteHistory,readRuntimeHistory,readSourceOpenings,readRuntimeSourceOpenings,withQuoteReadScope,historyIdentityFilters};

