
'use strict';
const assert=require('node:assert/strict');
const {buildSettings,collectionSchedule,retryDelaySeconds}=
  require('../../src/oddsContract/settings');
const now='2026-10-11T12:00:00.000Z';
const at=hours=>new Date(Date.parse(now)+hours*3600000).toISOString();
let checked=0;
for(const [hours,current,history] of [
 [73,60,30],[72,30,30],[25,30,30],[24,10,30],
 [7,10,30],[6,5,10],[2,5,10],[1,2,10],[0.25,2,10]
]){
 const result=collectionSchedule({now,kickoff:at(hours),kickoffVerified:true});
 assert.equal(result.currentMinutes,current);
 assert.equal(result.historyMinutes,history);
 checked++;
}
for(const hours of [0,-1]){
 assert.equal(collectionSchedule({
  now,kickoff:at(hours),kickoffVerified:true
 }).stopPreMatch,true);
 checked++;
}
for(const kickoff of [null,'2026-10-12 19:30','not-a-date']){
 const result=collectionSchedule({now,kickoff,kickoffVerified:true});
 assert.equal(result.hoursToKickoff,null);
 assert.equal(result.mainAnalysisEligible,false);
 checked++;
}
assert.equal(collectionSchedule({
 now,kickoff:at(2),kickoffVerified:false
}).reason,'KICKOFF_UNVERIFIED');
const settings=buildSettings({
 scheduling:{currentMinutes:{lastHour:3},historyMinutesWithinLast6Hours:12}
});
assert.equal(collectionSchedule({
 now,kickoff:at(0.5),kickoffVerified:true,settings
}).currentMinutes,3);
assert.equal(collectionSchedule({
 now,kickoff:at(0.5),kickoffVerified:true,settings
}).historyMinutes,12);
assert.deepEqual([1,2,3,20].map(n=>retryDelaySeconds(n)),[60,120,240,1800]);
assert.throws(()=>buildSettings({scheduling:{maxConcurrentMatches:0}}));
assert.throws(()=>buildSettings({scheduling:{maxConcurrentMatches:1.5}}));
assert.throws(()=>buildSettings({scheduling:{retryMaximumSeconds:1}}));
assert.throws(()=>buildSettings({scheduling:{currentMinutes:{lastHour:NaN}}}));
assert.throws(()=>collectionSchedule({now:'2026-10-11 12:00'}));
console.log('TAKVIM_SINIRLARI_BELIRSIZ_SAAT_AYAR_VE_BACKOFF: GECTI');
console.log('ZAMAN_SENARYOLARI: '+checked);
