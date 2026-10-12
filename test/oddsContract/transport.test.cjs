
'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),os=require('os');
const path=require('path');
const {BetExplorerTransport,publicContext,contextId}=
 require('../../src/oddsContract/transport');
(async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'macradar-transport-'));
 try{
  let active=0,peak=0,called=0;
  const source={sourceName:'betexplorer-direct',sourceRegion:null,socksAddress:null};
  const executor=async(binary,args)=>{
   assert.equal(binary,'curl');
   const cookie=args.indexOf('--cookie');
   assert.equal(args[cookie+1],'my_timezone=+0');
   assert(args.includes('--compressed'));
   assert(!args.includes('--insecure'));
   active++;peak=Math.max(peak,active);called++;
   await new Promise(resolve=>setTimeout(resolve,10));
   active--;
   return {stdout:Buffer.from('{"odds":"<table></table>"}\nMACRADAR_HTTP_STATUS:200')};
  };
  const transport=new BetExplorerTransport({
   evidenceDirectory:directory,executor,concurrency:2
  });
  const url='https://www.betexplorer.com/match-odds/event/0/1x2/odds/?lang=en';
  const first=transport.fetchFromSource(source,url);
  assert.equal(first,transport.fetchFromSource(source,url));
  const results=await Promise.all([first,
   ...Array.from({length:4},(_,n)=>transport.fetchFromSource(
    source,url+'&test='+n))]);
  assert.equal(called,5);
  assert.equal(peak,2);
  for(const result of results){
   assert.equal(result.response_bytes,result.body.length);
   assert.equal(result.http_status,200);
   assert(!result.body.toString().includes('MACRADAR_HTTP_STATUS:'));
   assert.equal(JSON.parse(result.body.toString()).odds,'<table></table>');
   assert(Date.parse(result.observed_at)>=Date.parse(result.capture_started_at));
   assert.equal(result.source_context.timezone_preference.offset_minutes,0);
   assert.equal(result.source_context.account_context,'ANONYMOUS');
  }
  assert.notEqual(contextId(publicContext(source)),contextId(publicContext({
   ...source,sourceName:'betexplorer-nl',sourceRegion:'nl'
  })));
  assert.throws(()=>transport.fetchFromSource(source,'https://example.com/'));
  const broken=new BetExplorerTransport({
   evidenceDirectory:directory,executor:async()=>{
    const error=Error('timeout');error.code=28;throw error;
   }
  });
  await assert.rejects(broken.fetchFromSource(source,url),error=>
   error.capture.error.code==='CURL_EXIT_28'&&
   error.capture.success===false);
  const invalid=new BetExplorerTransport({
   evidenceDirectory:directory,executor:async()=>({stdout:Buffer.from('invalid')})
  });
  await assert.rejects(invalid.fetchJsonFromSource(source,url),/SOURCE_JSON_INVALID/);
  
const httpFailure=new BetExplorerTransport({
 evidenceDirectory:directory,executor:async()=>{
  const error=Error('HTTP failure');
  error.code=22;
  error.stdout=Buffer.from('\nMACRADAR_HTTP_STATUS:404');
  throw error;
 }
});
await assert.rejects(httpFailure.fetchFromSource(source,url),error=>
 error.capture.http_status===404&&
 error.capture.error.code==='CURL_EXIT_22');
console.log('HTTP_DURUMU_VE_KAYNAK_GOVDESINI_AYRI_KORUMA: GECTI');

assert(fs.readdirSync(directory).filter(x=>x.endsWith('.response')).length>=7);
  console.log('MEVCUT_CURL_SAAT_AYARI_HAM_YANIT_VE_KUYRUK: GECTI');
  console.log('BAGLAM_AYRIMI_ZAMAN_ASIMI_VE_GECERSIZ_JSON: GECTI');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
