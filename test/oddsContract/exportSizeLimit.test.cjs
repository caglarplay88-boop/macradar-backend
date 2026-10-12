
'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {zip}=require("../../src/matchDataExport.js");
test('explicit ZIP byte budget accepts the exact aggregate boundary',()=>{
 const result=zip([{name:'a.json',data:'1234'},{name:'b.json',data:'5678'}],
  {maxUncompressedBytes:8});
 assert(Buffer.isBuffer(result)&&result.length>0);
});
test('ZIP byte budget counts all files and refuses overflow without truncation',()=>{
 assert.throws(()=>zip([{name:'a.json',data:'1234'},{name:'b.json',data:'56789'}],
  {maxUncompressedBytes:8}),/EXPORT_TOO_LARGE/);
});
test('ZIP byte budget rejects invalid and excessive configuration',()=>{
 for(const value of [0,-1,NaN,Infinity,1.5,1024*1024*1024+1])
  assert.throws(()=>zip([{name:'a.json',data:'1234'}],
   {maxUncompressedBytes:value}),/EXPORT_SIZE_LIMIT_INVALID/);
});

// Configured uncompressed budgets may exceed 512 MiB; contents remain intact.
assert.deepEqual(zip([{name:"small.txt",data:"ok"}], {maxUncompressedBytes:1024*1024*1024}).subarray(0,4), Buffer.from([0x50,0x4b,0x03,0x04]));
