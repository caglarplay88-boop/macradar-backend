
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {StateStore}=require('../../src/oddsContract/stateStore');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'history-repeat-'));
try{
 const store=new StateStore(directory);
 const rows=[{date:'11.10. 10:00',odd:'2.0',change:'0'},
  {date:'11.10. 10:01',odd:'1.8',change:'-0.2'},
  {date:'11.10. 10:02',odd:'2.0',change:'+0.2'}];
 function capture(label,context='s',response=rows){
  const evidenceId='proof-'+label;
  return {
   evidence:{[evidenceId]:{response_rows:response}},
   records:response.map((row,index)=>({
    record_id:label+'-'+index,event_id:'e',series_id:context,
    source_url:'https://www.betexplorer.com/archive-odds/test/',
    raw_evidence_ref:evidenceId,raw_evidence_row_index:index,
    record_origin:'source_history',opening_type:null,
    source_timestamp:null,source_timezone:null,timestamp_precision:'minute',
    observed_at:label==='first'?'2026-10-11T10:05:00Z':'2026-10-11T11:05:00Z',
    snapshot_id:label,status:'UNKNOWN',price_type:'UNKNOWN',
    odds_decimal:Number(row.odd),main_analysis_eligible:false,
    quality_flags:['SOURCE_YEAR_UNVERIFIED']
   })),
   coverage:[{series_id:context,fetch_success:true,
    earliest_available_history_record_id:label+'-0'}]
  };
 }
 assert.equal(store.saveCapture('e',capture('first')).inserted,3);
 assert.equal(store.saveCapture('e',capture('second')).inserted,0);
 let state=store.read('e');
 assert.equal(Object.keys(state.odds_raw).length,3);
 assert.equal(state.odds_raw['first-0'].observed_at,'2026-10-11T10:05:00Z');
 assert.deepEqual(Object.values(state.odds_raw).map(r=>r.odds_decimal),[2,1.8,2]);
 assert.equal(state.archive_retrievals.length,6);
 assert(state.raw_evidence['proof-second']);
 assert.equal(state.coverage.s.last_success.earliest_available_history_record_id,'first-0');
 assert.equal(store.saveCapture('e',capture('other','different-context')).inserted,3);
 const changed=[...rows,{date:'11.10. 10:03',odd:'1.9',change:'-0.1'}];
 assert.equal(store.saveCapture('e',capture('changed','s',changed)).inserted,4);
 state=store.read('e');
 assert.equal(state.archive_retrievals.filter(r=>r.identical_response_repeat).length,3);
 console.log('AYNI_ARSIV_YANITI_TEK_KAYIT_ILK_GOZLEM_VE_TUM_KANITLAR: GECTI');
 console.log('ABA_FARKLI_BAGLAM_VE_BELIRSIZ_DEGISMIS_YANIT_KORUMA: GECTI');
}finally{fs.rmSync(directory,{recursive:true,force:true});}
