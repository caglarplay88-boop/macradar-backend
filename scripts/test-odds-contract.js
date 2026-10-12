'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const source=path.resolve(process.argv[2]||path.join(root,'test/fixtures/betexplorer-20261011'));
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'macradar-source-replay-'));
try{
 fs.cpSync(source,temporary,{recursive:true});
 const folder=path.join(root,'test/oddsContract');
 const first='currentParser.test.cjs';
 const tests=[first,...fs.readdirSync(folder).filter(n=>n.endsWith('.test.cjs')&&n!==first).sort()];
 let passed=0;
 for(const test of tests){
  const result=spawnSync(process.execPath,[path.join(folder,test),temporary],{
   cwd:root,encoding:'utf8',timeout:60000
  });
  const success=result.status===0;
  if(success)passed++;
  console.log((success?'PASS ':'FAIL ')+test);
  if(!success)process.stderr.write((result.stdout||'')+(result.stderr||'')+
    (result.error?String(result.error):''));
 }
 console.log(JSON.stringify({passed,failed:tests.length-passed,total:tests.length,
  scope:'RECORDED_SOURCE_REPLAY_AND_UNIT_TESTS_NOT_PHONE_ACCEPTANCE'}));
 if(passed!==tests.length)process.exitCode=1;
}finally{fs.rmSync(temporary,{recursive:true,force:true});}
