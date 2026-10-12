'use strict';
const fs=require('node:fs'),path=require('node:path');
function serveApkDelivery(req,res,url,{
 directory=path.join(process.cwd(),'var','odds-contract','apk-delivery'),
 now=Date.now()
}={}){
 const match=/^\/apk-delivery\/([a-f0-9]{64})\.apk$/.exec(url.pathname);
 if(!match)return false;
 const deny=status=>{res.writeHead(status,{'cache-control':'no-store'});res.end();return true;};
 if(!['GET','HEAD'].includes(req.method))return deny(405);
 let metadata,stat;
 const file=path.join(directory,match[1]+'.apk');
 try{
  metadata=JSON.parse(fs.readFileSync(path.join(directory,match[1]+'.json'),'utf8'));
  stat=fs.lstatSync(file);
 }catch{return deny(404);}
 if(!stat.isFile()||!Number.isFinite(metadata.expires_at)||
    now>=metadata.expires_at||metadata.bytes!==stat.size||
    !/^[a-f0-9]{64}$/.test(metadata.sha256||'')||
    metadata.signature_verified!==true)return deny(404);
 res.writeHead(200,{
  'content-type':'application/vnd.android.package-archive',
  'content-disposition':'attachment; filename="MacRadar-1.0.9.apk"',
  'content-length':stat.size,'cache-control':'no-store',
  'x-content-type-options':'nosniff','x-apk-sha256':metadata.sha256
 });
 if(req.method==='HEAD'){res.end();return true;}
 const stream=fs.createReadStream(file);
 stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());
 stream.pipe(res);return true;
}
module.exports={serveApkDelivery};
