
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {promisify}=require('node:util');
const {execFile}=require('node:child_process');
const {sourceChain,_contractTransport}=require('../odds1x2');
const {LimitedQueue}=require('./queue');
const exec=promisify(execFile);
function publicContext(source){
 return {
  source:'BetExplorer',transport:source.sourceName,
  configured_region:source.sourceRegion??null,
  actual_exit_region_verified:false,language:'en',
  timezone_preference:{kind:'FIXED_OFFSET',offset_minutes:0},
  account_context:'ANONYMOUS',
  bookmaker_group:null
 };
}
function contextId(context){
 return 'context-'+crypto.createHash('sha256')
  .update(JSON.stringify(context)).digest('hex');
}
class BetExplorerTransport {
 constructor({evidenceDirectory,concurrency=2,executor=exec}){
  if(typeof evidenceDirectory!=='string'||!path.isAbsolute(evidenceDirectory)){
   throw Error('EVIDENCE_DIRECTORY_REQUIRES_ABSOLUTE_PATH');
  }
  this.directory=evidenceDirectory;
  fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
  this.queue=new LimitedQueue(concurrency);
  this.executor=executor;
 }
 fetchFromSource(source,url){
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||parsed.hostname!=='www.betexplorer.com'){
   throw Error('UNSUPPORTED_SOURCE_URL');
  }
  const context=publicContext(source);
  const id=contextId(context);
  return this.queue.run(id+'|'+url,async()=>{
   const startedAt=new Date().toISOString();
   const evidenceId=crypto.randomUUID();
   const responseFile=path.join(this.directory,evidenceId+'.response');
   const metadataFile=path.join(this.directory,evidenceId+'.json');
   const args=_contractTransport.curlArgs(source,url);
   args.splice(args.length-1,0,'--cookie','my_timezone=+0',
    '--write-out','\nMACRADAR_HTTP_STATUS:%{http_code}');
   let body=Buffer.alloc(0),failure=null;
   try{
    const response=await this.executor('curl',args,{
     encoding:'buffer',maxBuffer:12*1024*1024,timeout:30000
    });
    body=Buffer.isBuffer(response.stdout)?response.stdout:Buffer.from(response.stdout||'');
   }catch(error){
    body=Buffer.isBuffer(error.stdout)?error.stdout:Buffer.from(error.stdout||'');
    failure={
     code:typeof error.code==='number'?'CURL_EXIT_'+error.code:
      String(error.code||'SOURCE_REQUEST_FAILED'),
     timed_out:error.killed===true||error.code===28
    };
   }
   const trailer=body.toString('utf8').match(/\nMACRADAR_HTTP_STATUS:(\d{3})$/);
   let httpStatus=null;
   if(trailer){
    const value=Number(trailer[1]);
    httpStatus=value>=100&&value<=599?value:null;
    body=body.subarray(0,body.length-Buffer.byteLength(trailer[0]));
   }
   const receivedAt=new Date().toISOString();
   fs.writeFileSync(responseFile,body,{mode:0o600});
   const metadata={
    request_id:evidenceId,source_url:url,source_context_id:id,
    source_context:context,capture_started_at:startedAt,
    observed_at:receivedAt,capture_finished_at:receivedAt,
    success:failure===null,error:failure,http_status:httpStatus,
    response_bytes:body.length,
    response_sha256:crypto.createHash('sha256').update(body).digest('hex')
   };
   fs.writeFileSync(metadataFile,JSON.stringify(metadata),{mode:0o600});
   if(failure){
    const error=Error(failure.code);
    error.capture=metadata;throw error;
   }
   return {...metadata,body,source};
  });
 }
 async fetchJsonFromSource(source,url){
  const captured=await this.fetchFromSource(source,url);
  try{return {...captured,payload:JSON.parse(captured.body.toString('utf8'))};}
  catch{
   const error=Error('SOURCE_JSON_INVALID');
   error.capture={...captured,body:undefined,source:undefined,
    success:false,error:{code:'SOURCE_JSON_INVALID'}};
   throw error;
  }
 }

 async fetchTextWithFailover(url){
  const attempts=[];
  for(const source of sourceChain()){
   try{
    const captured=await this.fetchFromSource(source,url);
    const html=captured.body.toString('utf8');
    if(!html.trim()){
     const error=Error('SOURCE_PAGE_EMPTY');
     error.capture=captured;throw error;
    }
    attempts.push({
     source:source.sourceName,success:true,http_status:captured.http_status,
     observed_at:captured.observed_at
    });
    return {...captured,html,attempts};
   }catch(error){
    attempts.push({
     source:source.sourceName,success:false,
     error:error.message,http_status:error.capture?.http_status??null,
     observed_at:error.capture?.observed_at??null,
     source_context_id:error.capture?.source_context_id??null
    });
   }
  }
  const error=Error('ALL_BETEXPLORER_PAGE_SOURCES_FAILED');
  error.attempts=attempts;throw error;
 }
 async fetchJsonWithFailover(url){
  const attempts=[];
  for(const source of sourceChain()){
   try{
    const captured=await this.fetchJsonFromSource(source,url);
    attempts.push({
     source_context_id:captured.source_context_id,success:true,http_status:captured.http_status,
     started_at:captured.capture_started_at,finished_at:captured.capture_finished_at
    });
    return {...captured,attempts};
   }catch(error){
    attempts.push({
     source_context_id:error.capture?.source_context_id||contextId(publicContext(source)),
     success:false,error:error.capture?.error?.code||error.message,http_status:error.capture?.http_status??null,
     started_at:error.capture?.capture_started_at||null,
     finished_at:error.capture?.capture_finished_at||null
    });
   }
  }
  const error=Error('ALL_BETEXPLORER_SOURCES_FAILED');
  error.attempts=attempts;throw error;
 }
}
module.exports={BetExplorerTransport,publicContext,contextId};
