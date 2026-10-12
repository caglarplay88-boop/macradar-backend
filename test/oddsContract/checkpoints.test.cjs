
'use strict';
const assert=require('node:assert/strict');
const {crossedCheckpoints}=require('../../src/oddsContract/checkpoints');
const kickoff='2026-10-12T12:00:00.000Z';
const state={
 match_identity:{event_id:'e',kickoff,kickoff_verified:true,raw_evidence_ref:'proof'},
 runs:[{finished_at:'2026-10-12T10:59:00.000Z'}],
 odds_raw:{
  before:{record_id:'before',observed_at:'2026-10-12T10:58:00.000Z',
   source_timestamp:null},
  late:{record_id:'late',observed_at:'2026-10-12T11:01:00.000Z',
   source_timestamp:'2026-10-12T10:00:00.000Z'},
  future:{record_id:'future',observed_at:'2026-10-12T10:58:00.000Z',
   source_timestamp:'2026-10-12T11:01:00.000Z'}
 }
};
const run={run_id:'r',started_at:'2026-10-12T10:59:30.000Z',
 finished_at:'2026-10-12T11:02:00.000Z',success:true};
const original=JSON.stringify(state);
const points=crossedCheckpoints(state,run);
assert.equal(points.length,1);
assert.equal(points[0].name,'T_MINUS_60_MINUTES');
assert.deepEqual(points[0].known_raw_record_ids,['before']);
assert.equal(points[0].analysis_cutoff,'2026-10-12T11:00:00.000Z');
assert.equal(points[0].exact_source_scan_at_cutoff_claimed,false);
assert(points[0].excluded_records.find(x=>x.record_id==='late')
 .reasons.includes('OBSERVED_AFTER_CUTOFF'));
assert.equal(JSON.stringify(state),original);
assert.equal(crossedCheckpoints({...state,checkpoints:points},run).length,0);
assert.equal(crossedCheckpoints({...state,runs:[]},{
 ...run,started_at:'2026-10-12T11:01:00.000Z'
}).length,0);
assert.equal(crossedCheckpoints({...state,match_identity:{
 ...state.match_identity,kickoff_verified:false
}},run).length,0);
const failed=crossedCheckpoints(state,{...run,success:false});
assert.equal(failed[0].collection_succeeded,false);
const all=crossedCheckpoints({...state,runs:[]},{
 ...run,started_at:'2026-10-11T11:59:00.000Z',
 finished_at:'2026-10-12T11:51:00.000Z'
});
assert.equal(all.length,4);
const moved=crossedCheckpoints({...state,checkpoints:points,
 match_identity:{...state.match_identity,kickoff:'2026-10-12T12:01:00.000Z'}
},run);
assert.equal(moved.length,1);
assert.notEqual(moved[0].checkpoint_id,points[0].checkpoint_id);
console.log('DORT_KONTROL_NOKTASI_GEC_BASLANGIC_VE_KESIM_SIZINTISI: GECTI');
console.log('TEKRAR_KAYIT_KESINTI_VE_BASLAMA_DEGISIMI: GECTI');
