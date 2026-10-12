
'use strict';
const {collectionSchedule}=require('./settings');
const {getContractRuntime}=require('./runtime');
function trackingContractStatus(eventId,{
 runtime=null,now=new Date().toISOString()
}={}){
 const state=runtime?runtime.readState(eventId):require('./quoteReader').readRuntimeState(eventId);
 runtime=runtime||getContractRuntime();
 const identity=state.match_identity||{};
 const schedule=collectionSchedule({
  now,kickoff:identity.kickoff,kickoffVerified:identity.kickoff_verified===true,
  settings:runtime.settings
 });
 const last=(state.runs||[]).at(-1)||null;
 return {
  tracking_schedule_mode:'adaptive',
  effective_refresh_minutes:schedule.currentMinutes,
  history_reconciliation_minutes:schedule.historyMinutes,
  schedule_reason:schedule.reason,
  next_scheduled_scan_at:state.tracking.retry_not_before||
   state.tracking.next_current_scan_at||null,
  retry_not_before:state.tracking.retry_not_before||null,
  verified_kickoff:identity.kickoff_verified?identity.kickoff:null,
  source_identity_verified:identity.identity_verified===true,
  period_verified:identity.period_verified===true,
  last_collection_result:last?{
   run_id:last.run_id,success:last.success,finished_at:last.finished_at,
   error:last.error||null,odds_collection_performed:last.odds_collection_performed!==false
  }:null,
  collection_settings:runtime.settings.scheduling,
  settings_basis:'CONFIGURABLE_PROGRAM_SETTINGS_NOT_SOURCE_UPDATE_FREQUENCY',
  legacy_refresh_minutes_not_applied_to_adaptive_schedule:true,
  collector_execution_location:'SERVER',
  phone_background_restrictions_pause_server_collection:false
 };
}
module.exports={trackingContractStatus};
