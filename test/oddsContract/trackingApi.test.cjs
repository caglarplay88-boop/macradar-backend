
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../src/server.js'),'utf8');
const marker="const eventId = eventFromPath(u.pathname, 'tracking');";
const start=source.indexOf(marker);
assert(start>=0);
const finish=source.indexOf('if (!settings) return json(res, 404',start);
assert(finish>start);
const handlerBody=source.slice(start,finish)+'return settings;';
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const handler=new AsyncFunction('eventFromPath','u','readJson',
 'ALLOWED_ODDS_REFRESH_MINUTES','pool','json','res',
 'updateTrackingSettings','req',handlerBody);
(async()=>{
 let writes=0;
 const invoke=async(match,body)=>{
  return handler(()=> 'event',{pathname:'/api/matches/event/tracking'},
   async()=>body,new Set([5,15,30,60,120]),
   {query:async()=>({rows:match?[match]:[]})},
   (_,status,data)=>({status,data}),{},
   async(id,enabled,minutes)=>{
    writes++;
    return {event_id:id,tracking_enabled:enabled,refresh_minutes:minutes};
   },{});
 };
 const valid={active:true,archived:false,lifecycle:'tracking'};
 assert.equal((await invoke(valid,{enabled:true,minutes:60})).tracking_enabled,true);
 assert.equal(writes,1);
 assert.equal((await invoke(null,{enabled:true,minutes:60})).status,404);
 assert.equal((await invoke({...valid,lifecycle:'started'},
  {enabled:true,minutes:60})).status,409);
 assert.equal((await invoke(valid,{enabled:'yes',minutes:60})).status,400);
 assert.equal((await invoke(valid,{enabled:true,minutes:7})).status,400);
 assert.equal(writes,1);
 assert.equal((await invoke({...valid,lifecycle:'started'},
  {enabled:false,minutes:60})).tracking_enabled,false);
 assert.equal(writes,2);
 assert(!handlerBody.includes('captureInitial1x2'));
 assert(!handlerBody.includes('getLatestOdds1x2Batch'));
 console.log('GERCEK_API_BLOGU_KAYNAK_CEKMEDEN_KUYRUKLAMA_VE_KIMLIK_DURUM_KONTROLLERI: GECTI');
})().catch(e=>{console.error(e);process.exitCode=1;});
