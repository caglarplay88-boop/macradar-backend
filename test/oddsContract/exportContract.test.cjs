
'use strict';
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const {buildContractExport}=require('../../src/oddsContract/exportContract');
const folder=process.argv[2];
const base=JSON.parse(fs.readFileSync(
 path.join(folder,'legacy-export-baseline.json'),'utf8'));
const before=JSON.stringify(base);
const data=buildContractExport(base,{
 analysisCutoff:'2026-10-11T13:00:00.000Z'
});
assert.equal(JSON.stringify(base),before);
for(const field of ['performance','performanceRaw','performanceCache','tracking','match']){
 assert.deepEqual(data[field],base[field]);
}
const byId=new Map(data.odds_raw.map(r=>[r.record_id,r]));
let checked=0;
for(const market of ['1X2','OU','ASIAN','KG']){
 assert.equal(data.odds[market].length,base.odds[market].length);
 for(let index=0;index<base.odds[market].length;index++){
  const original=base.odds[market][index],exported=data.odds[market][index];
  for(const key of Object.keys(original)) assert.deepEqual(exported[key],original[key]);
  assert.equal(exported.captured_at,original.captured_at);
  assert(exported.raw_record_ids.length>=2);
  for(const id of exported.raw_record_ids){
   const record=byId.get(id);
   assert(record);
   assert(data.raw_evidence[record.raw_evidence_ref]);
   assert.equal(record.observed_at,null);
   assert.equal(record.main_analysis_eligible,false);
  }
  checked++;
 }
}
assert.equal(data.compatibility.integration_test_status,'NOT_RUN');
assert.equal(data.compatibility.full_compatibility_verified,false);
assert.equal(data.quality.prices_corrected,0);
assert.equal(data.collection.data_freshness.verified_current,false);
const failed=buildContractExport(base,{
 analysisCutoff:'2026-10-11T13:00:00.000Z',
 state:{runs:[{
  run_id:'failed',success:false,started_at:'2026-10-11T12:00:00Z',
  finished_at:'2026-10-11T12:01:00Z',error:'HTTP_502'
 }]}
});
assert.equal(failed.collection.last_successful_scan,null);
assert.equal(failed.collection.last_scan_result.error,'HTTP_502');
assert.equal(failed.collection.data_freshness.reason,'LAST_SCAN_FAILED');
fs.writeFileSync(path.join(folder,'match-data-legacy-contract-candidate.json'),
 JSON.stringify(data,null,2));
console.log('GERCEK_ESKI_DOSYA_ALAN_VE_CAPTURED_AT_KORUMA: GECTI; satir='+checked);
console.log('PERFORMANS_KORUMA_HAM_KAYIT_KANIT_BAGI_VE_BASARISIZ_TARAMA: GECTI');
console.log('OKUYUCU_ENTEGRASYONU: YAPILMADI; TAM_UYUMLULUK_IDDIA_EDILMEDI');
