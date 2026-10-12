
'use strict';
const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path');
const {parseSourceCellTime,parseArchiveTime,eligibleAtCutoff}=
 require('../../src/oddsContract/sourceTime');
const verified={ruleVerified:true,evidenceRef:'source-script:my_tz_format'};
assert.equal(parseSourceCellTime('09,10,2026,18,59',verified).source_timestamp,
 '2026-10-09T17:59:00.000Z');
assert.equal(parseSourceCellTime('01,01,2026,00,15',verified).source_timestamp,
 '2025-12-31T23:15:00.000Z');
for(const raw of ['31,02,2026,12,00','09,10,2026,24,00','09,10,2026,18,60']){
 assert.equal(parseSourceCellTime(raw,verified).source_timestamp,null);
}
assert.equal(parseSourceCellTime('09,10,2026,18,59').source_timestamp,null);
const archiveClock={timezoneOffsetMinutes:0,timezoneVerified:true,
 timezoneEvidenceRef:'timezone-comparison'};
const missingYear=parseArchiveTime('22.09. 07:19',archiveClock);
assert.equal(missingYear.source_timestamp,null);
assert(missingYear.quality_flags.includes('SOURCE_YEAR_UNVERIFIED'));
assert.equal(missingYear.timestamp_precision,'MINUTE');
const suppliedYear={...archiveClock,year:2026,yearVerified:true,
 yearEvidenceRef:'test-fixture-explicit-year'};
assert.equal(parseArchiveTime('22.09. 07:19',suppliedYear).source_timestamp,
 '2026-09-22T07:19:00.000Z');
assert.equal(parseArchiveTime('22.09. 10:19',{
 ...suppliedYear,timezoneOffsetMinutes:180
}).source_timestamp,'2026-09-22T07:19:00.000Z');
const lateHistory={record_origin:'source_history',
 source_timestamp:'2026-09-22T07:19:00.000Z',
 observed_at:'2026-10-11T12:00:00.000Z'};
const cutoff='2026-10-10T12:00:00.000Z';
assert.equal(eligibleAtCutoff(lateHistory,cutoff).eligible,false);
assert.equal(eligibleAtCutoff(lateHistory,cutoff,
 'retrospective_source_history').eligible,true);
assert.equal(eligibleAtCutoff({...lateHistory,source_timestamp:null},cutoff,
 'retrospective_source_history').eligible,false);
assert.equal(eligibleAtCutoff({
 ...lateHistory,observed_at:'2026-10-09T12:00:00.000Z',
 source_timestamp:'2026-10-12T12:00:00.000Z'
},cutoff).eligible,false);
const folder=process.argv[2];
let checked=0;
for(const name of ['retry-1X2.json','retry-OU.json',
 'ASIAN-source-response.json','KG-source-response.json']){
 const payload=JSON.parse(fs.readFileSync(path.join(folder,name),'utf8'));
 for(const match of payload.odds.matchAll(/data-created=["']([^"']+)["']/g)){
  const value=parseSourceCellTime(match[1],verified);
  assert(value.source_timestamp, 'Gerçek hücre zamanı çözülemedi: '+match[1]);
  assert.equal(value.timestamp_precision,'MINUTE');
  checked++;
 }
}
assert(checked>0);
console.log('GERCEK_HUCRE_ZAMANLARI: GECTI; hucre='+checked);
console.log('EKSIK_YIL_SAAT_DILIMI_TARIH_SINIRLARI_VE_KESIM_SIZINTISI: GECTI');
