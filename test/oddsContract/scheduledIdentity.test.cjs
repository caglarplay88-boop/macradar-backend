
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {parseMatchIdentity}=require('../../src/oddsContract/matchIdentity');
const audit=process.argv[2];
const pointer=JSON.parse(fs.readFileSync(path.join(audit,'latest-single-store-real-source.json'),'utf8'));
const folder=pointer.directory;
assert(folder,'GERCEK_TEST_KLASORU_YOK');
const responses=path.join(folder,'runtime/responses');
let html,meta;
for(const file of fs.readdirSync(responses).filter(x=>x.endsWith('.json'))){
 const candidate=JSON.parse(fs.readFileSync(path.join(responses,file),'utf8'));
 if(candidate.success&&candidate.source_url.includes('/atalanta-venezia/')){
  meta=candidate;
  html=fs.readFileSync(path.join(responses,file.replace(/\.json$/,'.response')),'utf8');
  break;
 }
}
assert(html,'GERCEK_MAC_SAYFASI_YOK');
const options={eventId:'GxLyDAQb',sourceUrl:meta.source_url,
 observedAt:meta.observed_at,clockRuleVerified:true};
const actual=parseMatchIdentity(html,options);
assert.equal(actual.identity_verified,true);
assert.equal(actual.kickoff_verified,true);
assert.equal(actual.pre_match_verified,true);
assert.equal(actual.lifecycle,'pre_match');
assert.equal(actual.period_verified,false);
function inputValue(id,value){
 const pattern=new RegExp('<input\\b[^>]*\\bid="'+id+'"[^>]*>','i');
 assert(pattern.test(html),'KAYNAK_ALANI_YOK:'+id);
 return html.replace(pattern,'<input type="hidden" value="'+value+'" id="'+id+'"/>');
}
for(const id of ['isLive','isFinished']){
 const result=parseMatchIdentity(inputValue(id,'1'),options);
 assert.equal(result.pre_match_verified,false);
}
assert.equal(parseMatchIdentity(inputValue('isFinished','0'),options).pre_match_verified,true);
assert.equal(parseMatchIdentity(inputValue('isFinished','belirsiz'),options).pre_match_verified,false);
assert.equal(parseMatchIdentity(html,{...options,eventId:'wrong'}).pre_match_verified,false);
assert.equal(parseMatchIdentity(html,{...options,observedAt:actual.kickoff}).pre_match_verified,false);
assert.equal(parseMatchIdentity(html.replace('/EventScheduled','/EventEnded'),options).pre_match_verified,false);
assert.equal(parseMatchIdentity(html.replace('/EventScheduled','/EventPostponed'),options).pre_match_verified,false);
console.log('GERCEK_PLANLANMIS_MAC_VE_CANLI_BITMIS_KIMLIK_SAAT_KORUMALARI: GECTI');
