
'use strict';
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {parseArchiveResponse,archiveUrl,failedArchiveCoverage}=
 require('../../src/oddsContract/archiveParser');
const folder=process.argv[2];
const parent={record_id:'parent',series_id:'series',
 source_context_id:'context',event_id:'0p1XkgIt',source:'BetExplorer',
 market:'1X2',selection:'HOME',period:'FULL_TIME_90',line:null,
 bookmaker_id:'16',bookmaker_name:'bet365',price_type:'UNKNOWN',
 quality_flags:['PERIOD_UNVERIFIED','PRICE_TYPE_UNVERIFIED'],
 scope_verified:false,raw_evidence_ref:'parent-evidence',
 source_identifiers:{archive_locator:{
  'data-oid':'actual-identifier','data-bid':'16','data-bt':'1',
  'data-sc':'2','data-hcp':'actual-context'
 }}};
const options={
 snapshotId:'archive-test',observedAt:'2026-10-11T12:30:00.000Z',
 captureStartedAt:'2026-10-11T12:29:00.000Z',
 captureFinishedAt:'2026-10-11T12:30:00.000Z',
 sourceUrl:'https://www.betexplorer.com/archive-odds/test/',
 openingLabelEvidenceRef:'source-script:create_odds_archive_table',
 time:{timezoneOffsetMinutes:0,timezoneVerified:true,
  timezoneEvidenceRef:'actual-controlled-timezone-comparison'}
};
let checked=0;
for(const name of [
 'history-1X2-0-response.json','history-1X2-1-response.json',
 'history-1X2-2-response.json','history-OU-0-response.json',
 'history-OU-1-response.json','timezone-KG-plus0-response.json'
]){
 const payload=JSON.parse(fs.readFileSync(path.join(folder,name),'utf8'));
 const result=parseArchiveResponse(payload,parent,options);
 assert.equal(result.odds_raw.length,payload.length);
 assert.equal(result.coverage.status,'opening_only');
 assert.equal(result.coverage.complete_history_guaranteed,false);
 for(const record of result.odds_raw){
  assert.equal(record.source_timestamp,null);
  assert.equal(record.observed_at,options.observedAt);
  assert.equal(record.quote_group_id,null);
  assert(record.quality_flags.includes('SOURCE_YEAR_UNVERIFIED'));
  assert(result.raw_evidence[record.raw_evidence_ref]);
  checked++;
 }
}
const movements=[
 {date:'22.09. 09:00',odd:'1.90',change:'-0.10'},
 {date:'22.09. 08:00',odd:'2.00',change:'+0.10'},
 {date:'22.09. 07:00',odd:'1.90',change:'0'}
];
const result=parseArchiveResponse(movements,parent,options);
assert.deepEqual(result.odds_raw.map(r=>r.odds_decimal),[1.9,2,1.9]);
assert.equal(result.coverage.status,'history_available');
assert.equal(result.odds_raw[2].opening_type,'source_reported_opening');
assert.equal(result.coverage.pagination_finished,null);
assert.equal(result.odds_raw[0].opening_type,null);
assert.equal(parseArchiveResponse([],parent,options).coverage.status,'unavailable');
assert.equal(failedArchiveCoverage(parent,{
 attemptedAt:options.observedAt,errorCode:'TIMEOUT'
}).status,'fetch_failed');
assert.equal(archiveUrl({...parent,source_identifiers:{}}),null);
assert(archiveUrl(parent).startsWith('https://www.betexplorer.com/archive-odds/'));
assert.throws(()=>parseArchiveResponse({},parent,options));
const invalid=parseArchiveResponse([{date:'bad',odd:'bad'}],parent,options);
assert.equal(invalid.odds_raw.length,1);
assert.equal(invalid.odds_raw[0].odds_decimal,null);
console.log('GERCEK_ARSIV_SATIRLARI_VE_ACILIS_ETIKETI: GECTI; satir='+checked);
console.log('TUM_ARA_SATIRLAR_ABA_EKSIK_YIL_VE_KAPSAM_AYRIMI: GECTI');
