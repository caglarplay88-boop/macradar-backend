
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {buildContractExport}=require('../../src/oddsContract/exportContract');
const base=JSON.parse(fs.readFileSync(
 path.join(process.argv[2],'legacy-export-baseline.json'),'utf8'));
const original=JSON.stringify(base);
const result=buildContractExport(base,{analysisCutoff:base.exportedAt});
for(const record of result.odds_raw.filter(r=>['OU','ASIAN'].includes(r.market))){
 assert(record.line===null||typeof record.line==='number');
 assert(Object.hasOwn(record,'legacy_line_raw'));
 assert.equal(record.home_handicap,null);
 assert.equal(record.away_handicap,null);
}
for(const market of ['1X2','OU','ASIAN','KG']){
 for(let i=0;i<base.odds[market].length;i++){
  for(const [key,value] of Object.entries(base.odds[market][i])){
   assert.deepEqual(result.odds[market][i][key],value);
  }
 }
}
assert.equal(JSON.stringify(base),original);
const unusual=JSON.parse(original);
unusual.odds.OU[0].total_line='2/2.5';
const invalid=buildContractExport(unusual,{analysisCutoff:base.exportedAt});
const linked=invalid.odds.OU[0].raw_record_ids;
for(const record of invalid.odds_raw.filter(r=>linked.includes(r.record_id))){
 assert.equal(record.line,null);
 assert.equal(record.legacy_line_raw,'2/2.5');
 assert(record.quality_flags.includes('LEGACY_LINE_UNPARSEABLE'));
}
assert.equal(invalid.odds.OU[0].total_line,'2/2.5');
console.log('ESKI_ALANLAR_KORUNDU_YENI_HAM_CIZGI_SAYISAL: GECTI');
console.log('BELIRSIZ_CIZGIYE_TAHMIN_VE_ASIAN_ISARET_DONUSUMU_YOK: GECTI');
