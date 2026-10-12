
'use strict';
const {dedupeMatches} = require('../performanceMatchIdentity');
const numeric = value => {
  if(value===null || value===undefined || value==='' || typeof value==='boolean') return null;
  const number=Number(value);
  return Number.isFinite(number)?number:null;
};
const name = value => String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function summarize(rows, teamName) {
  const result={mac:0,galibiyet:0,beraberlik:0,maglubiyet:0,attigiGol:0,yedigiGol:0,
    ev:{mac:0,G:0,B:0,M:0,attigi:0,yedigi:0},
    deplasman:{mac:0,G:0,B:0,M:0,attigi:0,yedigi:0}};
  for(const row of rows) {
    const home=name(row.ev)===name(teamName);
    const away=name(row.deplasman)===name(teamName);
    if(!home && !away) throw new Error('PERFORMANCE_TEAM_IDENTITY_UNRESOLVED');
    const gf=numeric(home?row.evGol:row.deplasmanGol);
    const ga=numeric(home?row.deplasmanGol:row.evGol);
    if(!Number.isInteger(gf)||gf<0||!Number.isInteger(ga)||ga<0) continue;
    result.mac++; result.attigiGol+=gf; result.yedigiGol+=ga;
    const location=home?result.ev:result.deplasman;
    location.mac++; location.attigi+=gf; location.yedigi+=ga;
    if(gf>ga){result.galibiyet++;location.G++;}
    else if(gf===ga){result.beraberlik++;location.B++;}
    else {result.maglubiyet++;location.M++;}
  }
  result.macBasiGol=result.mac?Number((result.attigiGol/result.mac).toFixed(2)):null;
  result.macBasiYedigi=result.mac?Number((result.yedigiGol/result.mac).toFixed(2)):null;
  const xs=rows.map(r=>numeric(r.xG)).filter(v=>v!==null);
  const as=rows.map(r=>numeric(r.xGA)).filter(v=>v!==null);
  const average=values=>values.length?Number((values.reduce((a,b)=>a+b,0)/values.length).toFixed(2)):null;
  return {sonuc:result,xG:average(xs),xGA:average(as),xGVerisi:xs.length,xGAVerisi:as.length};
}
function buildCachedPerformanceAnalysisView(payload) {
  const copy=JSON.parse(typeof payload==='string'?payload:JSON.stringify(payload));
  const reviews=[];
  for(const key of ['evTakimi','deplasmanTakimi']) {
    const team=copy[key];
    if(!team || !Array.isArray(team.maclar)) continue;
    const teamName=typeof team.takim==='string'?team.takim:(team.takim?.ad||team.takim?.name);
    if(!teamName) throw new Error('PERFORMANCE_TEAM_NAME_MISSING');
    const original=team.maclar;
    const unique=dedupeMatches(original.map(row=>({
      ...row,date:row.tarih,home:row.ev,away:row.deplasman,
      homeScore:row.evGol,awayScore:row.deplasmanGol
    }))).map(({date,home,away,homeScore,awayScore,...row})=>row);
    const completed=unique.filter(r=>Number.isInteger(numeric(r.evGol))&&Number.isInteger(numeric(r.deplasmanGol)))
      .sort((a,b)=>Date.parse(b.tarih)-Date.parse(a.tarih));
    if(completed.some(r=>!Number.isFinite(Date.parse(r.tarih)))) throw new Error('PERFORMANCE_MATCH_DATE_INVALID');
    const last5=completed.slice(0,5), last10=completed.slice(0,10);
    team.maclar=unique;
    team.son5={...(team.son5||{}),...summarize(last5,teamName)};
    team.son10={...(team.son10||{}),...summarize(last10,teamName)};
    team.analysisMatches=last10.map(r=>Object.fromEntries(
      ['tarih','ev','deplasman','evGol','deplasmanGol','xG','xGA','istatistik']
        .filter(field=>r[field]!==undefined).map(field=>[field,r[field]])
    ));
    const invalidated=[];
    if(unique.length<original.length) {
      for(const field of [
        'standartIstatistik','duelContext','styleContext','pressingContext',
        'ilk11Surekliligi','goalkeeperContext','kirmiziKartBaglami',
        'progressionContext','teknikSistemDegisimi','highZoneRegainContext',
        'playerProgressionContext','defensiveStructureContext',
      ]) {
        if(team[field]!==undefined && team[field]!==null) {
          team[field]=null; invalidated.push(field);
        }
      }
    }
    team.analysisNormalization={
      version:'cached-unique-match-analysis-v1',
      originalRows:original.length,uniqueRows:unique.length,
      aggregatesRecalculatedFromCachedRows:true,
      originalScrapeTimeVerified:false,
      invalidatedDuplicateAffectedAggregates:invalidated,
      individualMatchStatisticsPreserved:true,
    };
    reviews.push({team:teamName,originalRows:original.length,uniqueRows:unique.length});
  }
  copy.meta={...(copy.meta||{}),analysisNormalizationVersion:'cached-unique-match-analysis-v1',analysisNormalization:reviews};
  return copy;
}
module.exports={buildCachedPerformanceAnalysisView};
