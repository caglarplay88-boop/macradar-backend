
'use strict';
const crypto=require('node:crypto');
const {parseSourceCellTime}=require('./sourceTime');
const PARSER_VERSION='betexplorer-evidenced-current-v2';
const POSITIONS={
 '1X2':{'1':'HOME','0':'DRAW','2':'AWAY'},
 OU:{'1':'OVER','2':'UNDER'},
 ASIAN:{'1':'HOME','2':'AWAY'},
 KG:{y:'YES',n:'NO'}
};
const KEEP=new Set([
 'data-pos','data-odd','data-created','data-bid','data-bookmaker-id',
 'data-bookie-id','data-bookie','data-oid','data-bt','data-sc','data-hcp',
 'data-originid','data-exchange','data-opening-odd','data-opening-date','class'
]);
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function decode(value){
 return String(value||'').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'")
  .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')
  .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
}
function attributes(text){
 const output={};
 for(const m of String(text).matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)){
  output[m[1].toLowerCase()]=decode(m[3]);
 }
 return output;
}
function evidenceAttributes(attrs){
 return Object.fromEntries(Object.entries(attrs).filter(([key])=>KEEP.has(key)));
}
function number(value){
 if(value==null || String(value).trim()==='') return null;
 const text=String(value).trim().replace(',','.');
 return /^[+-]?\d+(?:\.\d+)?$/.test(text)?Number(text):null;
}

