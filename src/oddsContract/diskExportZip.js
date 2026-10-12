'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib');
const {once}=require('node:events');
const {Readable,Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
function* jsonParts(value){
 if(Array.isArray(value)){
  yield '[';for(let i=0;i<value.length;i++){if(i)yield ',';yield* jsonParts(value[i]===undefined?null:value[i]);}yield ']';
 }else if(value!==null&&typeof value==='object'){
  if(typeof value.toJSON==='function'){yield* jsonParts(value.toJSON());return;}
  yield '{';let first=true;
  for(const [key,item] of Object.entries(value)){
   if(item===undefined||typeof item==='function'||typeof item==='symbol')continue;
   if(!first)yield ',';first=false;yield JSON.stringify(key);yield ':';yield* jsonParts(item);
  }yield '}';
 }else yield JSON.stringify(value)??'null';
}
async function writeJsonFile(value,filename,maxBytes){
 const stream=fs.createWriteStream(filename,{flags:'wx',mode:0o600});
 const hash=crypto.createHash('sha256');let bytes=0,pieces=[],length=0;
 let failed;stream.on('error',error=>{failed=error;});
 async function flush(){
  if(!length)return;
  const chunk=Buffer.from(pieces.join(''));pieces=[];length=0;
  bytes+=chunk.length;if(bytes>maxBytes)throw Error('EXPORT_TOO_LARGE');
  hash.update(chunk);if(!stream.write(chunk))await once(stream,'drain');
  if(failed)throw failed;
 }
 try{
  for(const part of jsonParts(value)){pieces.push(part);length+=part.length;if(length>=65536)await flush();}
  await flush();stream.end();await once(stream,'finish');
  return {filePath:filename,bytes,sha256:hash.digest('hex')};
 }catch(error){stream.destroy();try{fs.unlinkSync(filename);}catch{}throw error;}
}
const crcTable=Array.from({length:256},(_,n)=>{
 let c=n;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);return c>>>0;
});
async function diskZip(files,{directory,maxUncompressedBytes}){
 if(!Number.isSafeInteger(maxUncompressedBytes)||maxUncompressedBytes<1||
    maxUncompressedBytes>2*1024*1024*1024)throw Error('EXPORT_SIZE_LIMIT_INVALID');
 if(files.length>65535)throw Error('EXPORT_ZIP_ENTRY_LIMIT');
 const output=path.join(directory,'package.zip');
 const fd=await fs.promises.open(output,'wx',0o600);
 let total=0,offset=0;const central=[];
 async function write(buffer){let n=0;while(n<buffer.length){const r=await fd.write(buffer,n,buffer.length-n,null);n+=r.bytesWritten;}}
 try{
  for(const [index,file] of files.entries()){
   const name=Buffer.from(file.name,'utf8');if(name.length>65535)throw Error('EXPORT_ZIP_NAME_LIMIT');
   const compressedPath=path.join(directory,'entry-'+index+'.deflate');
   let crc=0xffffffff,bytes=0;
   const counter=new Transform({transform(chunk,encoding,callback){
    bytes+=chunk.length;total+=chunk.length;
    if(total>maxUncompressedBytes){callback(Error('EXPORT_TOO_LARGE'));return;}
    for(const byte of chunk)crc=(crc>>>8)^crcTable[(crc^byte)&255];
    callback(null,chunk);
   }});
   const input=file.filePath?fs.createReadStream(file.filePath):
    Readable.from([Buffer.isBuffer(file.data)?file.data:Buffer.from(file.data,'utf8')]);
   await pipeline(input,counter,zlib.createDeflateRaw(),fs.createWriteStream(compressedPath,{flags:'wx',mode:0o600}));
   crc=(crc^0xffffffff)>>>0;const compressedSize=fs.statSync(compressedPath).size;
   const local=Buffer.alloc(30);
   local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
   local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);local.writeUInt16LE(33,12);
   local.writeUInt32LE(crc,14);local.writeUInt32LE(compressedSize,18);local.writeUInt32LE(bytes,22);local.writeUInt16LE(name.length,26);
   await write(local);await write(name);
   for await(const chunk of fs.createReadStream(compressedPath))await write(chunk);
   const header=Buffer.alloc(46);
   header.writeUInt32LE(0x02014b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(20,6);
   header.writeUInt16LE(0x800,8);header.writeUInt16LE(8,10);header.writeUInt16LE(33,14);
   header.writeUInt32LE(crc,16);header.writeUInt32LE(compressedSize,20);header.writeUInt32LE(bytes,24);
   header.writeUInt16LE(name.length,28);header.writeUInt32LE(offset,42);
   central.push(header,name);offset+=local.length+name.length+compressedSize;
   fs.unlinkSync(compressedPath);
  }
  const centralSize=central.reduce((n,b)=>n+b.length,0);
  for(const b of central)await write(b);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);
  end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);await write(end);
  await fd.close();return fs.readFileSync(output);
 }catch(error){await fd.close().catch(()=>{});throw error;}
}
module.exports={writeJsonFile,diskZip};
