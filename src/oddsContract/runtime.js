
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {OddsCollector}=require('./collector');
const {BetExplorerTransport}=require('./transport');
const {buildSettings,retryDelaySeconds}=require('./settings');
const crypto=require('node:crypto');
const {LimitedQueue}=require('./queue');
const {fetchMatchIdentity}=require('./matchSource');
const {parseBetExplorerUrl,parse1x2}=require('../odds1x2');
const {parseOverUnder}=require('../oddsOverUnder');
const {parseAsian}=require('../oddsAsian');
const {parseKg}=require('../oddsKg');
const clockEvidence=require('./sourceClockEvidence.json');

const COMPATIBILITY_WARNINGS=[
 'LEGACY_PARSER_OUTPUT_IS_FOR_EXISTING_SCREENS_ONLY',
 'LEGACY_OU_PARSER_SUPPORTS_ONLY_1_5_AND_2_5_RAW_HAS_ALL_LINES',
 'LEGACY_ASIAN_SIGN_MEANING_NOT_YET_VERIFIED',
 'LEGACY_ASIAN_AND_KG_STATUS_FLAGS_ARE_NOT_SOURCE_STATUS_PROOF',
 'LEGACY_GROUPS_DO_NOT_PRESERVE_ALL_CONTEXT_AND_EXCHANGE_DISTINCTIONS',
 'NEW_CONTRACT_ANALYSIS_MUST_USE_ODDS_RAW_AND_QUALITY'
];
function legacyCurrent(result){
 const parsers={'1X2':parse1x2,OU:parseOverUnder,ASIAN:parseAsian,KG:parseKg};
 const markets={};
 for(const item of result.current_payloads||[]){
  const parser=parsers[item.market];
  if(!parser) throw Error('UNKNOWN_CURRENT_MARKET');
  if(markets[item.market]) throw Error('DUPLICATE_CURRENT_MARKET_PAYLOAD');
  if(typeof item.payload?.odds!=='string') throw Error('CURRENT_HTML_MISSING');
  const instant=Date.parse(item.observed_at);
  if(!Number.isFinite(instant)) throw Error('CURRENT_OBSERVATION_TIME_INVALID');
  markets[item.market]={
   eventId:result.eventId,market:item.market,capturedAt:new Date(instant),
   sourceName:item.source.sourceName,sourceRegion:item.source.sourceRegion,
   rows:parser(item.payload.odds),
   compatibilityWarnings:[...COMPATIBILITY_WARNINGS],
   capturedAtMeaning:'LEGACY_CURRENT_FETCH_OBSERVATION_TIME',
   contractSnapshotId:result.snapshotId
  };
 }
 return markets;
}
class ContractRuntime{
 constructor({directory,transport=null,settings=buildSettings(),
  clock=()=>new Date().toISOString(),evidence=clockEvidence}={}){
  if(!directory||!path.isAbsolute(directory)) throw Error('RUNTIME_DIRECTORY_REQUIRED');
  this.directory=directory;
  this.clock=clock;
  this.jobs=new LimitedQueue(settings.scheduling.maxConcurrentMatches);
  this.settings=settings;
  this.collector=new OddsCollector({
   directory:path.join(directory,'state'),
   transport:transport||new BetExplorerTransport({
    evidenceDirectory:path.join(directory,'responses'),
    concurrency:settings.scheduling.maxConcurrentSourceRequests
   }),
   settings,clock,clockEvidence:evidence
  });
 }
 validateMatch(job){
  const eventId=String(job?.event_id||'').trim();
  const parsed=parseBetExplorerUrl(String(job?.url||'').trim());
  if(parsed.eventId!==eventId) throw Error('CONTRACT_MATCH_URL_ID_MISMATCH');
  return {eventId,url:parsed.url};
 }
 setTracking(job,enabled){
  const {eventId,url}=this.validateMatch(job);
  if(typeof enabled!=='boolean') throw Error('TRACKING_BOOLEAN_REQUIRED');
  if(enabled){
   return this.collector.store.startTracking(eventId,{
    source:'BetExplorer',source_url:url,
    source_page_identity_verified:false,
    compatibility_warnings:[...COMPATIBILITY_WARNINGS]
   });
  }
  return this.collector.store.transaction(eventId,state=>{
   state.tracking.enabled=false;
  });
 }

