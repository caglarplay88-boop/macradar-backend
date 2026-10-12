
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {exportJobReply}=require('../../src/oddsContract/exportApi');
const id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
let requests=0,readyCalls=0,found=true,state='RUNNING';
const pool={async query(sql,args){
 assert.equal(args[0],'event123');
 return {rows:found?[{event_id:'event123'}]:[]};
}};
const jobs={
 request(eventId){requests++;return {event_id:eventId,job_id:id,status:'QUEUED'};},
 status(jobId,eventId){
  return eventId==='event123'&&jobId===id?
   {event_id:eventId,job_id:id,status:state}:null;
 },
 ready(){readyCalls++;return {buffer:Buffer.from('zip'),filename:'test.zip'};}
};
const invoke=(query,eventId='event123')=>exportJobReply({
 pool,jobs,eventId,url:new URL('https://example.test/export'+query)
});
(async()=>{
 assert.equal(await invoke(''),null);
 const prepared=await invoke('?prepare=1');
 assert.equal(prepared.status,202);assert.equal(requests,1);
 assert.equal((await invoke('?job='+id+'&status=1')).status,200);
 assert.equal((await invoke('?job='+id)).status,202);
 assert.equal(readyCalls,0);
 state='READY';
 assert(Buffer.isBuffer((await invoke('?job='+id)).package.buffer));
 assert.equal(readyCalls,1);
 assert.equal((await invoke('?job='+id,'different')).status,404);
 assert.equal((await invoke('?job=../../secret')).status,400);
 state='FAILED';
 assert.equal((await invoke('?job='+id)).status,409);
 found=false;
 assert.equal((await invoke('?prepare=1')).status,404);
 assert.equal((await invoke('?prepare=1&job='+id)).status,400);
 assert.equal((await invoke('?status=1')).status,400);
 const server=fs.readFileSync(path.join(__dirname,'../../src/server.js'),'utf8');
 const auth=server.lastIndexOf('if (!authorized(req))',server.indexOf('// MACRADAR_MATCH_EXPORT_ROUTE'));
 const route=server.indexOf('// MACRADAR_MATCH_EXPORT_ROUTE');
 const hook=server.indexOf("require('./oddsContract/exportApi')",route);
 assert(auth>=0&&auth<route&&hook>route);
 assert(server.slice(route,hook+1200).includes('exportJobReply'));
 console.log('PAKET_HAZIRLAMA_DURUM_INDIRME_VE_MAC_KIMLIGI: GECTI');
 console.log('YETKILENDIRME_MEVCUT_EXPORT_ROTASINDA_KORUNDU: GECTI');
})().catch(error=>{console.error(error);process.exitCode=1;});
