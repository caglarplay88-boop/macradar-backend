
'use strict';
const assert=require('node:assert/strict');
const {compareBookmakers}=require('../../src/oddsContract/bookmakerComparison');
const records=[],summaries=[],contexts={};
function add(book,line,first,last,extra={}){
 const series=book+'|'+line;
 const context='context-'+book;
 contexts[context]={parent_source_context_id:'parent',
  source_row_context:{origin_id_raw:'1',display_bookmaker_id_raw:book}};
 const start={record_id:series+'-first',series_id:series,event_id:'e',
  source:'BetExplorer',source_context_id:context,bookmaker_id:book,
  bookmaker_name:book,market:'OU',period:'FULL_TIME_90',line,
  selection:'OVER',price_type:'SPORTSBOOK',main_analysis_eligible:true,
  ...extra};
 const end={...start,record_id:series+'-last',cutoff_price_eligible:true};
 records.push(start,end);
 const point=(r,price,time)=>({record_id:r.record_id,price,
  time_basis:'source_timestamp',effective_time:time});
 summaries.push({series_id:series,windows:{last_1_hour:{
  starts_at:'2026-10-11T11:00:00Z',ends_at:'2026-10-11T12:00:00Z',
  cutoff_result:{
   first:point(start,first,'2026-10-11T11:00:00Z'),
   last:point(end,last,'2026-10-11T11:59:00Z'),
   absolute_change:last-first,percentage_change:100*(last/first-1)
  }
 }}});
}
add('a',2.5,2,1.8);add('b',2.5,2,2.2);
add('c',2.75,2,2);
let result=compareBookmakers({records,summaries,sourceContexts:contexts});
const line25=result.find(x=>x.line===2.5);
assert.equal(line25.falling.count,1);
assert.equal(line25.rising.count,1);
assert.equal(line25.sample_coverage.included_bookmakers,2);
assert(Math.abs(line25.median_percentage_change)<1e-9);
assert.equal(result.find(x=>x.line===2.75).unchanged.count,1);
assert.equal(result.find(x=>x.line===2.75).median_percentage_change,null);
assert.equal(line25.raw_series_merged,false);
assert.equal(line25.first_mover_ranking_produced,false);
records.find(r=>r.record_id==='b|2.5-last').cutoff_price_eligible=false;
result=compareBookmakers({records,summaries,sourceContexts:contexts});
assert.equal(result.find(x=>x.line===2.5).excluded.length,1);
records.find(r=>r.record_id==='b|2.5-last').cutoff_price_eligible=true;
summaries[1].windows.last_1_hour.cutoff_result.last.effective_time='2026-10-11T11:50:00Z';
result=compareBookmakers({records,summaries,sourceContexts:contexts,maxEndpointSkewSeconds:300});
assert.equal(result.find(x=>x.line===2.5).sample_coverage.included_bookmakers,0);
assert.equal(result.find(x=>x.line===2.5).excluded.length,2);
console.log('AYNI_PENCERE_SIRKET_LISTELERI_MEDYAN_VE_CIZGI_AYRIMI: GECTI');
console.log('ESKI_FIYAT_ZAMAN_UYUMSUZLUGU_VE_LIDER_TAHMINI_URETMEME: GECTI');