 collectTrackedMatch(job,{reason='periodic',forceHistory=false,
  verification={}}={}){
  const {eventId,url}=this.validateMatch(job);
  if(job.tracking_enabled===false) throw Error('TRACKING_DISABLED');
  return this.jobs.run(eventId,()=>this.captureVerified(job,{
   eventId,url,reason,forceHistory,verification
  }));
 }
 async captureVerified(job,{eventId,url,reason,forceHistory,verification}){
  this.collector.store.startTracking(eventId,{
   source:'BetExplorer',source_url:url,
   source_page_identity_verified:false
  });
  const previous={tracking:this.readState(eventId).tracking};
  const startedAt=this.clock();
  if(previous.tracking.retry_not_before&&
     Date.parse(startedAt)<Date.parse(previous.tracking.retry_not_before)){
   return {eventId,skipped:true,reason:'BACKOFF_ACTIVE',
    retryNotBefore:previous.tracking.retry_not_before};
  }
  const snapshotId=crypto.randomUUID();
  this.collector.store.beginRun(eventId,{
   run_id:snapshotId,started_at:startedAt,reason,
   scope:['MATCH_IDENTITY','1X2','OU','ASIAN','KG']
  });
  try {
  let checked;
  try{
   checked=await fetchMatchIdentity(this.collector.transport,job);
  }catch(error){
   const finishedAt=this.clock();
   if(error.identity_result?.identity?.raw_evidence){
    this.collector.store.saveCapture(eventId,{
     evidence:error.identity_result.identity.raw_evidence
    });
   }
   const run={
    run_id:snapshotId,started_at:startedAt,finished_at:finishedAt,
    success:false,reason,scope:['MATCH_IDENTITY'],
    odds_collection_performed:false,series_found:0,
    error:error.message,errors:[{
     phase:'MATCH_IDENTITY',error:error.message,
     attempts:error.attempts||error.identity_result?.attempts||[]
    }]
   };
   this.collector.store.recordRun(eventId,run);
   this.collector.store.transaction(eventId,state=>{
    const count=(state.tracking.consecutive_failures||0)+1;
    state.tracking.consecutive_failures=count;
    const next=new Date(Date.parse(finishedAt)+
     retryDelaySeconds(count,this.settings)*1000).toISOString();
    state.tracking.retry_not_before=next;
    state.tracking.next_current_scan_at=next;
    state.tracking.last_scan_run_id=snapshotId;
   return true;
  });
   return {eventId,snapshotId,success:false,skipped:false,run,current_payloads:[]};
  }
  const identity=checked.identity;
  this.collector.store.saveCapture(eventId,{evidence:identity.raw_evidence});
  this.collector.store.transaction(eventId,state=>{
   const old=state.match_identity;
   if(old?.kickoff_verified&&identity.kickoff_verified&&
      old.kickoff!==identity.kickoff){
    state.kickoff_changes=state.kickoff_changes||[];
    state.kickoff_changes.push({
     previous_kickoff:old.kickoff,new_kickoff:identity.kickoff,
     observed_at:checked.observed_at,snapshot_id:snapshotId,
     previous_evidence_ref:old.raw_evidence_ref,
     new_evidence_ref:identity.raw_evidence_ref
    });
   }
   state.match_identity=identity;
   state.identity_checks=state.identity_checks||[];
   state.identity_checks.push({
    snapshot_id:snapshotId,observed_at:checked.observed_at,
    raw_evidence_ref:identity.raw_evidence_ref,
    source_context_id:checked.source_context_id,
    attempts:checked.attempts
   });
   state.compatibility_warnings=[...COMPATIBILITY_WARNINGS];
  return true;
  });
  const reached=identity.kickoff_verified&&
   Date.parse(this.clock())>=Date.parse(identity.kickoff);
  if(identity.lifecycle==='finished'||identity.lifecycle==='live'||reached){
   const finishedAt=this.clock();
   const run={
    run_id:snapshotId,started_at:startedAt,finished_at:finishedAt,
    success:true,reason,scope:['MATCH_IDENTITY'],
    outcome:'PRE_MATCH_ENDED',odds_collection_performed:false,
    series_found:0,error:null,errors:[]
   };
   this.collector.store.recordRun(eventId,run);
   this.collector.store.transaction(eventId,state=>{
    state.tracking.enabled=false;
    state.tracking.pre_match_ended_at=finishedAt;
    state.tracking.pre_match_end_reason=
     reached?'VERIFIED_KICKOFF_REACHED':'SOURCE_MATCH_'+identity.lifecycle.toUpperCase();
    state.tracking.last_scan_run_id=snapshotId;
   return true;
  });
   return {eventId,snapshotId,success:true,skipped:true,
    reason:'PRE_MATCH_ENDED',run,identity,current_payloads:[]};
  }
  const result=await this.collector.collect({
   eventId,matchUrl:url,reason,forceHistory,snapshotId,runStartedAt:startedAt,
   verification:{
    ...verification,
    kickoff:identity.kickoff,kickoffVerified:identity.kickoff_verified,
    preMatchVerified:identity.pre_match_verified,
    periodVerified:identity.period_verified,
    openingLabelEvidenceRef:'betexplorer-clock-rule',
    matchIdentityEvidence:identity.raw_evidence,
    matchIdentityEvidenceRef:identity.raw_evidence_ref
   }
  });

  if(result.skipped&&this.readState(eventId).pending_run?.run_id===snapshotId){
   this.collector.store.recordRun(eventId,{
    run_id:snapshotId,started_at:startedAt,finished_at:this.clock(),
    success:false,reason,scope:['MATCH_IDENTITY'],
    odds_collection_performed:false,series_found:0,
    error:result.reason||'COLLECTION_SKIPPED',errors:[]
   });
  }
  return {...result,identity};
  } catch(error) {
   const state=this.readState(eventId);
   if(state.pending_run?.run_id===snapshotId){
    const finishedAt=this.clock();
    const code=/^[A-Z0-9_]{1,100}$/.test(String(error.message))?
     error.message:'COLLECTOR_RUNTIME_FAILURE';
    this.collector.store.recordRun(eventId,{
     run_id:snapshotId,started_at:startedAt,finished_at:finishedAt,
     success:false,reason,scope:['MATCH_IDENTITY','1X2','OU','ASIAN','KG'],
     series_found:0,error:code,errors:[{phase:'RUNTIME',error:code}]
    });
    this.collector.store.transaction(eventId,current=>{
     const count=(current.tracking.consecutive_failures||0)+1;
     current.tracking.consecutive_failures=count;
     const next=new Date(Date.parse(finishedAt)+
      retryDelaySeconds(count,this.settings)*1000).toISOString();
     current.tracking.retry_not_before=next;
     current.tracking.next_current_scan_at=next;
    return true;
  });
   }
   throw error;
  }
 }
 readState(eventId){return this.collector.store.read(eventId);}
}
let singleton=null;
function getContractRuntime(){
 if(!singleton){
  let overrides={};
  const configFile=process.env.MACRADAR_ODDS_CONTRACT_SETTINGS_FILE;
  if(configFile) overrides=JSON.parse(fs.readFileSync(configFile,'utf8'));
  const directory=path.resolve(process.env.MACRADAR_ODDS_CONTRACT_DIRECTORY||
   path.join(__dirname,'../../var/odds-contract'));
  singleton=new ContractRuntime({directory,settings:buildSettings(overrides)});
 }
 return singleton;
}
module.exports={ContractRuntime,getContractRuntime,legacyCurrent,COMPATIBILITY_WARNINGS};
