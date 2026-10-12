
'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),os=require('os');
const path=require('path'),{execFileSync}=require('child_process');
const {StateStore}=require('../../src/oddsContract/stateStore');
const {LimitedQueue}=require('../../src/oddsContract/queue');
(async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'macradar-contract-'));
 try{
  const store=new StateStore(directory);
  assert.equal(store.startTracking('event',{interval:2}).created,true);
  assert.equal(store.startTracking('event',{interval:2}).created,false);
  const record={record_id:'r',event_id:'event',raw_evidence_ref:'e',
   odds_decimal:2,status:'OPEN',observed_at:'2026-10-11T12:00:00.000Z'};
  const capture={records:[record],evidence:{e:{kind:'test',price:2}}};
  assert.equal(store.saveCapture('event',capture).inserted,1);
  assert.equal(store.saveCapture('event',capture).inserted,0);
  store.recordRun('event',{run_id:'good',started_at:'2026-10-11T12:00:00Z',
   finished_at:'2026-10-11T12:01:00Z',success:true,scope:['1X2']});
  store.recordRun('event',{run_id:'bad',started_at:'2026-10-11T12:11:00Z',
   finished_at:'2026-10-11T12:12:00Z',success:false,error:'TIMEOUT',scope:['1X2']});
  const saved=store.read('event');
  assert.equal(saved.runs[1].seconds_since_previous_success,600);
  assert.equal(saved.interruptions.length,1);
  assert.equal(saved.odds_raw.r.status,'OPEN');
  assert.equal(saved.odds_raw.r.odds_decimal,2);
  const modulePath=path.resolve(__dirname,'../../src/oddsContract/stateStore');
  const child=JSON.parse(execFileSync(process.execPath,['-e',
   `const {StateStore}=require(process.argv[1]);
    const store=new StateStore(process.argv[2]);
    process.stdout.write(JSON.stringify({
     enabled:store.read('event').tracking.enabled,
     created:store.startTracking('event',{interval:2}).created,
     count:Object.keys(store.read('event').odds_raw).length
    }));`,modulePath,directory],{encoding:'utf8'}));
  assert.deepEqual(child,{enabled:true,created:false,count:1});
  const before=fs.readFileSync(store.file('event'),'utf8');
  assert.throws(()=>store.saveCapture('event',{
   records:[{...record,odds_decimal:3}],evidence:{}
  }),/RAW_RECORD_ID_CONFLICT/);
  assert.equal(fs.readFileSync(store.file('event'),'utf8'),before);
  assert.throws(()=>store.read('../escape'));
  let active=0,peak=0,executions=0;
  const queue=new LimitedQueue(2);
  const task=async()=>{
   active++;peak=Math.max(peak,active);executions++;
   await new Promise(resolve=>setTimeout(resolve,10));
   active--;return 'ok';
  };
  const first=queue.run('same-event',task);
  const duplicate=queue.run('same-event',task);
  assert.equal(first,duplicate);
  await Promise.all([first,duplicate,
   ...Array.from({length:5},(_,n)=>queue.run('event-'+n,task))]);
  assert.equal(executions,6);
  assert.equal(peak,2);
  console.log('TEKRAR_TAKIP_VE_ESZAMANLILIK_SINIRI: GECTI');
  console.log('AYRI_NODE_SURECINDE_YENIDEN_BASLATMA_VE_KAYIT_KORUMA: GECTI');
  console.log('HATA_KESINTISI_FIYAT_DEGISTIRMEME_VE_ATOMIK_YAZMA: GECTI');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
