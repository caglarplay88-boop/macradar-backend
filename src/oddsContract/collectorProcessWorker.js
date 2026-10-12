'use strict';
const {getContractRuntime}=require('./runtime');
let runtime=null;
process.on('message',async message=>{
 if(!message||!Number.isInteger(message.id))return;
 try{
  runtime=runtime||getContractRuntime();
  let result;
  if(message.operation==='collect'){
   result=await runtime.collectTrackedMatch(message.job,message.options);
  }else if(message.operation==='tracking'){
   const state=runtime.setTracking(message.job,message.options.enabled);
   result={tracking:state.tracking||state,process_id:process.pid};
  }else throw Error('COLLECTOR_OPERATION_INVALID');
  if(process.connected)process.send({id:message.id,result});
 }catch(error){
  const value=String(error.message);
  const code=/^[A-Z0-9_]{1,100}$/.test(value)?value:'COLLECTOR_PROCESS_OPERATION_FAILED';
  if(process.connected)process.send({id:message.id,error:code,code:error.code});
 }
});
process.on('disconnect',()=>process.exit(0));
