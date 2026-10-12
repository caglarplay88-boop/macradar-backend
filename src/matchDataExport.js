
'use strict';
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {writeJsonFile,diskZip} = require('./oddsContract/diskExportZip');
const {buildCachedPerformanceAnalysisView} = require('./performanceView/verifiedCachedPerformanceView');
const markets = [
 {key:'1X2',table:'odds_1x2_snapshots',line:null,
  selections:[['1','home_odd','home_closed'],['X','draw_odd','draw_closed'],['2','away_odd','away_closed']]},
 {key:'OU',table:'odds_over_under_snapshots',line:'total_line',
  selections:[['Alt','under_odd','under_closed'],['Üst','over_odd','over_closed']]},
 {key:'ASIAN',table:'odds_asian_snapshots',line:'handicap_line',
  selections:[['Ev','home_odd','home_closed'],['Deplasman','away_odd','away_closed']]},
 {key:'KG',table:'odds_kg_snapshots',line:null,
  selections:[['Var','yes_odd','yes_closed'],['Yok','no_odd','no_closed']]}
];
const escape = value => String(value ?? '').replace(/[&<>"']/g,
 c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const colors=['#4ea1ff','#f6bd45','#ef779c'];
function crc32(bytes){
 let crc=0xffffffff;
 for(const byte of bytes){
  crc^=byte;
  for(let j=0;j<8;j++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);
 }
 return (crc^0xffffffff)>>>0;
}
function zip(files,{maxUncompressedBytes=64*1024*1024}={}){
 if(!Number.isSafeInteger(maxUncompressedBytes)||maxUncompressedBytes<1||
    maxUncompressedBytes>512*1024*1024) throw Error('EXPORT_SIZE_LIMIT_INVALID');
 const locals=[],centrals=[];let offset=0,total=0;
 for(const file of files){
  const name=Buffer.from(file.name,'utf8');
  const data=Buffer.isBuffer(file.data)?file.data:Buffer.from(file.data,'utf8');
  total+=data.length;
  if(total>maxUncompressedBytes) throw Error('EXPORT_TOO_LARGE');
  const compressed=zlib.deflateRawSync(data),crc=crc32(data);
  const local=Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);
  local.writeUInt16LE(0x800,6);local.writeUInt16LE(8,8);
  local.writeUInt16LE(33,12);
  local.writeUInt32LE(crc,14);local.writeUInt32LE(compressed.length,18);
  local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  locals.push(local,name,compressed);
  const central=Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);
  central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);
  central.writeUInt16LE(8,10);central.writeUInt16LE(33,14);
  central.writeUInt32LE(crc,16);central.writeUInt32LE(compressed.length,20);
  central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
  central.writeUInt32LE(offset,42);centrals.push(central,name);
  offset+=local.length+name.length+compressed.length;
 }
 const central=Buffer.concat(centrals),end=Buffer.alloc(22);
 end.writeUInt32LE(0x06054b50,0);
 end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);
 end.writeUInt32LE(central.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,central,end]);
}
const time = value => {
 const d=new Date(value);
 return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('tr-TR',{
  timeZone:'Europe/Istanbul',dateStyle:'short',timeStyle:'short'}).format(d):'Tarih bilinmiyor';
};
function chart(market,rows,title){
 const valid=rows.filter(r=>Number.isFinite(Date.parse(r.captured_at)));
 const values=valid.flatMap(r=>market.selections.map(([,odd,closed])=>
  r[closed]===true?null:Number(r[odd]))).filter(v=>Number.isFinite(v)&&v>1);
 if(!valid.length||!values.length) return null;
 const minT=Math.min(...valid.map(r=>Date.parse(r.captured_at)));
 const maxT=Math.max(...valid.map(r=>Date.parse(r.captured_at)));
 const minV=Math.min(...values),maxV=Math.max(...values);
 const x=t=>60+(t-minT)/Math.max(1,maxT-minT)*780;
 const y=v=>230-(v-minV)/Math.max(0.1,maxV-minV)*150;
 const plots=[];
 market.selections.forEach(([label,odd,closed],i)=>{
  let segment=[];
  const flush=()=>{
   if(segment.length>1) plots.push(`<polyline fill="none" stroke="${colors[i]}" stroke-width="2" points="${segment.join(' ')}"/>`);
   segment=[];
  };
  for(const row of valid){
   const value=Number(row[odd]);
   if(row[closed]===true||!Number.isFinite(value)||value<=1){flush();continue;}
   const px=x(Date.parse(row.captured_at)),py=y(value);
   segment.push(`${px.toFixed(2)},${py.toFixed(2)}`);
   plots.push(`<circle cx="${px.toFixed(2)}" cy="${py.toFixed(2)}" r="${row.capture_type==='opening'?4:2}" fill="${colors[i]}"/>`);
  }
  flush();
  plots.push(`<text x="${65+i*180}" y="55" fill="${colors[i]}">${escape(label)}</text>`);
 });
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 300" role="img" aria-label="${escape(title)}">
 <rect width="900" height="300" fill="#121a29"/>
 <g font-family="sans-serif" font-size="14" fill="#eee">
 <text x="20" y="26">${escape(title)}</text>
 <path d="M60 75V240H850" fill="none" stroke="#64748b"/>
 <text x="8" y="85">${maxV.toFixed(2)}</text><text x="8" y="235">${minV.toFixed(2)}</text>
 ${plots.join('')}
 <text x="60" y="275">${escape(time(new Date(minT)))}</text>
 <text x="850" y="275" text-anchor="end">${escape(time(new Date(maxT)))}</text>
 </g></svg>`;
}
async function buildMatchExport(pool,eventId,options={}){
 const maxUncompressedBytes=Number(options.maxExportUncompressedBytes??
  process.env.MACRADAR_EXPORT_MAX_UNCOMPRESSED_BYTES??128*1024*1024);
 if(!Number.isSafeInteger(maxUncompressedBytes)||maxUncompressedBytes<1||
    maxUncompressedBytes>512*1024*1024) throw Error('EXPORT_SIZE_LIMIT_INVALID');
 const id=String(eventId||'').trim();
 if(!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw Error('EXPORT_EVENT_ID_INVALID');
 const client=await pool.connect();
 let match,tracking,cache,odds={};
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query("SET LOCAL statement_timeout='20000'");
  match=(await client.query('SELECT * FROM matches WHERE event_id=$1',[id])).rows[0];
  if(!match) {const error=Error('MATCH_NOT_FOUND');error.status=404;throw error;}
  tracking=(await client.query('SELECT * FROM odds_tracking_settings WHERE event_id=$1',[id])).rows[0]||null;
  cache=(await client.query('SELECT * FROM performance_cache WHERE event_id=$1',[id])).rows[0]||null;
  for(const market of markets){
   odds[market.key]=(await client.query(
    `SELECT * FROM ${market.table} WHERE event_id=$1 ORDER BY captured_at,capture_sequence,id`,
    [id])).rows;
  }
  await client.query('COMMIT');
 }catch(error){
  await client.query('ROLLBACK').catch(()=>{});throw error;
 }finally{client.release();}
 const warnings=[];
 let raw=cache?.payload??null;
 if(typeof raw==='string') raw=JSON.parse(raw);
 let performance=null;
 if(raw){
  try{performance=buildCachedPerformanceAnalysisView(raw);}
  catch(error){warnings.push('Performans görünümü hazırlanamadı: '+error.message);}
 }else warnings.push('Bu maç için kayıtlı performans verisi bulunmuyor.');
 const exportedAt=new Date().toISOString();
 const legacyData={formatVersion:1,exportedAt,timeZone:'Europe/Istanbul',
  match,tracking,odds,performance,performanceRaw:raw,
  performanceCache:{status:cache?.status??null,updatedAt:cache?.updated_at??null,error:cache?.error??null},
  warnings};
 let runtime=null;
 if(!Object.prototype.hasOwnProperty.call(options,'state')){
  runtime=require('./oddsContract/runtime').getContractRuntime();
 }
 const state=runtime?runtime.readState(id):options.state;
 const data=require('./oddsContract/exportContract').buildContractExport(legacyData,{
  state,
  analysisCutoff:options.analysisCutoff||exportedAt,
  analysisMode:options.analysisMode||'strict_as_of',
  settings:options.settings||runtime?.settings,
  qualityThresholds:options.qualityThresholds||{},
  maxWindowCarrySeconds:options.maxWindowCarrySeconds??300
 });
 data.collection.export_refresh=options.exportRefresh||null;
 data.collection.export_limits={max_uncompressed_bytes:maxUncompressedBytes,
  package_format:'ZIP_DEFLATE'};
 const files=[],graphs=[];
 for(const market of markets){
  const groups=new Map();
  for(const row of data.odds[market.key]){
   const key=JSON.stringify([
    row.bookmaker_key||row.bookmaker_id||row.bookmaker_name,
    market.line?row[market.line]:null,
    row.source_context_id||['LEGACY',row.source_name??null,row.source_region??null],
    row.period??null,row.price_type??null,
    market.key==='ASIAN'&&row.handicap_line===null?
     row.quote_group_id??null:null
   ]);
   if(!groups.has(key)) groups.set(key,[]);
   groups.get(key).push(row);
  }
  for(const rows of groups.values()){
   const title=`${market.key} · ${rows[0].bookmaker_name||rows[0].bookmaker_key}${market.line?' · '+rows[0][market.line]:''}`;
   const svg=chart(market,rows,title);
   if(!svg) continue;
   const name=`charts/chart-${String(graphs.length+1).padStart(4,'0')}.svg`;
   graphs.push({title,svg,name});
   files.push({name,data:svg});
  }
 }
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'macradar-package-'));
 try {
 const jsonFile=await writeJsonFile(data,path.join(temporary,'match-data.json'),maxUncompressedBytes);
 files.unshift({name:'match-data.json',...jsonFile});
 files.push({name:'performance.json',data:JSON.stringify({
  exportedAt,performance,performanceRaw:raw,cache:data.performanceCache,warnings},null,2)});
 const rows=performance?['evTakimi','deplasmanTakimi'].map(side=>{
  const team=performance[side];
  return `<h3>${escape(typeof team?.takim==='string'?team.takim:team?.takim?.name||side)}</h3>
  <pre>${escape(JSON.stringify({son5:team?.son5,son10:team?.son10,maclar:team?.maclar},null,2))}</pre>`;
 }).join(''):'<p>Performans verisi yok.</p>';
 files.push({name:'match-card.html',data:`<!doctype html><html lang="tr"><meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 <title>${escape(match.display_name)}</title><style>
 body{background:#0c1220;color:#eee;font:16px sans-serif;margin:20px}
 svg{width:100%;max-width:1100px}pre{white-space:pre-wrap;overflow-wrap:anywhere}
 section{margin:24px 0;padding:16px;background:#182132;border-radius:12px}
 </style><h1>${escape(match.display_name)}</h1>
 <p>Paket: ${escape(time(exportedAt))} · Saat dilimi: Türkiye</p>
 <p>Tüm kayıtlar match-data.json içindedir. Çizgiler kapalı oranlarda kesilir; büyük noktalar kaynak açılışıdır.
 Kaynak açılış tarihi ile uygulamanın oranı çektiği tarih ayrı kayıt türleridir.
 Paket oluşturulması, tüm verilerin kaynakla doğrulandığı anlamına gelmez.</p>
 ${warnings.map(w=>'<p>'+escape(w)+'</p>').join('')}
 <h2>Oran grafikleri</h2>${graphs.map(g=>'<section>'+g.svg+'</section>').join('')}
 <h2>Performans</h2>${rows}</html>`});
 const collectionStatus={
  exported_at:data.exportedAt,analysis_cutoff:data.collection.analysis_cutoff,
  last_successful_scan_at:data.collection.last_successful_scan?.finished_at??null,
  refresh_success:options.exportRefresh?.success??null,
  refresh_outcome:options.exportRefresh?.outcome??'NOT_REQUESTED',
  source_and_scope_verified:data.collection.data_freshness.verified_current===true
 };
 const manifest={formatVersion:1,eventId:id,match:match.display_name,exportedAt,
  collection:collectionStatus,
  rowCounts:Object.fromEntries(markets.map(m=>[m.key,data.odds[m.key].length])),
  chartCount:graphs.length,performancePresent:!!performance,warnings,
  files:files.map(f=>({name:f.name,bytes:f.filePath?f.bytes:Buffer.byteLength(f.data),
   sha256:f.filePath?f.sha256:crypto.createHash('sha256').update(f.data).digest('hex')}))};
 files.push({name:'manifest.json',data:JSON.stringify(manifest,null,2)});
 return {buffer:await diskZip(files,{directory:temporary,maxUncompressedBytes}),
  filename:`MacRadar-${id}-${Date.now()}.zip`,manifest,collectionStatus};
 } finally {fs.rmSync(temporary,{recursive:true,force:true});}
}
module.exports={buildMatchExport,chart,zip};
