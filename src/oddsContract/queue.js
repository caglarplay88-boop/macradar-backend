
'use strict';
class LimitedQueue {
 constructor(limit=2){
  if(!Number.isInteger(limit)||limit<1) throw Error('INVALID_QUEUE_LIMIT');
  this.limit=limit;this.active=0;this.pending=[];this.jobs=new Map();
 }
 run(key,task){
  if(typeof key!=='string'||!key||typeof task!=='function'){
   throw Error('INVALID_QUEUE_JOB');
  }
  if(this.jobs.has(key)) return this.jobs.get(key);
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  this.jobs.set(key,promise);
  this.pending.push({key,task,resolve,reject});
  this.drain();
  return promise;
 }
 drain(){
  while(this.active<this.limit&&this.pending.length){
   const job=this.pending.shift();
   this.active++;
   const complete=(settle,value)=>{
     this.active--;this.jobs.delete(job.key);this.drain();
     settle(value);
    };
    Promise.resolve().then(job.task).then(
     value=>complete(job.resolve,value),
     error=>complete(job.reject,error)
    );
  }
 }
 status(){
  return {limit:this.limit,active:this.active,pending:this.pending.length,
   uniqueJobs:this.jobs.size};
 }
}
module.exports={LimitedQueue};