// Split labels are checked against numeric data-hcp in captured source rows.
function sourceLineNumber(text,market){
 const scalar=number(text);
 if(scalar!==null||market!=='ASIAN') return scalar;
 const split=String(text).trim().match(
  /^([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)$/
 );
 if(!split) return null;
 const first=Number(split[1]),second=Number(split[2]);
 if(!Number.isInteger(first*2)||!Number.isInteger(second*2)||
    Math.abs(first-second)!==0.5) return null;
 return (first+second)/2;
}

function plain(value){
 return decode(String(value).replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
}
function seriesIdentity(record){
 return hash([
  record.event_id,record.source,record.bookmaker_id,record.source_context_id,
  record.market,record.period,record.line,record.selection,record.price_type
 ]);
}
function parseCurrentResponse(html,options){
 const {market,eventId,sourceUrl,snapshotId,observedAt,
  captureStartedAt,captureFinishedAt,sourceContextId}=options;
 if(!POSITIONS[market]) throw Error('UNSUPPORTED_MARKET');
 for(const [key,value] of Object.entries({
  eventId,sourceUrl,snapshotId,observedAt,captureStartedAt,
  captureFinishedAt,sourceContextId
 })){
  if(typeof value!=='string'||!value) throw Error('MISSING_CAPTURE_FIELD:'+key);
 }
 for(const value of [observedAt,captureStartedAt,captureFinishedAt]){
  if(!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value))){
   throw Error('INVALID_CAPTURE_TIME');
  }
 }
 if(Date.parse(captureFinishedAt)<Date.parse(captureStartedAt) ||
    Date.parse(observedAt)<Date.parse(captureStartedAt) ||
    Date.parse(observedAt)>Date.parse(captureFinishedAt)){
  throw Error('CAPTURE_TIME_ORDER_INVALID');
 }
 const rows=[...String(html).matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)];
 const records=[],rawEvidence={},quoteGroups=[],sourceContexts={};
 const headers=[...String(html).matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
  .map(m=>plain(m[1]));
 for(let rowIndex=0;rowIndex<rows.length;rowIndex++){
  const row=rows[rowIndex],rowAttrs=attributes(row[1]);
  const cells=[...row[2].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)]
   .map(m=>({attrs:attributes(m[1]),text:plain(m[2])}));
  const prices=cells.filter(c=>'data-odd' in c.attrs || 'data-pos' in c.attrs);
  if(!prices.length) continue;
  const originId=(rowAttrs['data-originid']||'').trim()||null;
  const displayBookmakerId=String(rowAttrs['data-bookie-id']||
   prices[0].attrs['data-bookie-id']||'').trim()||null;
  const rowContext={
   ...(options.sourceContext||{}),
   parent_source_context_id:sourceContextId,
   source_row_context:{
    origin_id_raw:originId,
    display_bookmaker_id_raw:displayBookmakerId,
    identifier_meanings_verified:false
   }
  };
  const rowContextId='context-'+hash([sourceContextId,originId,displayBookmakerId]);
  sourceContexts[rowContextId]=rowContext;
  const lineCells=cells.filter(c=>
   /\btable-main__doubleparameter\b/.test(c.attrs.class||''));
  const textLines=lineCells.map(c=>sourceLineNumber(c.text,market)).filter(v=>v!==null);
  const hcpLines=prices.map(c=>{
   const raw=c.attrs['data-hcp']||'';
   const expected=market==='OU'?'2':market==='ASIAN'?'5':null;
   if(!expected) return null;
   const found=raw.match(new RegExp('^E-'+expected+'-\\d+-0-(-?\\d+(?:\\.\\d+)?)-0$'));
   return found?Number(found[1]):null;
  }).filter(v=>v!==null);
  const candidates=[...new Set([...textLines,...hcpLines])];
  const needsLine=market==='OU'||market==='ASIAN';
  const line=needsLine&&candidates.length===1?candidates[0]:null;
  const rowFlags=[];
  if(needsLine&&line===null) rowFlags.push(
   candidates.length>1?'SOURCE_LINE_CONFLICT':'SOURCE_LINE_UNRESOLVED');
  if(market==='OU'&&line!==null&&line<0) rowFlags.push('INVALID_TOTAL_LINE');
  if(options.periodVerified!==true) rowFlags.push('PERIOD_UNVERIFIED');
  if(!options.preMatchVerified) rowFlags.push('PRE_MATCH_SCOPE_UNVERIFIED');
  if(market==='ASIAN'&&!options.asianHomeSignVerified){
   rowFlags.push('ASIAN_HOME_SIGN_UNVERIFIED');
  }
  const evidenceId='evidence-'+hash([snapshotId,market,rowIndex]);
  const quoteGroupId='quote-'+hash([snapshotId,market,rowIndex]);
  const groupRecords=[];
  rawEvidence[evidenceId]={
   kind:'BETEXPLORER_PRICE_TABLE_ROW',parser_version:PARSER_VERSION,
   source_url:sourceUrl,source_context_id:rowContextId,
   snapshot_id:snapshotId,quote_group_id:quoteGroupId,
   fetched_at:observedAt,table_headers:headers,
   row_attributes:evidenceAttributes(rowAttrs),
   line_cells:lineCells.map(c=>({text:c.text,class:c.attrs.class||null})),
   price_cells:prices.map(c=>({
    attributes:evidenceAttributes(c.attrs),text:c.text
   }))
  };
  for(let cellIndex=0;cellIndex<prices.length;cellIndex++){
   const cell=prices[cellIndex],attrs=cell.attrs;
   const selection=POSITIONS[market][String(attrs['data-pos']||'').toLowerCase()]||null;
   const odds=number(attrs['data-odd']);
   const bookmakerId=attrs['data-bookmaker-id']||attrs['data-bid']||
    rowAttrs['data-bid']||null;
   const bookmakerName=attrs['data-bookie']||rowAttrs['data-bookie']||null;
   const flags=[...rowFlags];
   if(!selection) flags.push('SELECTION_UNRESOLVED');
   if(odds===null||odds<=1) flags.push('INVALID_DECIMAL_PRICE');
   if(!bookmakerId) flags.push('BOOKMAKER_ID_UNRESOLVED');
   if(!bookmakerName) flags.push('BOOKMAKER_NAME_MISSING');
   const inactive=/\binactive\b/.test(attrs.class||'');
   if(inactive) flags.push('SOURCE_INACTIVE_STATUS_UNRESOLVED');
   const exchange=rowAttrs['data-exchange']==='1'||attrs['data-exchange']==='1';
   const priceType=exchange?
    (options.exchangePriceTypeVerified===true &&
     ['EXCHANGE_BACK','EXCHANGE_LAY'].includes(options.exchangePriceType)?
       options.exchangePriceType:'UNKNOWN'):
    (options.sportsbookTypeVerified===true?'SPORTSBOOK':'UNKNOWN');
   if(priceType==='UNKNOWN') flags.push(
    exchange?'EXCHANGE_PRICE_TYPE_UNVERIFIED':'PRICE_TYPE_UNVERIFIED');
   const time=parseSourceCellTime(attrs['data-created'],{
    ruleVerified:options.cellTimeRuleVerified===true,
    evidenceRef:options.cellTimeEvidenceRef||null
   });
   flags.push(...time.quality_flags);
   const archiveKeys=['data-oid','data-bid','data-bt','data-sc','data-hcp'];
   const archiveLocator=archiveKeys.every(key=>Boolean(attrs[key]))?
    Object.fromEntries(archiveKeys.map(key=>[key,attrs[key]])):null;
   const record={
    record_id:'record-'+hash([snapshotId,market,rowIndex,cellIndex]),
    event_id:eventId,source:'BetExplorer',source_url:sourceUrl,
    source_context_id:rowContextId,
    bookmaker_id:String(bookmakerId||'')||null,bookmaker_name:bookmakerName,
    market,period:options.periodVerified===true?'FULL_TIME_90':null,selection,line,
    home_handicap:market==='ASIAN'&&options.asianHomeSignVerified?line:null,
    away_handicap:market==='ASIAN'&&options.asianHomeSignVerified&&line!==null?-line:null,
    odds_decimal:odds,status:'UNKNOWN',price_type:priceType,
    source_record_id:null,
    source_timestamp:time.source_timestamp,
    source_timestamp_raw:time.source_timestamp_raw,
    source_timezone:time.source_timezone,
    timestamp_precision:time.timestamp_precision,
    observed_at:observedAt,capture_started_at:captureStartedAt,
    capture_finished_at:captureFinishedAt,snapshot_id:snapshotId,
    quote_group_id:quoteGroupId,source_group_id:null,
    record_origin:'scraper_observation',opening_type:null,is_main_line:null,
    quality_flags:[...new Set(flags)],raw_evidence_ref:evidenceId,
    source_identifiers:{
     internal_bookmaker_id:attrs['data-bid']||rowAttrs['data-bid']||null,
     display_bookmaker_id:attrs['data-bookie-id']||rowAttrs['data-bookie-id']||null,
     archive_locator:archiveLocator
    },
    source_status_marker:inactive?'inactive':null,
    source_exchange_marker:exchange,
    scope_verified:options.periodVerified===true&&options.preMatchVerified===true,
    main_analysis_eligible:flags.length===0
   };
   record.series_id=seriesIdentity(record);
   records.push(record);groupRecords.push(record.record_id);
  }
  quoteGroups.push({
   quote_group_id:quoteGroupId,snapshot_id:snapshotId,
   raw_record_ids:groupRecords,source_group_id:null,
   grouping_basis:'SAME_FETCHED_SOURCE_TABLE_ROW',
   simultaneous_source_updates_verified:false,
   reconstructed:false
  });
 }
 return {parser_version:PARSER_VERSION,odds_raw:records,
  raw_evidence:rawEvidence,quote_groups:quoteGroups,source_contexts:sourceContexts};
}
module.exports={PARSER_VERSION,parseCurrentResponse,seriesIdentity};
