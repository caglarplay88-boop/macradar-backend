
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {parseMatchIdentity}=require('../../src/oddsContract/matchIdentity');
const audit=process.argv[2];
const html=fs.readFileSync(path.join(audit,'scheduled-match-page.html'),'utf8');
const meta=JSON.parse(fs.readFileSync(path.join(audit,'scheduled-match-capture.json'),'utf8'));
assert.equal(require('node:crypto').createHash('sha256').update(html).digest('hex'),
 meta.response_sha256,'CAPTURED_RESPONSE_HASH_MISMATCH');
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
