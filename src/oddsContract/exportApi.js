
'use strict';
async function exportJobReply({pool,jobs,eventId,url}){
 const jobId=url.searchParams.get('job');
 const prepare=url.searchParams.get('prepare');
 const status=url.searchParams.get('status');
 if(prepare!==null){
  if(prepare!=='1'||jobId!==null||status!==null){
   return {status:400,body:{error:'Geçersiz paket hazırlama isteği.'}};
  }
  const exists=(await pool.query(
   'SELECT event_id FROM matches WHERE event_id=$1',[eventId]
  )).rows[0];
  if(!exists) return {status:404,body:{error:'Maç bulunamadı.'}};
  return {status:202,body:jobs.request(eventId)};
 }
 if(jobId!==null){
  if(!/^[a-f0-9-]{36}$/.test(jobId)||
     (status!==null&&status!=='1')){
   return {status:400,body:{error:'Geçersiz paket işi.'}};
  }
  const state=jobs.status(jobId,eventId);
  if(!state) return {status:404,body:{error:'Paket işi bulunamadı.'}};
  if(status==='1') return {status:200,body:state};
  if(state.status!=='READY'){
   return {status:state.status==='FAILED'||state.status==='INTERRUPTED'?409:202,
    body:state};
  }
  return {status:200,package:jobs.ready(jobId,eventId)};
 }
 if(status!==null) return {status:400,body:{error:'Paket işi gerekli.'}};
 return null;
}
module.exports={exportJobReply};
