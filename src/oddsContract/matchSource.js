
'use strict';
const {parseBetExplorerUrl}=require('../odds1x2');
const {parseMatchIdentity}=require('./matchIdentity');
async function fetchMatchIdentity(transport,job){
 const expected=String(job?.event_id||'').trim();
 const parsed=parseBetExplorerUrl(String(job?.url||'').trim());
 if(!expected||parsed.eventId!==expected){
  throw Error('MATCH_REQUEST_URL_EVENT_MISMATCH');
 }
 const captured=await transport.fetchTextWithFailover(parsed.url);
 const identity=parseMatchIdentity(captured.html,{
  eventId:expected,sourceUrl:parsed.url,
  observedAt:captured.observed_at,clockRuleVerified:true
 });
 const result={identity,attempts:captured.attempts||[],
  source_context_id:captured.source_context_id,
  capture_started_at:captured.capture_started_at,
  capture_finished_at:captured.capture_finished_at,
  observed_at:captured.observed_at};
 if(!identity.identity_verified){
  const error=Error('SOURCE_MATCH_IDENTITY_NOT_VERIFIED');
  error.identity_result=result;throw error;
 }
 return result;
}
module.exports={fetchMatchIdentity};
