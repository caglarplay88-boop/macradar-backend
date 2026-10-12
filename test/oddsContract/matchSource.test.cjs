
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {fetchMatchIdentity}=require('../../src/oddsContract/matchSource');
const {BetExplorerTransport}=require('../../src/oddsContract/transport');
const html=fs.readFileSync(path.join(process.argv[2],'match-page.html'),'utf8');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'macradar-page-source-'));
const job={event_id:'0p1XkgIt',
 url:'https://www.betexplorer.com/it/football/france/ligue-2/montpellier-grenoble/0p1XkgIt/'};
let calls=0;
const transport=new BetExplorerTransport({
 evidenceDirectory:directory,
 executor:async()=>{
  calls++;
  if(calls===1){
   const error=Error('EXPECTED_TIMEOUT');error.code=28;throw error;
  }
  return {stdout:Buffer.from(html+'\nMACRADAR_HTTP_STATUS:200')};
 }
});
(async()=>{
 try{
  const result=await fetchMatchIdentity(transport,job);
  assert.equal(result.identity.identity_verified,true);
  assert.equal(result.identity.lifecycle,'finished');
  assert.equal(result.identity.pre_match_verified,false);
  assert.equal(result.attempts.length,2);
  assert.equal(result.attempts[0].error,'CURL_EXIT_28');
  assert.equal(result.attempts[1].http_status,200);
  assert.equal(fs.readdirSync(directory).filter(f=>f.endsWith('.response')).length,2);
  const before=calls;
  await assert.rejects(fetchMatchIdentity(transport,{...job,event_id:'wrong'}),
   /MATCH_REQUEST_URL_EVENT_MISMATCH/);
  assert.equal(calls,before);
  await assert.rejects(fetchMatchIdentity({
   fetchTextWithFailover:async()=>({
    html:html.replace('data-event-id="0p1XkgIt"','data-event-id="different"'),
    observed_at:'2026-10-11T12:00:00.000Z'
   })
  },job),error=>{
   assert(error.identity_result.identity.raw_evidence_ref);
   return error.message==='SOURCE_MATCH_IDENTITY_NOT_VERIFIED';
  });
  const failed=new BetExplorerTransport({
   evidenceDirectory:path.join(directory,'failed'),
   executor:async()=>{
    const error=Error('HTTP_FAILURE');error.code=22;
    error.stdout=Buffer.from('REPLAY_ERROR_BODY\nMACRADAR_HTTP_STATUS:502');
    throw error;
   }
  });
  await assert.rejects(fetchMatchIdentity(failed,job),error=>{
   assert.equal(error.attempts.length,4);
   assert(error.attempts.every(a=>a.http_status===502));
   return error.message==='ALL_BETEXPLORER_PAGE_SOURCES_FAILED';
  });
  console.log('MEVCUT_KAYNAK_ZINCIRI_SAYFA_HAM_KANIT_VE_HTTP_HATALARI: GECTI');
  console.log('URL_EVENT_VE_GERCEK_SAYFA_EVENT_KONTROLU: GECTI');
  console.log('GERCEK_SAYFA_YENIDEN_OYNATILDI; YENI_CANLI_CEKIM_YAPILMADI');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
