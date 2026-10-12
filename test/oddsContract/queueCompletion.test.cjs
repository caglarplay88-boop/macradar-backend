
'use strict';
const assert=require('node:assert/strict');
const {LimitedQueue}=require('../../src/oddsContract/queue');
(async()=>{
 const q=new LimitedQueue(1);
 let calls=0;
 assert.equal(await q.run('same',()=>++calls),1);
 assert.deepEqual(q.status(),{limit:1,active:0,pending:0,uniqueJobs:0});
 assert.equal(await q.run('same',()=>++calls),2);
 await assert.rejects(q.run('same',()=>{throw Error('EXPECTED_FAILURE');}),
  /EXPECTED_FAILURE/);
 assert.deepEqual(q.status(),{limit:1,active:0,pending:0,uniqueJobs:0});
 assert.equal(await q.run('same',()=>++calls),3);
 let release;
 const first=q.run('duplicate',()=>new Promise(resolve=>{release=resolve;}));
 assert.strictEqual(first,q.run('duplicate',()=>{
  throw Error('DUPLICATE_EXECUTED');
 }));
 await Promise.resolve();
 release('OK');
 assert.equal(await first,'OK');
 assert.equal(await q.run('duplicate',()=> 'NEW_RUN'),'NEW_RUN');
 console.log('KUYRUK_SONUC_ONCESI_TEMIZLIK_VE_HATA_SONRASI_YENI_TUR: GECTI');
})().catch(error=>{console.error(error);process.exitCode=1;});
