'use strict';
const {fork}=require('node:child_process');
const path=require('node:path');
function installProcessCollector(runtime){
 if(runtime.processCollectorInstalled)return runtime;
 let child=null,sequence=0;
 const pending=new Map();
 function connect(){
  if(child?.connected)return child;
  const worker=fork(path.join(__dirname,'collectorProcessWorker.js'),[],{
   env:{...process.env,MACRADAR_ODDS_CONTRACT_DIRECTORY:runtime.directory},
   execArgv:['--max-old-space-size=6144'],
   serialization:'advanced',stdio:['ignore','inherit','inherit','ipc']
  });
  child=worker;
  worker.on('message',message=>{
   const request=pending.get(message?.id);if(!request)return;
   pending.delete(message.id);
   if(message.error){const error=Error(message.error);error.code=message.code;request.reject(error);}
   else request.resolve(message.result);
  });
  const failed=()=>{
   if(child===worker)child=null;
   for(const [id,request] of pending){if(request.worker===worker){pending.delete(id);request.reject(Error('COLLECTOR_PROCESS_EXITED'));}}
  };
  worker.on('error',failed);worker.on('exit',failed);
  return worker;
 }
 function request(operation,job,options){
  return new Promise((resolve,reject)=>{
   const worker=connect(),id=++sequence;
   pending.set(id,{resolve,reject,worker});
   worker.send({id,operation,job,options},error=>{
    if(error&&pending.has(id)){pending.delete(id);reject(Error('COLLECTOR_PROCESS_SEND_FAILED'));}
   });
  });
 }
 runtime.collectTrackedMatch=async(job,options={})=>{
  const {eventId}=runtime.validateMatch(job);
  if(job.tracking_enabled===false)throw Error('TRACKING_DISABLED');
  const saved=(()=>{const state=runtime.readState(eventId);return state.match_identity||{};})();
  const now=Date.parse(runtime.clock()),kickoff=Date.parse(saved.kickoff);
  if(saved.identity_verified===true&&saved.kickoff_verified===true&&
     Number.isFinite(now)&&Number.isFinite(kickoff)&&now>=kickoff){
   await request('tracking',job,{enabled:false});
   return {eventId,skipped:true,reason:'PRE_MATCH_ENDED'};
  }
  return request('collect',job,options);
 };
 runtime.setTracking=(job,enabled)=>request('tracking',job,{enabled});
 runtime.closeProcessCollector=()=>{if(child)child.kill();};
 runtime.processCollectorInstalled=true;
 return runtime;
}
module.exports={installProcessCollector};
