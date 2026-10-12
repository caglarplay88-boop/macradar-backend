
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const clone=value=>JSON.parse(JSON.stringify(value));
class StateStore {
 constructor(directory,{recoverInterruptedRuns=true}={}){
  if(typeof directory!=='string'||!path.isAbsolute(directory)){
   throw Error('STATE_DIRECTORY_REQUIRES_ABSOLUTE_PATH');
  }
  this.directory=directory;
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if(recoverInterruptedRuns) this.recoverInterruptedRuns();
 }
 file(eventId){
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(String(eventId))){
   throw Error('INVALID_EVENT_ID');
  }
  return path.join(this.directory,eventId+'.json');
 }
 empty(eventId){
  return {storage_version:1,event_id:eventId,tracking:{enabled:false,
   initialized:false},odds_raw:{},raw_evidence:{},runs:[],coverage:{},
   checkpoints:[],kickoff_changes:[],interruptions:[]};
 }
 read(eventId){
  const filename=this.file(eventId);
  if(!fs.existsSync(filename)) return this.empty(eventId);
  const state=JSON.parse(fs.readFileSync(filename,'utf8'));
  if(state.event_id!==eventId||state.storage_version!==1){
   throw Error('STATE_IDENTITY_OR_VERSION_MISMATCH');
  }
  return state;
 }
 acquire(filename){
  const lock=filename+'.lock';
  try{
   const descriptor=fs.openSync(lock,'wx',0o600);
   fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid}));
   fs.closeSync(descriptor);
   return lock;
  }catch(error){
   if(error.code!=='EEXIST') throw error;
   let owner;
   try{owner=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{
    throw Error('STATE_LOCK_UNREADABLE');
   }
   if(!Number.isInteger(owner.pid)||owner.pid<1) throw Error('STATE_LOCK_INVALID');
   try{process.kill(owner.pid,0);throw Error('STATE_LOCK_BUSY');}
   catch(check){
    if(check.code!=='ESRCH') throw check;
   }
   fs.unlinkSync(lock);
   return this.acquire(filename);
  }
 }
 transaction(eventId,change){
  const filename=this.file(eventId),lock=this.acquire(filename);
  const temporary=filename+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp';
  try{
   const state=this.read(eventId);
   const result=change(state);
   const descriptor=fs.openSync(temporary,'wx',0o600);
   try{fs.writeFileSync(descriptor,JSON.stringify(state));fs.fsyncSync(descriptor);}
   finally{fs.closeSync(descriptor);}
   fs.renameSync(temporary,filename);
   const directory=fs.openSync(this.directory,'r');
   try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
   return clone(result??state);
  }finally{
   if(fs.existsSync(temporary)) fs.unlinkSync(temporary);
   fs.unlinkSync(lock);
  }
 }
 startTracking(eventId,configuration){
  return this.transaction(eventId,state=>{
   const created=!state.tracking.initialized;
   state.tracking={...state.tracking,enabled:true,initialized:true,
    configuration:clone(configuration)};
   return {created,tracking:state.tracking};
  });
 }
 saveCapture(eventId,{records=[],evidence={},coverage=[]}){
  return this.transaction(eventId,state=>{
   for(const [id,fragment] of Object.entries(evidence)){
    if(state.raw_evidence[id]&&
       JSON.stringify(state.raw_evidence[id])!==JSON.stringify(fragment)){
     throw Error('EVIDENCE_ID_CONFLICT');
    }
    state.raw_evidence[id]=clone(fragment);
   }

   const {historyRepeatKey,remapIds}=require('./historyRepeat');
   const aliases={};
   state.archive_retrievals=state.archive_retrievals||[];
   if(!state.history_repeat_index){
    state.history_repeat_index={};
    for(const old of Object.values(state.odds_raw)){
     const key=historyRepeatKey(old,state.raw_evidence[old.raw_evidence_ref]);
     if(key&&!state.history_repeat_index[key]){
      state.history_repeat_index[key]=old.record_id;
     }
    }
   }
   let inserted=0;
   for(const record of records){
    if(record.event_id!==eventId) throw Error('CAPTURE_EVENT_MISMATCH');
    if(!record.record_id||!state.raw_evidence[record.raw_evidence_ref]){
     throw Error('RAW_RECORD_EVIDENCE_MISSING');
    }

    const repeatKey=historyRepeatKey(
     record,state.raw_evidence[record.raw_evidence_ref]);
    const canonicalId=repeatKey?state.history_repeat_index[repeatKey]:null;
    if(repeatKey){
     state.archive_retrievals.push({
      raw_record_id:canonicalId||record.record_id,
      received_record_id:record.record_id,
      observed_at:record.observed_at,snapshot_id:record.snapshot_id,
      raw_evidence_ref:record.raw_evidence_ref,
      raw_evidence_row_index:record.raw_evidence_row_index,
      identical_response_repeat:Boolean(canonicalId),
      deduplication_basis:'IDENTICAL_FULL_RESPONSE_SAME_SERIES_AND_CONTEXT',
      source_event_identity_claimed:false
     });
     if(canonicalId&&canonicalId!==record.record_id){
      aliases[record.record_id]=canonicalId;
      continue;
     }
     state.history_repeat_index[repeatKey]=record.record_id;
    }
    const existing=state.odds_raw[record.record_id];
    if(existing&&JSON.stringify(existing)!==JSON.stringify(record)){
     throw Error('RAW_RECORD_ID_CONFLICT');
    }
    if(!existing){
     state.odds_raw[record.record_id]=clone(record);inserted++;
    }
   }
   for(const item of remapIds(coverage,aliases)){
    if(!item.series_id) throw Error('COVERAGE_SERIES_MISSING');
    const prior=state.coverage[item.series_id]||{};
    state.coverage[item.series_id]={
     ...prior,last_attempt:clone(item),
     last_success:item.fetch_success===true?clone(item):prior.last_success||null
    };
   }
   return {inserted,total:Object.keys(state.odds_raw).length};
  });
 }

 beginRun(eventId,run){
  if(!run.run_id||!Number.isFinite(Date.parse(run.started_at))){
   throw Error('PENDING_RUN_METADATA_INVALID');
  }
  return this.transaction(eventId,state=>{
   if(state.pending_run) throw Error('RUN_ALREADY_IN_PROGRESS');
   state.pending_run={...clone(run),owner_pid:process.pid};
  });
 }
 recoverInterruptedRuns(){
  for(const filename of fs.readdirSync(this.directory)){
   if(!/^[A-Za-z0-9_-]{1,80}\.json$/.test(filename)) continue;
   const eventId=filename.slice(0,-5);
   const state=this.read(eventId);
   const pending=state.pending_run;
   if(!pending) continue;
   let alive=false;
   if(Number.isInteger(pending.owner_pid)&&pending.owner_pid>0){
    try{process.kill(pending.owner_pid,0);alive=true;}
    catch(error){if(error.code!=='ESRCH') alive=true;}
   }
   if(alive) continue;
   if(state.runs.some(r=>r.run_id===pending.run_id)){
    this.transaction(eventId,current=>{delete current.pending_run;});
    continue;
   }
   this.recordRun(eventId,{
    run_id:pending.run_id,started_at:pending.started_at,
    finished_at:new Date().toISOString(),success:false,
    reason:pending.reason||'restart_recovery',
    scope:pending.scope||['MATCH_IDENTITY','1X2','OU','ASIAN','KG'],
    series_found:0,error:'PROCESS_INTERRUPTED_DURING_COLLECTION',
    completion_time_is_recovery_time:true,
    source_continuity_verified:false,
    errors:[{phase:'RESTART_RECOVERY',error:'OWNER_PROCESS_EXITED'}]
   });
  }
 }
 recordRun(eventId,run){
  return this.transaction(eventId,state=>{
   if(!run.run_id||!run.started_at||!run.finished_at||
      typeof run.success!=='boolean') throw Error('RUN_METADATA_MISSING');
   if(state.runs.some(r=>r.run_id===run.run_id)) throw Error('RUN_ID_EXISTS');
   const previous=state.runs.filter(r=>r.success).at(-1);
   const gap=previous?
    (Date.parse(run.started_at)-Date.parse(previous.finished_at))/1000:null;
   if(!Number.isFinite(Date.parse(run.started_at))||
      !Number.isFinite(Date.parse(run.finished_at))||
      Date.parse(run.finished_at)<Date.parse(run.started_at)){
    throw Error('RUN_TIME_INVALID');
   }
   const saved={...clone(run),
    seconds_since_previous_success:gap===null?null:Math.max(0,gap)};
   const {crossedCheckpoints}=require('./checkpoints');
   state.checkpoints=state.checkpoints||[];
   state.checkpoints.push(...crossedCheckpoints(state,saved));
   state.runs.push(saved);
   if(state.pending_run?.run_id===run.run_id) delete state.pending_run;

   if(!run.success){
    state.interruptions.push({
     run_id:run.run_id,started_at:run.started_at,finished_at:run.finished_at,
     reason:run.error||'FETCH_FAILED',price_continuity_known:false
    });
   }
   return saved;
  });
 }
}
module.exports={StateStore};
