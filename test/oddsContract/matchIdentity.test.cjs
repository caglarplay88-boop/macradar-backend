
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {parseMatchIdentity,explicitInstant}=require('../../src/oddsContract/matchIdentity');
const html=fs.readFileSync(path.join(process.argv[2],'match-page.html'),'utf8');
const options={eventId:'0p1XkgIt',
 sourceUrl:'https://www.betexplorer.com/it/football/france/ligue-2/montpellier-grenoble/0p1XkgIt/',
 observedAt:'2026-10-11T12:00:00.000Z',clockRuleVerified:true};
const actual=parseMatchIdentity(html,options);
assert.equal(actual.identity_verified,true);
assert.equal(actual.home.source_team_id,'533');
assert.equal(actual.away.source_team_id,'507');
assert.equal(actual.home.name,'Montpellier');
assert.equal(actual.away.name,'Grenoble');
assert.equal(actual.kickoff,'2026-10-09T18:00:00.000Z');
assert.equal(actual.kickoff_comma_converted,actual.kickoff);
assert.equal(actual.lifecycle,'finished');
assert.equal(actual.pre_match_verified,false);
assert.equal(actual.period_verified,false);
assert(actual.raw_evidence[actual.raw_evidence_ref].sports_event);
const wrong=parseMatchIdentity(html,{...options,eventId:'wrong'});
assert.equal(wrong.identity_verified,false);
assert.equal(wrong.pre_match_verified,false);
const conflict=parseMatchIdentity(html.replace('data-dt="9,10,2026,19,00"',
 'data-dt="9,10,2026,20,00"'),options);
assert.equal(conflict.kickoff_verified,false);
assert.equal(conflict.pre_match_verified,false);
assert.equal(explicitInstant('2026-02-30T20:00:00+02:00'),null);
assert.equal(explicitInstant('2026-10-09T20:00:00'),null);
const synthetic=html.replace('/EventEnded','/EventScheduled')
 .replace('value="1" id="isFinished"','value="0" id="isFinished"');
const future=parseMatchIdentity(synthetic,{
 ...options,observedAt:'2026-10-08T12:00:00.000Z'
});
assert.equal(future.pre_match_verified,true);
console.log('GERCEK_SAYFA_EVENT_TAKIM_SIRASI_VE_IKI_SAAT_ALANI: GECTI');
console.log('BITMIS_MAC_PREMATCH_RED_KIMLIK_VE_SAAT_CELISKISI: GECTI');
console.log('GELECEK_MAC_DAVRANISI_SENTETIK_TESTTIR; GERCEK_CEKIM_DEGILDIR');
