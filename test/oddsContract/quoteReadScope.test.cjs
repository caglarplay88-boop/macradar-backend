'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const runtime=require('../../src/oddsContract/runtime');
const reader=require('../../src/oddsContract/quoteReader');
const fixture=JSON.parse(fs.readFileSync(path.join(process.argv[2],'raw-parser-1X2.json'),'utf8'));
fixture.tracking={initialized:true};
let reads=0;
const original=runtime.getContractRuntime;
runtime.getContractRuntime=()=>({readState(){reads++;return JSON.parse(JSON.stringify(fixture));}});
(async()=>{
 await reader.withQuoteReadScope(async()=>{
  assert.equal(reader.readRuntimeBatch('event','1X2',{captureType:'opening'}).batch,null);
  await Promise.resolve();
  const first=reader.readRuntimeBatch('event','1X2',{captureType:'current'}).batch;
  const order=first.rows.map(r=>r.quote_group_id);
  const second=reader.readRuntimeBatch('event','1X2',{captureType:'current',latestOnly:true}).batch;
  reader.readRuntimeHistory('event','1X2',{page:1});
  reader.readRuntimeSourceOpenings('event','1X2');
  assert.deepEqual(first.rows.map(r=>r.quote_group_id),order,'A second read must not mutate the first batch');
  assert(second.rows.length>0);assert.equal(reads,1);
 });
 await reader.withQuoteReadScope(()=>reader.readRuntimeBatch('event','1X2',{}));
 assert.equal(reads,2,'A new request must reload source state');
 reader.readRuntimeBatch('event','1X2',{});
 assert.equal(reads,3,'Unscoped reads must remain fresh');
 console.log('REQUEST_SNAPSHOT_ONE_READ_AND_NO_CROSS_REQUEST_STALE_CACHE: PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;})
 .finally(()=>{runtime.getContractRuntime=original;});
