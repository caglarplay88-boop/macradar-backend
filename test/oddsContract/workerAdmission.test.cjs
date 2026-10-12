'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
let source=fs.readFileSync(path.join(__dirname,'../../src/odds1x2Worker.js'),'utf8');
const start=source.indexOf('async function capturePeriodic1x2(job) {');
const end=source.indexOf('\nasync function runOddsWorkerTick(',start);
source=source.slice(0,start)+'async function capturePeriodic1x2(job){return testCapture(job);}\n'+source.slice(end);
const calls=[],release={};
let due=[{event_id:'a'}];
const moduleObject={exports:{}};
vm.runInNewContext(source,{
 module:moduleObject,exports:moduleObject.exports,console:{log(){},error(){}},
 process:{env:{}},setTimeout,clearTimeout,setInterval,clearInterval,
 testCapture(job){calls.push(job.event_id);return new Promise(resolve=>{
  release[job.event_id]=()=>resolve({eventId:job.event_id,skipped:false,inserted:1});
 });},
 require(name){
  if(name==='./db')return {listDueTrackingJobs:async()=>due};
  if(name==='./oddsContract/runtime')return {getContractRuntime:()=>({settings:{scheduling:{maxConcurrentMatches:2}}})};
  if(['./odds1x2','./oddsOverUnder','./oddsAsian','./oddsKg'].includes(name))return {};
  throw Error('UNEXPECTED_REQUIRE:'+name);
 }
});
const tick=moduleObject.exports.runOddsWorkerTick;
(async()=>{
 assert.equal((await tick({waitForJobs:false})).admitted,1);
 due=[{event_id:'a'},{event_id:'b'},{event_id:'c'}];
 assert.equal((await tick({waitForJobs:false})).admitted,1);
 assert.deepEqual(calls,['a','b'],'New match must start before first archive task finishes');
 assert.equal((await tick({waitForJobs:false})).reason,'worker-capacity');
 assert.deepEqual(calls,['a','b'],'No duplicate or excess concurrent job');
 release.a();await new Promise(resolve=>setTimeout(resolve,0));
 due=[{event_id:'b'},{event_id:'c'}];
 assert.equal((await tick({waitForJobs:false})).admitted,1);
 assert.deepEqual(calls,['a','b','c']);
 release.b();release.c();await new Promise(resolve=>setTimeout(resolve,0));
 due=[];
 const empty=await tick();assert.equal(empty.processed,0);assert.equal(empty.in_flight,0);
 console.log('NEW_TRACKING_DISCOVERY_DURING_HISTORY_BOUNDED_NO_DUPLICATE: PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;});
