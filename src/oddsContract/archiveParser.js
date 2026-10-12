
'use strict';
const crypto=require('node:crypto');
const {parseArchiveTime}=require('./sourceTime');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PARSER_VERSION='betexplorer-evidenced-archive-v1';

function archiveUrl(record){
 const locator=record.source_identifiers?.archive_locator;
 const keys=['data-oid','data-bid','data-bt','data-sc','data-hcp'];
 if(!locator||!keys.every(key=>typeof locator[key]==='string'&&locator[key])){
  return null;
 }
 return 'https://www.betexplorer.com/archive-odds/'+
  keys.map(key=>encodeURIComponent(locator[key])).join('/')+'/';
}
function decimal(raw){
 if(raw==null||String(raw).trim()==='') return null;
 const text=String(raw).trim().replace(',','.');
 return /^\d+(?:\.\d+)?$/.test(text)?Number(text):null;
}
function captureTime(value){
 return typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&
  Number.isFinite(Date.parse(value));
}
function parseArchiveResponse(payload,parent,options){
 if(!Array.isArray(payload)) throw Error('ARCHIVE_RESPONSE_NOT_ARRAY');
 const {snapshotId,observedAt,captureStartedAt,captureFinishedAt,sourceUrl}=options;
 if(!snapshotId||!sourceUrl||
    ![observedAt,captureStartedAt,captureFinishedAt].every(captureTime)){
  throw Error('ARCHIVE_CAPTURE_METADATA_INVALID');
 }
 if(Date.parse(captureFinishedAt)<Date.parse(captureStartedAt)||
    Date.parse(observedAt)<Date.parse(captureStartedAt)||
    Date.parse(observedAt)>Date.parse(captureFinishedAt)){
  throw Error('ARCHIVE_CAPTURE_TIME_ORDER_INVALID');
 }
 const evidenceId='archive-evidence-'+hash([
  snapshotId,parent.series_id,sourceUrl,payload,observedAt
 ]);
 const rawEvidence={
  [evidenceId]:{
   kind:'BETEXPLORER_SELECTION_ARCHIVE',
   parser_version:PARSER_VERSION,source_url:sourceUrl,
   source_context_id:parent.source_context_id,
   parent_raw_record_id:parent.record_id,
   parent_raw_evidence_ref:parent.raw_evidence_ref,
   snapshot_id:snapshotId,fetched_at:observedAt,
   response_rows:payload.map(row=>({
    date:row?.date??null,odd:row?.odd??null,change:row?.change??null
   })),
   opening_label_basis:'SOURCE_UI_LABELS_LAST_RETURNED_ROW_OPENING',
   opening_label_evidence_ref:options.openingLabelEvidenceRef||null
  }
 };
 const records=payload.map((row,index)=>{
  const time=parseArchiveTime(row?.date,options.time||{});
  const price=decimal(row?.odd);
  const flags=(parent.quality_flags||[]).filter(flag=>
   !['SOURCE_TIME_FORMAT_UNKNOWN','SOURCE_TIME_INVALID',
     'SOURCE_TIMEZONE_UNVERIFIED','SOURCE_INACTIVE_STATUS_UNRESOLVED',
     'INVALID_DECIMAL_PRICE'].includes(flag));
  flags.push(...time.quality_flags);
  if(price===null||price<=1) flags.push('INVALID_DECIMAL_PRICE');
  const isLast=index===payload.length-1;
  const opening=isLast&&Boolean(options.openingLabelEvidenceRef);
  if(isLast&&!options.openingLabelEvidenceRef){
   flags.push('OPENING_LABEL_UNVERIFIED');
  }
  return {
   ...parent,
   record_id:'archive-record-'+hash([
    snapshotId,parent.series_id,index,row?.date,row?.odd,observedAt
   ]),
   source_url:sourceUrl,odds_decimal:price,status:'UNKNOWN',
   source_record_id:null,source_timestamp:time.source_timestamp,
   source_timestamp_raw:time.source_timestamp_raw,
   source_timezone:time.source_timezone,timestamp_precision:time.timestamp_precision,
   observed_at:observedAt,capture_started_at:captureStartedAt,
   capture_finished_at:captureFinishedAt,snapshot_id:snapshotId,
   quote_group_id:null,source_group_id:null,
   record_origin:opening?'source_opening':'source_history',
   opening_type:opening?'source_reported_opening':null,
   quality_flags:[...new Set(flags)],raw_evidence_ref:evidenceId,
   raw_evidence_row_index:index,
   source_status_marker:null,
   source_history_order_index:index,
   source_change_raw:row?.change??null,
   year_resolution:time.year_resolution,
   main_analysis_eligible:flags.length===0&&parent.scope_verified===true
  };
 });
 const known=records.filter(r=>r.source_timestamp).sort((a,b)=>
  Date.parse(a.source_timestamp)-Date.parse(b.source_timestamp));
 const opening=records.find(r=>r.opening_type==='source_reported_opening');
 return {
  parser_version:PARSER_VERSION,odds_raw:records,raw_evidence:rawEvidence,
  coverage:{
   series_id:parent.series_id,
   status:payload.length>1?'history_available':
    opening?'opening_only':payload.length===1?'history_available':'unavailable',
   fetch_success:true,returned_rows:payload.length,
   source_reported_opening_record_id:opening?.record_id||null,
   earliest_available_history_record_id:known[0]?.record_id||null,
   oldest_returned_record_id:records.at(-1)?.record_id||null,
   earliest_verified_source_timestamp:known[0]?.source_timestamp||null,
   latest_verified_source_timestamp:known.at(-1)?.source_timestamp||null,
   pagination_finished:null,
   pagination_evidence_ref:null,
   complete_history_guaranteed:false,
   known_limits:[
    'Coverage describes this selection archive response only.',
    'Last returned row is the source-labelled opening, not a guarantee of the bookmaker absolute first price.',
    ...(records.some(r=>!r.source_timestamp)?
     ['Some source times cannot be resolved without verified year/timezone evidence.']:[])
   ]
  }
 };
}
function failedArchiveCoverage(parent,{attemptedAt,errorCode}){
 return {
  series_id:parent.series_id,status:'fetch_failed',fetch_success:false,
  attempted_at:attemptedAt,error_code:errorCode,
  pagination_finished:null,complete_history_guaranteed:false
 };
}
module.exports={PARSER_VERSION,archiveUrl,parseArchiveResponse,failedArchiveCoverage};
