'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),crypto=require('node:crypto');
const {serveApkDelivery}=require('../../src/oddsContract/apkDelivery');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'apk-delivery-'));
const token=crypto.randomBytes(32).toString('hex'),bytes=Buffer.from('signed-test-artifact');
const meta={expires_at:Date.now()+60000,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),signature_verified:true};
fs.writeFileSync(path.join(directory,token+'.apk'),bytes);fs.writeFileSync(path.join(directory,token+'.json'),JSON.stringify(meta));
const server=http.createServer((req,res)=>{
 if(!serveApkDelivery(req,res,new URL(req.url,'http://localhost'),{directory})){res.writeHead(404);res.end();}
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port+'/apk-delivery/'+token+'.apk';
 let response=await fetch(url);assert.equal(response.status,200);assert.equal(response.headers.get('x-apk-sha256'),meta.sha256);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
 assert.equal((await fetch(url,{method:'HEAD'})).headers.get('content-length'),String(bytes.length));
 meta.expires_at=Date.now()-1;fs.writeFileSync(path.join(directory,token+'.json'),JSON.stringify(meta));
 assert.equal((await fetch(url)).status,404);
 assert.equal((await fetch(url.replace(token,'0'.repeat(64)))).status,404);
 console.log('APK_TOKEN_DOWNLOAD_EXPIRY_MISSING_ARTIFACT_AND_INTEGRITY_METADATA: PASSED');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{server.close();fs.rmSync(directory,{recursive:true,force:true});});
