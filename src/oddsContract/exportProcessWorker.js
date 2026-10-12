'use strict';
const fs=require('node:fs');
const path=require('node:path');
let handled=false;
process.on('disconnect',()=>process.exit(0));
process.on('message',async message=>{
 if(handled)return;
 handled=true;
 let pool;
 try{
  const {eventId,jobDirectory,options}=message;
  const {StateStore}=require('./stateStore');
  const directory=process.env.MACRADAR_ODDS_CONTRACT_DIRECTORY;
  if(!path.isAbsolute(directory)||!path.isAbsolute(jobDirectory))throw Error('EXPORT_PROCESS_CONFIGURATION_INVALID');
  // A package reader must not recover or change collection state.
  const store=new StateStore(path.join(directory,'state'),{recoverInterruptedRuns:false});
  pool=require('../db').pool;
  const {buildMatchExport}=require('../matchDataExport');
  const result=await buildMatchExport(pool,eventId,{...options,state:store.read(eventId)});
  const filePath=path.join(jobDirectory,'package.zip');
  fs.writeFileSync(filePath,result.buffer,{flag:'wx',mode:0o600});
  if(process.connected)process.send({result:{filePath,filename:result.filename,
   manifest:result.manifest,collectionStatus:result.collectionStatus}});
 }catch(error){
  const code=String(error.code||error.message||'EXPORT_PACKAGE_FAILED');
  if(process.connected)process.send({error:/^[A-Z0-9_]{1,100}$/.test(code)?code:'EXPORT_PACKAGE_FAILED'});
 }finally{if(pool)await pool.end().catch(()=>{});}
});
