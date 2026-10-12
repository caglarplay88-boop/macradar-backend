
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {pool}=require('../../src/db');
const src=fs.readFileSync(path.join(__dirname,'../../src/db.js'),'utf8');
const start=src.indexOf('async function updateTrackingSettings(');
const finish=src.indexOf('\nasync function ',start+1);
const block=src.slice(start,finish);
const next=block.match(/next_pull_at=(CASE[\s\S]*?END),\s+last_error=/)[1];
const error=block.match(/last_error=(CASE[\s\S]*?END),\s+updated_at=/)[1];
(async()=>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN READ ONLY');
  await client.query("SET LOCAL statement_timeout='5000'");
  const query=`WITH odds_tracking_settings AS (
   SELECT $1::boolean tracking_enabled,$2::int refresh_minutes,
    $3::timestamptz next_pull_at,$4::text last_error
  ), excluded AS (
   SELECT $5::boolean tracking_enabled,$6::int refresh_minutes
  ) SELECT ${next} next_pull_at,${error} last_error,NOW() test_now
    FROM odds_tracking_settings CROSS JOIN excluded`;
  const saved='2026-10-12T12:00:00.000Z';
  const run=async(enabled,minutes,newEnabled,newMinutes)=>{
   return (await client.query(query,
    [enabled,minutes,saved,'SAVED_SOURCE_FAILURE',newEnabled,newMinutes])).rows[0];
  };
  const repeat=await run(true,60,true,60);
  assert.equal(repeat.next_pull_at.toISOString(),saved);
  assert.equal(repeat.last_error,'SAVED_SOURCE_FAILURE');
  const changed=await run(true,60,true,30);
  assert.equal(changed.next_pull_at.toISOString(),changed.test_now.toISOString());
  assert.equal(changed.last_error,null);
  const resumed=await run(false,60,true,60);
  assert.equal(resumed.next_pull_at.toISOString(),resumed.test_now.toISOString());
  const disabled=await run(true,60,false,60);
  assert.equal(disabled.next_pull_at,null);
  assert.equal(disabled.last_error,null);
  await client.query('ROLLBACK');
  console.log('GERCEK_POSTGRES_TEKRAR_TAKIP_TAKVIM_VE_HATA_KORUMA: GECTI');
  console.log('AYAR_DEGISIMI_YENIDEN_BASLATMA_VE_DURDURMA: GECTI');
  console.log('TEST_ISLEMI: READ_ONLY; CANLI_KAYITLARA_YAZILMADI');
 }finally{client.release();}
})().catch(e=>{
 console.error('TEST_HATASI:',e.code||e.name,e.message);
 process.exitCode=1;
}).finally(()=>pool.end());
