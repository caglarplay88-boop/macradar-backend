'use strict';
const fs=require('node:fs'),path=require('node:path');
const assert=require('node:assert/strict');
const {buildContractExport}=require('../../src/oddsContract/exportContract');
const folder=process.argv[2];
const base=JSON.parse(fs.readFileSync(path.join(folder,'legacy-export-baseline.json'),'utf8'));
const state={tracking:{initialized:true},odds_raw:{},raw_evidence:{},
 quote_groups:[],source_contexts:{},runs:[],coverage:{}};
for(const market of ['1X2','OU','ASIAN','KG']){
 const parsed=JSON.parse(fs.readFileSync(
  path.join(folder,'raw-parser-'+market+'.json'),'utf8'));
 for(const record of parsed.odds_raw) state.odds_raw[record.record_id]=record;
 Object.assign(state.raw_evidence,parsed.raw_evidence);
 Object.assign(state.source_contexts,parsed.source_contexts);
 state.quote_groups.push(...parsed.quote_groups);
}
const original=JSON.stringify(base),stored=JSON.stringify(state);
const result=buildContractExport(base,{
 state,analysisCutoff:'2026-10-11T13:00:00.000Z'
});
let legacyCount=0,newCount=0;
for(const market of ['1X2','OU','ASIAN','KG']){
 const old=base.odds[market],rows=result.odds[market];
 const added=rows.slice(old.length);
 legacyCount+=old.length;newCount+=added.length;
 for(let i=0;i<old.length;i++){
  for(const [key,value] of Object.entries(old[i])){
   assert.deepEqual(rows[i][key],value,'Legacy field changed: '+market+':'+key);
  }
 }
 assert.equal(added.length,state.quote_groups.filter(group=>{
  const first=state.odds_raw[group.raw_record_ids[0]];
  return first.market===market;
 }).length);
 for(const row of added){
  assert(row.raw_record_ids.every(id=>state.odds_raw[id]));
  assert.equal(row.simultaneous_source_updates_verified,false);
 }
}
assert.equal(newCount,258);
assert.deepEqual(result.performance,base.performance);
assert.deepEqual(result.performanceRaw,base.performanceRaw);
assert.equal(JSON.stringify(base),original);
assert.equal(JSON.stringify(state),stored);
assert.equal(result.compatibility.integration_test_status,'NOT_RUN');
assert.equal(result.quote_compatibility.storage_basis,
 'DERIVED_FROM_RAW_NOT_A_SECOND_ODDS_STORE');
console.log('EXPORT_YENI_HAM_GRUPLAR_VE_KANIT_BAGLARI: GECTI; grup='+newCount);
console.log('ESKI_DOSYA_ALANLARI_VE_PERFORMANS_KORUMA: GECTI; satir='+legacyCount);
console.log('GERCEK_OKUYUCU_ENTEGRASYONU_NOT_RUN_KORUNDU');
