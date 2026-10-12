
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {LimitedQueue}=require('./queue');
const idPattern=/^[a-f0-9-]{36}$/;
class ExportJobs{
 constructor({directory,build,concurrency=2,
  clock=()=>new Date().toISOString()}){
  if(!path.isAbsolute(directory)||typeof build!=='function'){
   throw Error('EXPORT_JOB_CONFIGURATION_INVALID');
  }
  this.directory=directory;this.build=build;this.clock=clock;
  this.queue=new LimitedQueue(concurrency);this.active=new Map();
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  for(const file of fs.readdirSync(directory)){
   if(!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
   const job=JSON.parse(fs.readFileSync(path.join(directory,file),'utf8'));
   if(job.status==='RUNNING'||job.status==='QUEUED'){
    this.write({...job,status:'INTERRUPTED',finished_at:this.clock(),
     interruption_reason:'BACKEND_RESTART',phase:'INTERRUPTED'});
   }
  }
 }
 metadataPath(id){
  if(!idPattern.test(id)) throw Error('EXPORT_JOB_ID_INVALID');
  return path.join(this.directory,id+'.json');
 }
 write(job){
  const destination=this.metadataPath(job.job_id);
  const temp=destination+'.tmp-'+crypto.randomUUID();
  const fd=fs.openSync(temp,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(job));fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  fs.renameSync(temp,destination);
 }
 read(id){
  const file=this.metadataPath(id);
  return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
 }
 publicStatus(job){
  if(!job) return null;
  return {
   job_id:job.job_id,event_id:job.event_id,status:job.status,phase:job.phase,
   requested_at:job.requested_at,started_at:job.started_at||null,
   finished_at:job.finished_at||null,error:job.error||null,
   interruption_reason:job.interruption_reason||null,
   filename:job.filename||null,bytes:job.bytes??null,sha256:job.sha256||null,
   collection_status:job.collection_status||null
  };
 }
 status(id,eventId){
  const job=this.read(id);
  if(!job||job.event_id!==eventId) return null;
  return this.publicStatus(job);
 }
 request(eventId){
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(eventId)){
   throw Error('EXPORT_EVENT_ID_INVALID');
  }
  const existing=this.active.get(eventId);
  if(existing) return this.publicStatus(this.read(existing));
  const job={
   job_id:crypto.randomUUID(),event_id:eventId,status:'QUEUED',
   phase:'QUEUED',requested_at:this.clock()
  };
  this.write(job);this.active.set(eventId,job.job_id);
  this.queue.run(job.job_id,async()=>{
   const running={...job,status:'RUNNING',phase:'PREPARING',started_at:this.clock()};
   this.write(running);
   try{
    const result=await this.build(eventId,{
     onProgress:phase=>{
      if(!['COLLECTING','BUILDING_PACKAGE'].includes(phase)){
       throw Error('EXPORT_PHASE_INVALID');
      }
      running.phase=phase;this.write(running);
     }
    });
    if(!Buffer.isBuffer(result.buffer)||!result.buffer.length||
       typeof result.filename!=='string'||
       !/^[A-Za-z0-9._-]+\.zip$/.test(result.filename)){
     throw Error('EXPORT_PACKAGE_INVALID');
    }
    const zipPath=path.join(this.directory,job.job_id+'.zip');
    const temp=zipPath+'.tmp';
    const fd=fs.openSync(temp,'wx',0o600);
    try{fs.writeFileSync(fd,result.buffer);fs.fsyncSync(fd);}
    finally{fs.closeSync(fd);}
    fs.renameSync(temp,zipPath);
    this.write({...running,status:'READY',phase:'READY',
     finished_at:this.clock(),filename:result.filename,
     bytes:result.buffer.length,
     collection_status:result.collectionStatus||null,
     sha256:crypto.createHash('sha256').update(result.buffer).digest('hex')});
   }catch(error){
    const code=String(error.code||error.message||'EXPORT_JOB_FAILED');
    this.write({...running,status:'FAILED',phase:'FAILED',
     finished_at:this.clock(),
     error:/^[A-Z0-9_]+$/.test(code)?code:'EXPORT_JOB_FAILED'});
   }finally{this.active.delete(eventId);}
  }).catch(()=>{this.active.delete(eventId);});
  return this.publicStatus(job);
 }
 ready(id,eventId){
  const job=this.read(id);
  if(!job||job.event_id!==eventId) throw Error('EXPORT_JOB_NOT_FOUND');
  if(job.status!=='READY') throw Error('EXPORT_JOB_NOT_READY');
  const buffer=fs.readFileSync(path.join(this.directory,id+'.zip'));
  const sha256=crypto.createHash('sha256').update(buffer).digest('hex');
  if(buffer.length!==job.bytes||sha256!==job.sha256){
   throw Error('EXPORT_PACKAGE_INTEGRITY_FAILED');
  }
  return {filename:job.filename,buffer,sha256,collectionStatus:job.collection_status||null};
 }
}
module.exports={ExportJobs};
