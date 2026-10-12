
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const folder=process.argv[2];
const schema=JSON.parse(fs.readFileSync(
 path.join(__dirname,'../../docs/odds-contract/match-data.schema.json'),'utf8'));
function validate(value,s,at='$'){
 if('const' in s) assert.deepEqual(value,s.const,at);
 if(s.enum) assert(s.enum.some(v=>v===value),at+' enum');
 if(s.type){
  const types=Array.isArray(s.type)?s.type:[s.type];
  const actual=value===null?'null':Array.isArray(value)?'array':typeof value;
  assert(types.includes(actual),at+' type '+actual);
 }
 if(s.minLength) assert(value.length>=s.minLength,at);
 if(value&&typeof value==='object'&&!Array.isArray(value)){
  for(const key of s.required||[]) assert(Object.hasOwn(value,key),at+'.'+key+' missing');
  for(const [key,child] of Object.entries(s.properties||{})){
   if(Object.hasOwn(value,key)) validate(value[key],child,at+'.'+key);
  }
 }
 if(Array.isArray(value)&&s.items){
  value.forEach((item,i)=>validate(item,s.items,at+'['+i+']'));
 }
}
const {buildContractExport}=require('../../src/oddsContract/exportContract');
const baseline=JSON.parse(fs.readFileSync(
 path.join(folder,'legacy-export-baseline.json'),'utf8'));
const candidate=buildContractExport(baseline,{analysisCutoff:baseline.exportedAt});
validate(candidate,schema);
for(const record of candidate.odds_raw){
 assert(candidate.raw_evidence[record.raw_evidence_ref],'missing evidence');
 assert.equal(record.event_id,candidate.match.event_id);
}
for(const market of ['1X2','OU','ASIAN','KG']){
 const fixture=JSON.parse(fs.readFileSync(path.join(folder,'raw-parser-'+market+'.json'),'utf8'));
 for(const record of fixture.odds_raw){
  validate(record,schema.properties.odds_raw.items);
  assert(fixture.raw_evidence[record.raw_evidence_ref]);
 }
}
console.log('SEMA_ZORUNLU_ALAN_TIP_ENUM_VE_GOMULU_KANIT_BAGLARI: GECTI');
