'use strict';
const assert=require('node:assert/strict');
const {readSourceOpenings,readQuoteBatch}=require('../../src/oddsContract/quoteReader');
const home={record_id:'home-old',series_id:'home-series',event_id:'match',
 source:'BetExplorer',bookmaker_id:'417',source_context_id:'context-a',
 market:'1X2',period:null,line:null,selection:'HOME',price_type:'UNKNOWN',
 record_origin:'source_opening',odds_decimal:2.1,
 source_timestamp:'2026-10-10T08:00:00Z',observed_at:'2026-10-11T10:00:00Z',
 raw_evidence_ref:'home-evidence',quality_flags:['PERIOD_UNVERIFIED']};
const latest={...home,record_id:'home-latest',odds_decimal:2.2,observed_at:'2026-10-11T11:00:00Z'};
const away={...home,record_id:'away',series_id:'away-series',selection:'AWAY',
 odds_decimal:3.4,source_timestamp:null,source_timestamp_raw:'10.10.',raw_evidence_ref:'away-evidence'};
const context={...latest,record_id:'other-context',series_id:'other-series',source_context_id:'context-b'};
const history={...home,record_id:'history',record_origin:'source_history'};
const current={...home,record_id:'current',record_origin:'scraper_observation'};
const ou={...home,record_id:'ou',series_id:'ou-series',market:'OU',line:2.75,selection:'UNDER'};
const asian={...home,record_id:'asian',series_id:'asian-series',market:'ASIAN',line:-0.75,home_handicap:null,away_handicap:null};
const kg={...home,record_id:'kg',series_id:'kg-series',market:'KG',selection:'YES'};
const state={tracking:{initialized:true},odds_raw:[home,latest,away,context,history,current,ou,asian,kg]};
const result=readSourceOpenings(state,'1X2');
assert.equal(result.handled,true);assert.equal(result.archive_selections_grouped,false);
assert.deepEqual(result.records.map(r=>r.record_id).sort(),['away','home-latest','other-context']);
assert.strictEqual(result.records.find(r=>r.record_id==='away'),away);
assert.equal(away.source_timestamp,null);assert.equal(away.source_timestamp_raw,'10.10.');
assert.equal(latest.source_timestamp,home.source_timestamp);
assert.deepEqual(latest.quality_flags,['PERIOD_UNVERIFIED']);
assert(result.records.every(r=>!r.quote_group_id&&r.record_origin==='source_opening'));
assert.equal(readSourceOpenings(state,'OU').records[0].line,2.75);
const ah=readSourceOpenings(state,'ASIAN').records[0];
assert.equal(ah.line,-0.75);assert.equal(ah.home_handicap,null);assert.equal(ah.away_handicap,null);
assert.equal(readSourceOpenings(state,'KG').records[0].selection,'YES');
assert.equal(readSourceOpenings({},'1X2').handled,false);
assert.equal(readSourceOpenings({tracking:{initialized:true}},'1X2').missing_reason,'NO_SOURCE_OPENING_RECORDS');
assert.throws(()=>readSourceOpenings(state,'BAD'));
assert.equal(readQuoteBatch(state,'1X2',{captureType:'opening'}).batch,null);
console.log('SOURCE_OPENING_SELECTIONS_AND_NO_FAKE_GROUPS: PASSED');
