
'use strict';
const {buildCachedPerformanceAnalysisView:legacy}=require('./cachedPerformanceAnalysisView');
const identities=require('./verifiedPerformanceTeamIdentities.json');
const fold=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'')
 .toLowerCase().replace(/[^a-z0-9]/g,'');
const label=t=>typeof t.takim==='string'?t.takim:(t.takim?.ad||t.takim?.name);
const affectedFields=[
 'standartIstatistik','duelContext','styleContext','pressingContext',
 'ilk11Surekliligi','goalkeeperContext','kirmiziKartBaglami',
 'progressionContext','teknikSistemDegisimi','highZoneRegainContext',
 'playerProgressionContext','defensiveStructureContext','oyuncuFormu','lineup',
 'pressingSources','progressionSources','styleSources','resultVsUnderlyingSources'
];
function buildCachedPerformanceAnalysisView(payload){
 const copy=JSON.parse(typeof payload==='string'?payload:JSON.stringify(payload));
 const reviews={};
 for(const side of ['evTakimi','deplasmanTakimi']){
  const team=copy[side];
  if(!team||!Array.isArray(team.maclar)) continue;
  const display=label(team);
  if(!display) throw Error('PERFORMANCE_TEAM_NAME_MISSING');
  let canonical=display,verifiedIdentity=null;
  const sourceUrl=copy.meta?.[side==='evTakimi'?'homeUrl':'awayUrl'];
  if(copy.meta?.provider==='FotMob'&&sourceUrl){
   try{
    const url=new URL(sourceUrl);
    const id=url.pathname.match(/^\/teams\/(\d+)\//)?.[1];
    const known=identities[id];
    if(['www.fotmob.com','fotmob.com'].includes(url.hostname)&&known&&
       known.aliases.some(a=>fold(a)===fold(display))){
     canonical=known.name;verifiedIdentity=known;
    }
   }catch{}
  }
  const original=team.maclar;
  const excluded=[];
  const included=original.filter((row,index)=>{
   const home=fold(row.ev)===fold(canonical);
   const away=fold(row.deplasman)===fold(canonical);
   if(home!==away) return true;
   excluded.push({index,id:row.id??null,date:row.tarih,
     home:row.ev,away:row.deplasman,reason:'TEAM_IDENTITY_NOT_MATCHED'});
   return false;
  });
  if(original.length&&included.length===0)
   throw Error('PERFORMANCE_NO_IDENTITY_MATCHED_ROWS');
  reviews[side]={display,canonical,verifiedIdentity,
    importedRows:original.length,excluded};
  team.maclar=included;
  team.takim=canonical;
 }
 const view=legacy(copy);
 for(const [side,review] of Object.entries(reviews)){
  const team=view[side];
  const changed=review.excluded.length>0||
    team.maclar.length<review.importedRows;
  const invalidated=[];
  if(changed){
   for(const field of affectedFields){
    if(team[field]!==undefined&&team[field]!==null){
     team[field]=null;invalidated.push(field);
    }
   }
  }
  team.takim=copy[side].takim;
  // Keep the original display name; summaries used the verified source name.
  team.takim=JSON.parse(typeof payload==='string'?payload:JSON.stringify(payload))[side].takim;
  team.analysisNormalization={
   ...team.analysisNormalization,
   identityCheckVersion:'cached-team-identity-v1',
   originalImportedRows:review.importedRows,
   excludedIdentityRows:review.excluded,
   canonicalTeamName:review.canonical,
   sourceIdentity:review.verifiedIdentity,
   independentlyVerifiedMatchResults:false,
   invalidatedIdentityOrDuplicateAffectedFields:[
    ...new Set([
      ...(team.analysisNormalization.invalidatedDuplicateAffectedAggregates||[]),
      ...invalidated
    ])
   ]
  };
  team.analysisMatches=team.analysisMatches.map(row=>{
   const stored=team.maclar.find(r=>
    r.tarih===row.tarih&&r.ev===row.ev&&r.deplasman===row.deplasman);
   return {...row,...(stored?.id!==undefined?{id:stored.id}:{}),
     ...(stored?.competition!==undefined?{competition:stored.competition}:{})};
  });
 }
 view.meta={...view.meta,teamIdentityViewVersion:'cached-team-identity-v1'};
 return view;
}
module.exports={buildCachedPerformanceAnalysisView};
