'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {fork}=require('node:child_process');

// Collection stays in the single shared collector. Only package construction
// runs here, so preparing a large file cannot block the HTTP status endpoint.
function processPackageBuilder({directory,
 workerFile=path.join(__dirname,'exportProcessWorker.js'),
 timeoutMilliseconds=30*60*1000}={}){
 if(!path.isAbsolute(directory)||!Number.isFinite(timeoutMilliseconds)||
    timeoutMilliseconds<=0) throw Error('EXPORT_PROCESS_CONFIGURATION_INVALID');
 const spool=path.join(directory,'package-workers');
 fs.mkdirSync(spool,{recursive:true,mode:0o700});
 return async function build(_pool,eventId,options={}){
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(eventId)) throw Error('EXPORT_EVENT_ID_INVALID');
  const jobDirectory=fs.mkdtempSync(path.join(spool,'job-'));
  let worker;
  try{
   const result=await new Promise((resolve,reject)=>{
    let received=false,settled=false;
    const fail=code=>{if(!settled){settled=true;reject(Error(code));}};
    worker=fork(workerFile,[],{
     env:{...process.env,MACRADAR_ODDS_CONTRACT_DIRECTORY:directory},
     stdio:['ignore','inherit','inherit','ipc']
    });
    const timer=setTimeout(()=>{fail('EXPORT_PROCESS_TIMEOUT');worker.kill();},timeoutMilliseconds);
    timer.unref();
    const finish=()=>clearTimeout(timer);
    worker.on('message',message=>{
     if(received) return;
     received=true;
     if(message?.error){finish();fail(/^[A-Z0-9_]{1,100}$/.test(message.error)?message.error:'EXPORT_PROCESS_FAILED');return;}
     const value=message?.result;
     if(!value||value.filePath!==path.join(jobDirectory,'package.zip')||
        !/^[A-Za-z0-9._-]+\.zip$/.test(value.filename||'')){
      finish();fail('EXPORT_PROCESS_RESULT_INVALID');return;
     }
     finish();settled=true;resolve(value);
    });
    worker.on('error',()=>{finish();fail('EXPORT_PROCESS_FAILED');});
    worker.on('exit',()=>{finish();if(!received)fail('EXPORT_PROCESS_EXITED');});
    // Never serialize the raw state over IPC. The worker reads the atomically
    // committed state file after the shared collector has finished.
    const {state,onProgress,...packageOptions}=options;
    worker.send({eventId,jobDirectory,options:packageOptions},error=>{
     if(error){finish();fail('EXPORT_PROCESS_SEND_FAILED');}
    });
   });
   const stat=await fs.promises.lstat(result.filePath);
   if(!stat.isFile()) throw Error('EXPORT_PROCESS_ARTIFACT_INVALID');
   const buffer=await fs.promises.readFile(result.filePath);
   return {buffer,filename:result.filename,manifest:result.manifest,
    collectionStatus:result.collectionStatus};
  }finally{
   if(worker&&!worker.killed)worker.kill();
   fs.rmSync(jobDirectory,{recursive:true,force:true});
  }
 };
}
module.exports={processPackageBuilder};
