
'use strict';
const crypto=require('node:crypto');
const {buildSettings}=require('./settings');
const {reviewQuality}=require('./quality');
const {summarizeSeries,CALCULATION_VERSION}=require('./seriesSummary');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
const SCHEMA_VERSION='betexplorer-match-data-v2';
const FIELDS={
 '1X2':[['HOME','home_odd'],['DRAW','draw_odd'],['AWAY','away_odd']],
 OU:[['UNDER','under_odd'],['OVER','over_odd']],
 ASIAN:[['HOME','home_odd'],['AWAY','away_odd']],
 KG:[['YES','yes_odd'],['NO','no_odd']]
};
function importLegacy(base){
 const raw=[],evidence={},contexts={},odds={};
 const event=base.match?.event_id;
 if(!event) throw Error('EXPORT_MATCH_EVENT_ID_MISSING');
 for(const [market,fields] of Object.entries(FIELDS)){
  const rows=base.odds?.[market]||[];
  if(!Array.isArray(rows)) throw Error('LEGACY_MARKET_NOT_ARRAY:'+market);
  odds[market]=rows.map((original,index)=>{
   const row=clone(original);
   const context={
    source:'BetExplorer',legacy_source_name:row.source_name??null,
    legacy_source_region:row.source_region??null,
    region_verified:false,language:null,timezone_preference:null,
    bookmaker_group:null,legacy_context_only:true
   };
   const contextId='legacy-context-'+hash(context);
   contexts[contextId]=context;
   const evidenceId='legacy-evidence-'+hash([market,index,row]);
   evidence[evidenceId]={
    kind:'LEGACY_DATABASE_EXPORT_ROW',original_row:clone(row),
    original_source_response_available:false,
    source_time_and_observation_time_reverified:false
   };
   const ids=[];
   for(const [selection,field] of fields){
    const recordId='legacy-record-'+hash([market,index,row,selection]);
    ids.push(recordId);
    const price=row[field]==null?null:Number(row[field]);

    const lineRaw=market==='OU'?row.total_line??null:
     market==='ASIAN'?row.handicap_line??null:null;
    const lineText=lineRaw===null?'':String(lineRaw).trim();
    const line=lineRaw!==null&&/^[+-]?\d+(?:\.\d+)?$/.test(lineText)&&
     Number.isFinite(Number(lineText))?Number(lineText):null;
    const record={
     record_id:recordId,event_id:row.event_id||event,
     source:'BetExplorer',source_url:base.match?.url??null,
     source_context_id:contextId,
     bookmaker_id:row.bookmaker_id??row.bookmaker_key??null,
     bookmaker_name:row.bookmaker_name??null,
     market,period:'FULL_TIME_90',selection,line,
     legacy_line_raw:lineRaw,
     line_interpretation_basis:'LEGACY_DB_DECIMAL_VALUE_NOT_SOURCE_SIGN_VERIFICATION',

     home_handicap:null,away_handicap:null,
     odds_decimal:Number.isFinite(price)?price:null,
     status:'UNKNOWN',price_type:'UNKNOWN',source_record_id:null,
     source_timestamp:null,source_timestamp_raw:null,source_timezone:null,
     timestamp_precision:null,observed_at:null,
     capture_started_at:null,capture_finished_at:null,
     snapshot_id:null,quote_group_id:null,source_group_id:null,
     record_origin:row.capture_type==='opening'?'source_opening':'scraper_observation',
     opening_type:null,is_main_line:null,
     quality_flags:[
      'LEGACY_SOURCE_EVIDENCE_UNAVAILABLE',
      'LEGACY_OBSERVATION_TIME_UNVERIFIED',
      'PERIOD_UNVERIFIED','PRE_MATCH_SCOPE_UNVERIFIED',
      'PRICE_TYPE_UNVERIFIED',
      ...(market==='ASIAN'?['ASIAN_HOME_SIGN_UNVERIFIED']:[]),
      ...(row.capture_type==='opening'?['LEGACY_OPENING_NOT_REVERIFIED']:[])
     ],
     raw_evidence_ref:evidenceId,
     main_analysis_eligible:false,scope_verified:false,
     legacy_timing:{
      captured_at:row.captured_at??null,created_at:row.created_at??null,
      capture_type:row.capture_type??null,
      values_preserved_without_reinterpretation:true
     },
     legacy_status:{
      home_closed:row.home_closed??null,draw_closed:row.draw_closed??null,
      away_closed:row.away_closed??null,under_closed:row.under_closed??null,
      over_closed:row.over_closed??null,yes_closed:row.yes_closed??null,
      no_closed:row.no_closed??null
     }
    };
    record.series_id=hash([
     event,record.source,record.bookmaker_id,contextId,market,
     record.period,line,selection,record.price_type
    ]);
    if(lineRaw!==null&&line===null){
     record.quality_flags.push('LEGACY_LINE_UNPARSEABLE');
    }
    raw.push(record);
   }
   return {...row,raw_record_ids:ids,
    compatibility_group_basis:'EXISTING_DATABASE_ROW',
    source_simultaneity_reverified:false};
  });
 }
 return {raw,evidence,contexts,odds};
}
function buildContractExport(base,{
 state=null,analysisCutoff=new Date().toISOString(),
 analysisMode='strict_as_of',settings=buildSettings(),
 qualityThresholds={},maxWindowCarrySeconds=300
}={}){
 if(base.schema_version) throw Error('LEGACY_BASELINE_REQUIRED');
 const data=clone(base);
 const legacy=importLegacy(data);
 const stored=state?clone(state):{};
 const newRaw=Array.isArray(stored.odds_raw)?
  stored.odds_raw:Object.values(stored.odds_raw||{});
 const raw=[...legacy.raw,...newRaw];
 if(new Set(raw.map(r=>r.record_id)).size!==raw.length){
  throw Error('EXPORT_RAW_RECORD_ID_COLLISION');
 }
 const evidence={...legacy.evidence,...(stored.raw_evidence||{})};
 for(const record of raw){
  if(record.event_id!==data.match.event_id) throw Error('EXPORT_EVENT_MISMATCH');
  if(!evidence[record.raw_evidence_ref]) throw Error('EXPORT_EVIDENCE_MISSING');
 }
 const runs=stored.runs||[];
 const reviewed=reviewQuality(raw,{
  cutoff:analysisCutoff,mode:analysisMode,runs,
  thresholds:qualityThresholds,
  verifiedKickoff:stored.match_identity?.kickoff_verified?
   stored.match_identity.kickoff:stored.tracking?.verified_kickoff||null
 });
 const quoteProjection=require('./quoteCompatibility').projectQuotes({
  ...stored,odds_raw:reviewed.odds_raw
 });
 const compatibleOdds=Object.fromEntries(
  ['1X2','OU','ASIAN','KG'].map(market=>[
   market,[...(legacy.odds[market]||[]),...quoteProjection.odds[market]]
  ])
 );
 const series=new Map();
 for(const record of reviewed.odds_raw){
  if(!series.has(record.series_id)) series.set(record.series_id,[]);
  series.get(record.series_id).push(record);
 }
 const summaries=[...series.values()].map(records=>summarizeSeries(records,{
  cutoff:analysisCutoff,mode:analysisMode,maxWindowCarrySeconds
 }));
 const lastRun=runs.at(-1)||null;
 const lastSuccess=runs.filter(r=>r.success&&r.odds_collection_performed!==false).at(-1)||null;
 const warnings=[
  'Eski captured_at korunmuştur: açılış satırlarında eski ayrıştırıcının birleşik kaynak zamanı, current/periodic satırlarında toplama zamanı olarak kullanılmıştır. Yeni source_timestamp veya observed_at yerine geçirilmemiştir.',
  'Eski kayıtların gerçek gözlem zamanları ve özgün kaynak yanıtları yeniden doğrulanmadığından ana analize uygun sayılmamıştır.',
  'Eski ASIAN handicap_line değerleri korunmuştur; ev takımının işaretli handikap anlamı yeniden doğrulanmadan dönüştürülmemiştir.',
  'Yeni bağlam, dönem, fiyat türü, kesim ve grup kurallarının mevcut MacRadar okuyucusunda entegrasyon testi yapılmadı.',
  'Yeni odds satırları yalnızca aynı kaynak tablo satırında birlikte alınan ham taraf kayıtlarından üretilmiştir. Eksik fiyat ve belirsiz durumlar null korunur; gruplanamayan arşiv tarafları odds_raw içinde kalır. Mevcut okuyucunun bu anlamları desteklediği henüz doğrulanmamıştır.'
 ];
 const compatibility={
  legacy_fields_preserved:true,
  captured_at_semantics_changed:false,
  integration_test_status:'NOT_RUN',
  full_compatibility_verified:false,warnings,
  new_raw_records_not_in_legacy_odds:newRaw.map(r=>r.record_id),
  required_adapter_changes:[
   'schema_version, odds_raw ve raw_evidence bölümlerini okumak.',
   'source_timestamp ve observed_at ayrımını ve analysis_mode kesimini uygulamak.',
   'source_context_id, quote_group_id, period ve price_type kurallarını desteklemek.',
   'Kalite bayraklarını ve uygun olmayan kayıtların dışlama nedenlerini göstermek.',
   'Asian ev/deplasman işaret doğrulamasını ve bütün OU/Asian çizgilerini desteklemek.'
  ]
 };
 return {
  ...data,schema_version:SCHEMA_VERSION,
  calculation_version:CALCULATION_VERSION,
  exportedAt:new Date().toISOString(),
  collection:{
   analysis_cutoff:analysisCutoff,analysis_mode:analysisMode,
   last_successful_scan:lastSuccess,
   last_scan_result:lastRun,
   data_freshness:{
    verified_current:false,
    reason:lastRun&&!lastRun.success?'LAST_SCAN_FAILED':
     'CURRENT_SOURCE_AND_SCOPE_NOT_FULLY_VERIFIED'
   },
   runs,history_coverage:stored.coverage||{},
   source_contexts:{...legacy.contexts,...(stored.source_contexts||{})},
   quote_groups:stored.quote_groups||[],
   interruptions:stored.interruptions||[],
   archive_retrievals:stored.archive_retrievals||[],
   history_deduplication:{
    basis:'IDENTICAL_FULL_RESPONSE_SAME_SERIES_AND_CONTEXT',
    different_or_ambiguous_responses_preserved:true,
    first_observed_at_preserved:true
   },

   collection_gaps:reviewed.quality.collection_gaps,
   match_identity:stored.match_identity||null,
   identity_checks:stored.identity_checks||[],
   compatibility_write_errors:stored.compatibility_write_errors||[],
   checkpoints:stored.checkpoints||[],
   kickoff_changes:stored.kickoff_changes||[],
   settings,parser_versions:[...new Set(
    Object.values(stored.raw_evidence||{}).map(x=>x.parser_version).filter(Boolean)
   )],
   time_conversion:{
    version:'betexplorer-source-time-v1',
    unknown_times_are_null:true,legacy_times_reinterpreted:false
   },
   compatibility
  },
  odds_raw:reviewed.odds_raw,raw_evidence:evidence,
  odds:compatibleOdds,
  quote_compatibility:{
   storage_basis:'DERIVED_FROM_RAW_NOT_A_SECOND_ODDS_STORE',
   projected_group_counts:Object.fromEntries(
    Object.entries(quoteProjection.odds).map(([market,rows])=>[market,rows.length])
   ),
   exclusions:quoteProjection.exclusions,
   historical_selections_without_quote_groups_not_combined:true
  },
  odds_summary:{
   calculation_version:CALCULATION_VERSION,
   analysis_cutoff:analysisCutoff,analysis_mode:analysisMode,
   max_window_carry_seconds:maxWindowCarrySeconds,
   series:summaries,quote_groups:reviewed.quality.group_reviews,
   bookmaker_comparisons:require('./bookmakerComparison').compareBookmakers({
    records:reviewed.odds_raw,summaries,
    sourceContexts:stored.source_contexts||{}
   })

  },
  quality:reviewed.quality,compatibility
 };
}
module.exports={SCHEMA_VERSION,buildContractExport};
