
'use strict';
const crypto=require('node:crypto');
const {parseBetExplorerUrl}=require('../odds1x2');
function attrs(tag){
 const out={};
 for(const m of String(tag).matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)){
  out[m[1].toLowerCase()]=m[2];
 }
 return out;
}
function element(html,id){
 for(const tag of html.match(/<(?:input|p)\b[^>]*>/gi)||[]){
  const a=attrs(tag);
  if(a.id===id) return {tag,attributes:a};
 }
 return null;
}
function explicitInstant(raw){
 if(typeof raw!=='string') return null;
 const m=raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})$/);
 if(!m) return null;
 const [year,month,day,hour,minute,second]=m.slice(1,7).map(Number);
 if(month<1||month>12||day<1||hour>23||minute>59||second>59) return null;
 const wall=new Date(Date.UTC(year,month-1,day,hour,minute,second));
 if(wall.getUTCFullYear()!==year||wall.getUTCMonth()!==month-1||
    wall.getUTCDate()!==day) return null;
 const value=Date.parse(raw);
 return Number.isFinite(value)?new Date(value).toISOString():null;
}
function commaInstant(raw,verified){
 if(!verified||typeof raw!=='string') return null;
 const m=raw.match(/^(\d{1,2}),(\d{1,2}),(\d{4}),(\d{1,2}),(\d{2})$/);
 if(!m) return null;
 const [day,month,year,hour,minute]=m.slice(1).map(Number);
 const iso=[year,String(month).padStart(2,'0'),String(day).padStart(2,'0')].join('-')+
  'T'+String(hour).padStart(2,'0')+':'+String(minute).padStart(2,'0')+':00+01:00';
 return explicitInstant(iso);
}
function parseMatchIdentity(html,{
 eventId,sourceUrl,observedAt,clockRuleVerified=false
}){
 const flags=[];
 const fields={};
 for(const id of ['eventID','match-date','homeParticipantIdHeader',
  'awayParticipantIdHeader','isLive','isFinished']){
  fields[id]=element(String(html),id);
 }
 let sourceEventId=fields.eventID?.attributes['data-event-id']||null;
 let urlEventId=null;
 try{urlEventId=parseBetExplorerUrl(sourceUrl).eventId;}catch{}
 if(sourceEventId!==eventId||urlEventId!==eventId){
  flags.push('MATCH_SOURCE_EVENT_ID_MISMATCH_OR_MISSING');
 }
 const events=[];
 for(const body of String(html).matchAll(
  /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
  try{
   const data=JSON.parse(body[1]);
   if(data&&data['@type']==='SportsEvent') events.push(data);
  }catch{}
 }
 const event=events.length===1?events[0]:null;
 let schemaEventId=null;
 try{schemaEventId=parseBetExplorerUrl(event?.url).eventId;}catch{}
 if(schemaEventId!==eventId) flags.push('SPORTS_EVENT_ID_UNVERIFIED');
 const homeId=fields.homeParticipantIdHeader?.attributes.value||null;
 const awayId=fields.awayParticipantIdHeader?.attributes.value||null;
 const homeName=typeof event?.homeTeam?.name==='string'?event.homeTeam.name.trim():null;
 const awayName=typeof event?.awayTeam?.name==='string'?event.awayTeam.name.trim():null;
 if(!homeId||!awayId||homeId===awayId||!homeName||!awayName){
  flags.push('MATCH_TEAM_ORDER_OR_ID_UNVERIFIED');
 }
 const schemaTime=explicitInstant(event?.startDate);
 const commaRaw=fields['match-date']?.attributes['data-dt']||null;
 const commaTime=commaInstant(commaRaw,clockRuleVerified);
 if(!schemaTime) flags.push('KICKOFF_EXPLICIT_TIME_UNVERIFIED');
 if(commaTime&&schemaTime&&
    Math.floor(Date.parse(commaTime)/60000)!==Math.floor(Date.parse(schemaTime)/60000)){
  flags.push('KICKOFF_SOURCE_FIELDS_CONFLICT');
 }
 const kickoffVerified=Boolean(schemaTime)&&
  !flags.includes('KICKOFF_SOURCE_FIELDS_CONFLICT');
 const liveRaw=fields.isLive?.attributes.value??null;
 const finishedRaw=fields.isFinished?.attributes.value??null;
 const schemaStatus=event?.eventStatus||null;
 const ended=finishedRaw==='1'||String(schemaStatus).endsWith('/EventEnded');
 const live=liveRaw==='1'||String(schemaStatus).endsWith('/EventInProgress');
 const scheduled=String(schemaStatus).endsWith('/EventScheduled');
 const before=kickoffVerified&&Number.isFinite(Date.parse(observedAt))&&
  Date.parse(observedAt)<Date.parse(schemaTime);
 const identityVerified=flags.length===0;
 const preMatchVerified=identityVerified&&before&&scheduled&&
  liveRaw===''&&['','0'].includes(finishedRaw)&&!live&&!ended;
 if(!preMatchVerified) flags.push('PRE_MATCH_SCOPE_UNVERIFIED');
 const evidence={
  kind:'BETEXPLORER_MATCH_IDENTITY_EVIDENCE',
  source_url:sourceUrl,observed_at:observedAt,
  fields:Object.fromEntries(Object.entries(fields).map(([key,value])=>[
   key,value?value.attributes:null])),
  sports_event:event?{
   type:event['@type'],url:event.url,name:event.name,startDate:event.startDate,
   eventStatus:event.eventStatus,
   homeTeam:{name:homeName},awayTeam:{name:awayName}
  }:null,
  comma_date_rule_verified:clockRuleVerified
 };
 const ref='match-identity-'+crypto.createHash('sha256')
  .update(JSON.stringify(evidence)).digest('hex');
 return {
  event_id:eventId,source_event_id:sourceEventId,
  identity_verified:identityVerified,
  home:{source_team_id:homeId,name:homeName},
  away:{source_team_id:awayId,name:awayName},
  kickoff:schemaTime,kickoff_verified:kickoffVerified,
  kickoff_source_raw:event?.startDate||null,
  kickoff_comma_raw:commaRaw,kickoff_comma_converted:commaTime,
  source_status:{live_raw:liveRaw,finished_raw:finishedRaw,schema_status:schemaStatus},
  lifecycle:ended?'finished':live?'live':preMatchVerified?'pre_match':'unknown',
  pre_match_verified:preMatchVerified,
  period:'FULL_TIME_90',period_verified:false,
  period_exclusion_reason:'SOURCE_SETTLEMENT_SCOPE_NOT_YET_VERIFIED',
  quality_flags:flags,raw_evidence_ref:ref,raw_evidence:{[ref]:evidence}
 };
}
module.exports={parseMatchIdentity,explicitInstant};
