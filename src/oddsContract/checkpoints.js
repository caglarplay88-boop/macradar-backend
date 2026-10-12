
'use strict';
const crypto=require('node:crypto');
const WINDOWS=[['T_MINUS_24_HOURS',86400],['T_MINUS_6_HOURS',21600],
 ['T_MINUS_60_MINUTES',3600],['T_MINUS_10_MINUTES',600]];
function crossedCheckpoints(state,run){
 const identity=state.match_identity;
 if(identity?.kickoff_verified!==true) return [];
 const kickoff=Date.parse(identity.kickoff);
 const finish=Date.parse(run.finished_at);
 const previous=(state.runs||[]).at(-1);
 const start=Date.parse(previous?.finished_at||run.started_at);
 if(![kickoff,finish,start].every(Number.isFinite)||start>finish) return [];
 const raw=Array.isArray(state.odds_raw)?
  state.odds_raw:Object.values(state.odds_raw||{});
 const existing=new Set((state.checkpoints||[]).map(x=>x.checkpoint_id));
 const results=[];
 for(const [name,seconds] of WINDOWS){
  const boundary=kickoff-seconds*1000;
  if(!(start<boundary&&boundary<=finish)) continue;
  const cutoff=new Date(boundary).toISOString();
  const id=crypto.createHash('sha256').update(JSON.stringify([
   identity.event_id||raw[0]?.event_id||null,identity.kickoff,name
  ])).digest('hex');
  if(existing.has(id)) continue;
  const known=[],excluded=[];
  for(const record of raw){
   const observed=Date.parse(record.observed_at);
   const source=record.source_timestamp?Date.parse(record.source_timestamp):null;
   const reasons=[];
   if(!Number.isFinite(observed)) reasons.push('OBSERVATION_TIME_UNVERIFIED');
   else if(observed>boundary) reasons.push('OBSERVED_AFTER_CUTOFF');
   if(source!==null){
    if(!Number.isFinite(source)) reasons.push('SOURCE_TIME_INVALID');
    else if(source>boundary) reasons.push('SOURCE_TIME_AFTER_CUTOFF');
   }
   if(reasons.length) excluded.push({record_id:record.record_id,reasons});
   else known.push(record.record_id);
  }
  results.push({
   checkpoint_id:id,name,analysis_cutoff:cutoff,analysis_mode:'strict_as_of',
   verified_kickoff:identity.kickoff,
   kickoff_evidence_ref:identity.raw_evidence_ref||null,
   recorded_at:run.finished_at,recording_run_id:run.run_id,
   previous_collection_finished_at:previous?.finished_at||null,
   collection_succeeded:run.success,
   known_raw_record_ids:known,excluded_records:excluded,
   kind:'TRACKED_CUTOFF_KNOWLEDGE',
   exact_source_scan_at_cutoff_claimed:false,
   historical_backfill_is_observed_checkpoint:false
  });
 }
 return results;
}
module.exports={crossedCheckpoints};
