
'use strict';
const crypto=require('node:crypto');
const {LimitedQueue}=require('./queue');
const {StateStore}=require('./stateStore');
const {parseCurrentResponse}=require('./currentParser');
const {archiveUrl,parseArchiveResponse,failedArchiveCoverage}=require('./archiveParser');
const {buildSettings,collectionSchedule,retryDelaySeconds}=require('./settings');
const MARKETS=[['1X2','1x2'],['OU','ou'],['ASIAN','ah'],['KG','bts']];
async function boundedMap(items,limit,operation){
 const results=new Array(items.length);
 let index=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(index<items.length){
   const position=index++;
   results[position]=await operation(items[position],position);
  }
 }));
 return results;
}
class OddsCollector {
 constructor({directory,transport,settings=buildSettings(),
  clock=()=>new Date().toISOString(),clockEvidence=null}){
  this.store=new StateStore(directory);
  this.transport=transport;this.settings=settings;this.clock=clock;
  this.clockEvidence=clockEvidence;
  this.matches=new LimitedQueue(settings.scheduling.maxConcurrentMatches);
  this.requests=new LimitedQueue(settings.scheduling.maxConcurrentSourceRequests);
 }
 collect({eventId,matchUrl,reason='periodic',forceHistory=false,
  verification={},snapshotId=null,runStartedAt=null}){
  return this.matches.run(eventId,()=>this.capture({
   eventId,matchUrl,reason,forceHistory,verification,
   suppliedSnapshotId:snapshotId,runStartedAt
  }));
 }
 async capture({eventId,matchUrl,reason,forceHistory,verification,suppliedSnapshotId=null,runStartedAt=null}){
  const previous={tracking:this.store.read(eventId).tracking};
  if(!previous.tracking.enabled) throw Error('TRACKING_NOT_ENABLED');
  const startedAt=runStartedAt||this.clock();
  const schedule=collectionSchedule({
   now:startedAt,kickoff:verification.kickoff,
   kickoffVerified:verification.kickoffVerified===true,settings:this.settings
  });
  if(schedule.stopPreMatch){
   this.store.transaction(eventId,state=>{
    state.tracking.pre_match_ended_at=startedAt;
    state.tracking.pre_match_end_reason='VERIFIED_KICKOFF_REACHED';
   return true;
  });
   return {eventId,skipped:true,reason:'PRE_MATCH_ENDED'};
  }
  if(previous.tracking.retry_not_before&&
     Date.parse(startedAt)<Date.parse(previous.tracking.retry_not_before)){
   return {eventId,skipped:true,reason:'BACKOFF_ACTIVE',
    retryNotBefore:previous.tracking.retry_not_before};
  }
  const lastHistory=previous.tracking.last_history_reconciliation_at;
  const historyDue=forceHistory||!lastHistory||
   Date.parse(startedAt)-Date.parse(lastHistory)>=schedule.historyMinutes*60000;
  const snapshotId=suppliedSnapshotId||crypto.randomUUID();
  const errors=[],marketResults=[],historyResults=[];
  const current=await boundedMap(MARKETS,
   this.settings.scheduling.maxConcurrentSourceRequests,async([market,code])=>{
    const url='https://www.betexplorer.com/match-odds/'+eventId+
     '/0/'+code+'/odds/?lang=en';
    try{
     const captured=await this.requests.run(snapshotId+'|'+market,
      ()=>this.transport.fetchJsonWithFailover(url));
     if(typeof captured.payload?.odds!=='string'||!captured.payload.odds.trim()){
      throw Error('SOURCE_ODDS_HTML_MISSING');
     }
     const parsed=parseCurrentResponse(captured.payload.odds,{
      market,eventId,sourceUrl:url,snapshotId,
      observedAt:captured.observed_at,
      captureStartedAt:captured.capture_started_at,
      captureFinishedAt:captured.capture_finished_at,
      sourceContextId:captured.source_context_id,
      sourceContext:captured.source_context,
      cellTimeRuleVerified:Boolean(this.clockEvidence),
      cellTimeEvidenceRef:this.clockEvidence?'betexplorer-clock-rule':null,
      periodVerified:verification.periodVerified===true,
      preMatchVerified:verification.preMatchVerified===true,
      asianHomeSignVerified:verification.asianHomeSignVerified===true,
      sportsbookTypeVerified:verification.sportsbookTypeVerified===true,
      exchangePriceTypeVerified:verification.exchangePriceTypeVerified===true,
      exchangePriceType:verification.exchangePriceType
     });
     if(this.clockEvidence){
      parsed.raw_evidence['betexplorer-clock-rule']=this.clockEvidence;
      parsed.odds_raw.forEach(record=>{
       record.time_conversion_evidence_ref='betexplorer-clock-rule';
      });
     }
      if(verification.matchIdentityEvidence){
       Object.assign(parsed.raw_evidence,verification.matchIdentityEvidence);
       parsed.odds_raw.forEach(record=>{
        record.match_identity_evidence_ref=verification.matchIdentityEvidenceRef;
       });
      }
     this.store.saveCapture(eventId,{
      records:parsed.odds_raw,evidence:parsed.raw_evidence
     });
     this.store.transaction(eventId,state=>{
      state.source_contexts={
       ...(state.source_contexts||{}),...parsed.source_contexts
      };
      state.quote_groups=[...(state.quote_groups||[]),...parsed.quote_groups];
     return true;
  });
     marketResults.push({
      market,success:true,records:parsed.odds_raw.length,
      source_context_id:captured.source_context_id,attempts:captured.attempts||[]
     });
     return {market,captured,parsed};
    }catch(error){
     const failure={market,success:false,error:error.message,
      attempts:error.attempts||[]};
     errors.push(failure);marketResults.push(failure);
     return null;
    }
   });
  const parents=current.filter(Boolean).flatMap(item=>
   item.parsed.odds_raw.map(record=>({record,captured:item.captured})));
  if(historyDue){
   const archiveResults=await boundedMap(parents,
    this.settings.scheduling.maxConcurrentSourceRequests,async({record,captured})=>{
     const url=archiveUrl(record);
     if(!url){
      return {records:[],evidence:{},coverage:{
       series_id:record.series_id,status:'current_only',fetch_success:true,
       reason:'NO_ARCHIVE_LOCATOR_IN_THIS_SOURCE_ROW',
       complete_history_guaranteed:false,pagination_finished:null
      }};
     }
     try{
      const fetched=await this.requests.run(snapshotId+'|archive|'+url+
       '|'+record.source_context_id,
       ()=>this.transport.fetchJsonFromSource(captured.source,url));
      const parsed=parseArchiveResponse(fetched.payload,record,{
       snapshotId,sourceUrl:url,observedAt:fetched.observed_at,
       captureStartedAt:fetched.capture_started_at,
       captureFinishedAt:fetched.capture_finished_at,
       openingLabelEvidenceRef:verification.openingLabelEvidenceRef||null,
       time:{
        timezoneOffsetMinutes:0,
        timezoneVerified:Boolean(this.clockEvidence),
        timezoneEvidenceRef:this.clockEvidence?'betexplorer-clock-rule':null
       }
      });
      historyResults.push({
       series_id:record.series_id,success:true,
       coverage:parsed.coverage.status,records:parsed.odds_raw.length
      });
      return {records:parsed.odds_raw,evidence:parsed.raw_evidence,
       coverage:parsed.coverage};
     }catch(error){
      const coverage=failedArchiveCoverage(record,{
       attemptedAt:this.clock(),errorCode:error.capture?.error?.code||error.message
      });
      errors.push({series_id:record.series_id,error:coverage.error_code});
      historyResults.push({series_id:record.series_id,success:false,
       error:coverage.error_code});
      return {records:[],evidence:{},coverage};
     }
    });
   this.store.saveCapture(eventId,{
    records:archiveResults.flatMap(item=>item.records),
    evidence:Object.assign({},...archiveResults.map(item=>item.evidence)),
    coverage:archiveResults.map(item=>item.coverage)
   });
  }
  const finishedAt=this.clock();
  const success=marketResults.length===4&&marketResults.every(r=>r.success)&&
   errors.length===0;
  const run={
   run_id:snapshotId,started_at:startedAt,finished_at:finishedAt,success,
   reason,scope:MARKETS.map(([market])=>market),
   history_reconciliation_requested:historyDue,
   series_found:new Set(parents.map(item=>item.record.series_id)).size,
   expected_interval_seconds:schedule.currentMinutes*60,
   market_results:marketResults,history_results:historyResults,
   error:success?null:'PARTIAL_OR_FAILED_COLLECTION',errors
  };
  this.store.recordRun(eventId,run);
  this.store.transaction(eventId,state=>{
   const failedCount=success?0:(state.tracking.consecutive_failures||0)+1;
   state.tracking.consecutive_failures=failedCount;
   state.tracking.retry_not_before=success?null:new Date(
    Date.parse(finishedAt)+retryDelaySeconds(failedCount,this.settings)*1000
   ).toISOString();
   state.tracking.next_current_scan_at=new Date(
    Date.parse(finishedAt)+schedule.currentMinutes*60000
   ).toISOString();
   if(success&&historyDue){
    state.tracking.last_history_reconciliation_at=finishedAt;
   }
   state.tracking.last_scan_run_id=snapshotId;
  return true;
  });
  return {eventId,snapshotId,success,skipped:false,run,
   current_payloads:current.filter(Boolean).map(item=>({
    market:item.market,payload:item.captured.payload,
    source:item.captured.source,observed_at:item.captured.observed_at
   }))};
 }
}
module.exports={OddsCollector,boundedMap};
