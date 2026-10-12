
'use strict';
const crypto=require('node:crypto');
function historyRepeatKey(record,evidence){
 if(!['source_opening','source_history'].includes(record.record_origin)||
    !record.series_id||!Array.isArray(evidence?.response_rows)||
    !Number.isInteger(record.raw_evidence_row_index)) return null;
 return crypto.createHash('sha256').update(JSON.stringify([
  record.series_id,record.source_url,evidence.response_rows,
  record.raw_evidence_row_index,record.record_origin,record.opening_type,
  record.source_timestamp,record.source_timezone,record.timestamp_precision,
  record.year_resolution,record.status,record.price_type,
  record.main_analysis_eligible,record.quality_flags
 ])).digest('hex');
}
function remapIds(value,aliases){
 if(typeof value==='string') return aliases[value]||value;
 if(Array.isArray(value)) return value.map(x=>remapIds(x,aliases));
 if(value&&typeof value==='object'){
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remapIds(v,aliases)]));
 }
 return value;
}
module.exports={historyRepeatKey,remapIds};
