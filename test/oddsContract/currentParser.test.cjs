
'use strict';
const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path');
const {parseCurrentResponse}=require('../../src/oddsContract/currentParser');
const folder=process.argv[2];
const options=market=>({
 market,eventId:'0p1XkgIt',sourceUrl:'https://www.betexplorer.com/',
 snapshotId:'actual-source-audit',sourceContextId:'actual-source-context',
 observedAt:'2026-10-11T12:12:55.000Z',
 captureStartedAt:'2026-10-11T12:00:00.000Z',
 captureFinishedAt:'2026-10-11T12:13:00.000Z',
 cellTimeRuleVerified:true,cellTimeEvidenceRef:'source-script:my_tz_format'
});
const files={'1X2':'retry-1X2.json',OU:'retry-OU.json',
 ASIAN:'ASIAN-source-response.json',KG:'KG-source-response.json'};
for(const [market,name] of Object.entries(files)){
 const html=JSON.parse(fs.readFileSync(path.join(folder,name),'utf8')).odds;
 const result=parseCurrentResponse(html,options(market));
 const sourceCells=[...html.matchAll(/<td\b[^>]*\bdata-odd\s*=/gi)].length;
 assert.equal(result.odds_raw.length,sourceCells);
 assert(sourceCells>0);
 for(const record of result.odds_raw){
  assert(record.selection);
  assert(result.raw_evidence[record.raw_evidence_ref]);
  assert.equal(record.status,'UNKNOWN');
  assert.equal(record.main_analysis_eligible,false);
 }
 assert.deepEqual(parseCurrentResponse(html,options(market)),result);
 fs.writeFileSync(path.join(folder,'raw-parser-'+market+'.json'),
  JSON.stringify(result,null,2));
 console.log('GERCEK_HAM_TARAF_KORUMA: '+JSON.stringify({
  market,sourceCells,rawRecords:result.odds_raw.length,
  quoteGroups:result.quote_groups.length,
  lines:[...new Set(result.odds_raw.map(r=>r.line))],
  inactivePreserved:result.odds_raw.filter(r=>r.source_status_marker).length
 }));
}
function row(line,first='1.9',second='1.9'){
 return `<tr data-bid="16"><td class="table-main__doubleparameter">${line}</td>
 <td data-pos="1" data-odd="${first}" data-bookie="test" data-bookmaker-id="16"></td>
 <td data-pos="2" data-odd="${second}" data-bookie="test" data-bookmaker-id="16"></td></tr>`;
}
const quarters=parseCurrentResponse(
 [2.5,2.75,3].map(x=>row(x)).join(''),options('OU'));
assert.deepEqual([...new Set(quarters.odds_raw.map(r=>r.line))],[2.5,2.75,3]);
const invalid=parseCurrentResponse(row(2.5,'', 'bad'),options('OU'));
assert.equal(invalid.odds_raw.length,2);
assert(invalid.odds_raw.every(r=>r.odds_decimal===null));
assert(invalid.odds_raw.every(r=>r.quality_flags.includes('INVALID_DECIMAL_PRICE')));
assert.equal(invalid.odds_raw[0].selection,'OVER');
assert.equal(invalid.odds_raw[1].selection,'UNDER');
const missing=parseCurrentResponse(
 '<tr><td data-pos="y" data-odd="1.9"></td></tr>',options('KG'));
assert.equal(missing.odds_raw.length,1);
assert.equal(missing.odds_raw[0].selection,'YES');
assert.equal(missing.quote_groups[0].raw_record_ids.length,1);
console.log('CEYREK_CIZGI_EKSIK_TARAF_GECERSIZ_FIYAT_VE_KANIT_BAGLARI: GECTI');


const contextRow=origin=>`<tr data-bid="16" data-bookie-id="11" data-originid="${origin}">
 <td data-pos="y" data-odd="1.9" data-bookie="test" data-bookmaker-id="16"></td>
 <td data-pos="n" data-odd="1.9" data-bookie="test" data-bookmaker-id="16"></td></tr>`;
const contexts=parseCurrentResponse(contextRow('1')+contextRow('2'),options('KG'));
assert.notEqual(contexts.odds_raw[0].source_context_id,
 contexts.odds_raw[2].source_context_id);
assert.notEqual(contexts.odds_raw[0].series_id,contexts.odds_raw[2].series_id);
for(const record of contexts.odds_raw){
 assert(contexts.source_contexts[record.source_context_id]);
}
console.log('KAYNAK_SATIR_GRUBU_FARKLIYSA_AYRI_BAGLAM_VE_SERI: GECTI');

// Unverified scope must remain null, including truthy non-boolean flags.
for(const flag of [undefined,false,null,1,'true']){
 const result=parseCurrentResponse(row(2.5),{
  ...options('OU'),periodVerified:flag
 });
 for(const record of result.odds_raw){
  assert.equal(record.period,null);
  assert(record.quality_flags.includes('PERIOD_UNVERIFIED'));
  assert.equal(record.scope_verified,false);
  assert.equal(record.main_analysis_eligible,false);
 }
}
const explicitlyVerified=parseCurrentResponse(row(2.5),{
 ...options('OU'),periodVerified:true,preMatchVerified:true
});
for(const record of explicitlyVerified.odds_raw){
 assert.equal(record.period,'FULL_TIME_90');
 assert(!record.quality_flags.includes('PERIOD_UNVERIFIED'));
 assert.equal(record.scope_verified,true);
}
console.log('DOGRULANMAMIS_PERIOD_NULL_VE_KATI_BOOLEAN_KONTROLU: GECTI');

// ASIAN_SPLIT_SOURCE_REGRESSION
for(const [label,value] of [
 ['-0.5, -1',-0.75],['-1, -1.5',-1.25],
 ['-2, -2.5',-2.25],['-2.5, -3',-2.75],
 ['0, -0.5',-0.25],['0, 0.5',0.25],
 ['0.5, 1',0.75],['1, 1.5',1.25],
 ['1.5, 2',1.75],['2, 2.5',2.25]
]){
 const result=parseCurrentResponse(row(label),options('ASIAN'));
 for(const record of result.odds_raw){
  assert.equal(record.line,value);
  assert.equal(record.home_handicap,null);
  assert.equal(record.away_handicap,null);
  assert(record.quality_flags.includes('ASIAN_HOME_SIGN_UNVERIFIED'));
  assert(!record.quality_flags.includes('SOURCE_LINE_UNRESOLVED'));
 }
}
for(const label of ['-0.5, -1.5','0.1, 0.6','0, 0.5, 1','unknown']){
 const result=parseCurrentResponse(row(label),options('ASIAN'));
 assert(result.odds_raw.every(r=>r.line===null));
 assert(result.odds_raw.every(r=>r.quality_flags.includes('SOURCE_LINE_UNRESOLVED')));
}
const conflicting=row('-0.5, -1').replace(
 'data-pos="1"',
 'data-hcp="E-5-1-0--0.5-0" data-pos="1"'
);
const conflict=parseCurrentResponse(conflicting,options('ASIAN'));
assert(conflict.odds_raw.every(r=>r.line===null));
assert(conflict.odds_raw.every(r=>r.quality_flags.includes('SOURCE_LINE_CONFLICT')));
const totalSplit=parseCurrentResponse(row('0, 0.5'),options('OU'));
assert(totalSplit.odds_raw.every(r=>r.line===null));
console.log('ASIAN_SPLIT_SOURCE_REGRESSION: GECTI');
