
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {buildMatchExport}=require('../../src/matchDataExport');
const {parseMatchIdentity}=require('../../src/oddsContract/matchIdentity');
const folder=process.argv[2];
const base=JSON.parse(fs.readFileSync(path.join(folder,'legacy-export-baseline.json'),'utf8'));
const identities=parseMatchIdentity(fs.readFileSync(path.join(folder,'match-page.html'),'utf8'),{
 eventId:base.match.event_id,sourceUrl:base.match.url,
 observedAt:'2026-10-11T12:00:00.000Z',clockRuleVerified:true
});
const tables={
 odds_1x2_snapshots:'1X2',odds_over_under_snapshots:'OU',
 odds_asian_snapshots:'ASIAN',odds_kg_snapshots:'KG'
};
let released=false;
const client={
 async query(sql){
  if(sql.includes('FROM matches')) return {rows:[base.match]};
  if(sql.includes('FROM odds_tracking_settings')) return {rows:[base.tracking]};
  if(sql.includes('FROM performance_cache')) return {rows:[{
   payload:base.performanceRaw,status:base.performanceCache.status,
   updated_at:base.performanceCache.updatedAt,error:base.performanceCache.error
  }]};
  for(const [table,market] of Object.entries(tables)){
   if(sql.includes('FROM '+table)) return {rows:base.odds[market]};
  }
  if(/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK)/.test(sql)) return {rows:[]};
  throw Error('UNEXPECTED_QUERY:'+sql);
 },
 release(){released=true;}
};
const pool={connect:async()=>client};
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'macradar-contract-package-'));
(async()=>{
 try{
  const result=await buildMatchExport(pool,base.match.event_id,{
   state:{
    match_identity:identities,raw_evidence:identities.raw_evidence,
    runs:[
     {run_id:'price-run',success:true,started_at:'2026-10-11T11:00:00.000Z',
      finished_at:'2026-10-11T11:01:00.000Z',scope:['1X2','OU','ASIAN','KG']},
     {run_id:'identity-end',success:true,odds_collection_performed:false,
      started_at:'2026-10-11T12:00:00.000Z',
      finished_at:'2026-10-11T12:01:00.000Z',scope:['MATCH_IDENTITY'],
      outcome:'PRE_MATCH_ENDED'}
    ]
   },
   analysisCutoff:'2026-10-11T13:00:00.000Z',
   exportRefresh:{status:'PRE_MATCH_ENDED'}
  });
  assert(released);
  const zipPath=path.join(directory,'package.zip');
  fs.writeFileSync(zipPath,result.buffer);
  execFileSync('python3',['-c',`
import json,sys,zipfile,hashlib
from pathlib import Path
baseline=json.loads(Path(sys.argv[2]).read_text())
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 data=json.loads(z.read("match-data.json"))
 assert data["schema_version"]=="betexplorer-match-data-v2"
 assert data["collection"]["last_successful_scan"]["run_id"]=="price-run"
 assert data["collection"]["last_scan_result"]["run_id"]=="identity-end"
 assert data["collection"]["match_identity"]["home"]["source_team_id"]=="533"
 assert data["collection"]["export_refresh"]["status"]=="PRE_MATCH_ENDED"
 assert data["compatibility"]["integration_test_status"]=="NOT_RUN"
 for market,rows in baseline["odds"].items():
  assert len(data["odds"][market])==len(rows)
  for old,new in zip(rows,data["odds"][market]):
   for key,value in old.items():
    assert new[key]==value,(market,key)
   assert new["raw_record_ids"]
 assert data["performanceRaw"]==baseline["performanceRaw"]
 assert data["performance"]==baseline["performance"]
 manifest=json.loads(z.read("manifest.json"))
 for item in manifest["files"]:
  body=z.read(item["name"])
  assert len(body)==item["bytes"]
  assert hashlib.sha256(body).hexdigest()==item["sha256"]
 print("GERCEK_ESKI_PAKET_ALAN_PERFORMANS_VE_TUM_DOSYA_HASHLERI: GECTI")
`,zipPath,path.join(folder,'legacy-export-baseline.json')],{stdio:'pipe'});
  console.log('GERCEK_PAKET_FONKSIYONU_YENI_SOZLESME_JSON_VE_ZIP_BUTUNLUGU: GECTI');
  console.log('KIMLIK_TURU_FIYAT_TARAMASI_SAYILMADI; OKUYUCU_TESTI_NOT_RUN');
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
