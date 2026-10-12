
'use strict';
const assert=require('node:assert/strict');
const {trackingContractStatus}=require('../../src/oddsContract/trackingStatus');
const {buildSettings}=require('../../src/oddsContract/settings');
const state={tracking:{next_current_scan_at:'2026-10-11T12:02:00Z'},
 match_identity:{identity_verified:true,kickoff_verified:true,
  kickoff:'2026-10-11T12:30:00Z',period_verified:false},runs:[]};
const runtime={settings:buildSettings(),readState(){return state;}};
let result=trackingContractStatus('e',{runtime,now:'2026-10-11T12:00:00Z'});
assert.equal(result.effective_refresh_minutes,2);
assert.equal(result.history_reconciliation_minutes,10);
assert.equal(result.period_verified,false);
assert.equal(result.collector_execution_location,'SERVER');
state.tracking.retry_not_before='2026-10-11T12:10:00Z';
result=trackingContractStatus('e',{runtime,now:'2026-10-11T12:00:00Z'});
assert.equal(result.next_scheduled_scan_at,state.tracking.retry_not_before);
state.match_identity.kickoff_verified=false;
assert.equal(trackingContractStatus('e',{runtime,now:'2026-10-11T12:00:00Z'})
 .effective_refresh_minutes,60);
state.match_identity.kickoff_verified=true;
assert.equal(trackingContractStatus('e',{runtime,now:'2026-10-11T13:00:00Z'})
 .effective_refresh_minutes,null);
console.log('API_OTOMATIK_TAKVIM_BELIRSIZ_SAAT_VE_BACKOFF: GECTI');
