
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {ExportJobs}=require('../../src/oddsContract/exportJobs');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'macradar-export-jobs-'));
const original=fs.readFileSync(path.join(__dirname,
 '../../artifacts/match_exports/app-export-test-20261011T073059Z/MacRadar-0p1XkgIt-1791703861588.zip'));
let calls=0,active=0,peak=0;
const jobs=new ExportJobs({directory,concurrency:2,build:async(id,{onProgress})=>{
 calls++;active++;peak=Math.max(peak,active);
 onProgress('COLLECTING');
 await new Promise(resolve=>setTimeout(resolve,5));
 onProgress('BUILDING_PACKAGE');
 active--;
 if(id==='failed') throw Error('EXPECTED_SOURCE_FAILURE');
 return {filename:'MacRadar-test.zip',buffer:original};
}});
const wait=async(job)=>{
 for(let i=0;i<100;i++){
  const status=jobs.status(job.job_id,job.event_id);
  if(['READY','FAILED'].includes(status.status)) return status;
  await new Promise(resolve=>setTimeout(resolve,2));
 }
 throw Error('TEST_JOB_WAIT_TIMEOUT');
};
(async()=>{
 try{
  const first=jobs.request('event');
  assert.equal(jobs.request('event').job_id,first.job_id);
  const second=jobs.request('second');
  const third=jobs.request('third');
  const finished=await Promise.all([first,second,third].map(wait));
  assert(finished.every(j=>j.status==='READY'));
  assert.equal(calls,3);assert(peak<=2);
  assert.equal(jobs.status(first.job_id,'other'),null);
  assert.deepEqual(jobs.ready(first.job_id,'event').buffer,original);
  const restarted=new ExportJobs({directory,build:async()=>{
   throw Error('SHOULD_NOT_BUILD_READY_JOB');
  }});
  assert.equal(restarted.status(first.job_id,'event').status,'READY');
  assert.deepEqual(restarted.ready(first.job_id,'event').buffer,original);
  const failed=await wait(jobs.request('failed'));
  assert.equal(failed.status,'FAILED');
  assert.equal(failed.error,'EXPECTED_SOURCE_FAILURE');
  assert.throws(()=>jobs.ready(failed.job_id,'failed'),/EXPORT_JOB_NOT_READY/);
  fs.appendFileSync(path.join(directory,first.job_id+'.zip'),'CORRUPT');
  assert.throws(()=>jobs.ready(first.job_id,'event'),/EXPORT_PACKAGE_INTEGRITY_FAILED/);
  const interruptedId='11111111-1111-1111-1111-111111111111';
  fs.writeFileSync(path.join(directory,interruptedId+'.json'),JSON.stringify({
   job_id:interruptedId,event_id:'interrupted',status:'RUNNING',phase:'COLLECTING'
  }));
  const recovered=new ExportJobs({directory,build:async()=>({})});
  assert.equal(recovered.status(interruptedId,'interrupted').status,'INTERRUPTED');
  assert.equal(recovered.status(interruptedId,'interrupted').interruption_reason,'BACKEND_RESTART');
  console.log('TEKRAR_INDIRME_TEK_IS_KUYRUK_SINIRI_VE_KALICI_DURUM: GECTI');
  console.log('GERCEK_ZIP_BYTE_KORUMA_HASH_BOZULMA_VE_YENIDEN_BASLATMA: GECTI');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
