'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const runtime=require('../../src/oddsContract/runtime'),q=require('../../src/oddsContract/quoteReader');
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'quote-file-cache-'));
const file=path.join(folder,'event.json');
const source=JSON.parse(fs.readFileSync(path.join(process.argv[2],'raw-parser-1X2.json'),'utf8'));
source.tracking={initialized:true};let reads=0;const original=runtime.getContractRuntime;
runtime.getContractRuntime=()=>({collector:{store:{file(){return file;}}},readState(){reads++;return JSON.parse(fs.readFileSync(file));}});
function read(){return q.withQuoteReadScope(()=>q.readRuntimeBatch('event','1X2').batch);}
try{
 fs.writeFileSync(file,JSON.stringify(source));
 const before=read();read();assert.equal(reads,1);
 const ids=before.rows[0].raw_record_ids;
 for(const r of Object.values(source.odds_raw))if(ids.includes(r.record_id))r.odds_decimal=9.91;
 fs.writeFileSync(file+'.new',JSON.stringify(source));fs.renameSync(file+'.new',file);
 const after=read();assert.equal(reads,2);
 assert(after.rows.some(r=>[r.home_odd,r.draw_odd,r.away_odd].includes(9.91)));
 assert(!before.rows.some(r=>[r.home_odd,r.draw_odd,r.away_odd].includes(9.91)));
 fs.unlinkSync(file);
 runtime.getContractRuntime=()=>({collector:{store:{file(){return file;}}},readState(){return {tracking:{},odds_raw:{}};}});
 assert.equal(q.readRuntimeBatch('event','1X2').handled,false);
 console.log('FILE_RENAME_INVALIDATION_NO_STALE_QUOTES_AND_DELETED_STORE: PASSED');
}finally{runtime.getContractRuntime=original;fs.rmSync(folder,{recursive:true,force:true});}
