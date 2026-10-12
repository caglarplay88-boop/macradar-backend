
'use strict';

const TIME_CONVERSION_VERSION='betexplorer-source-time-v1';

function validCalendar(year,month,day,hour,minute) {
  if (![year,month,day,hour,minute].every(Number.isInteger) ||
      year<1000 || year>9999 || month<1 || month>12 ||
      day<1 || hour<0 || hour>23 || minute<0 || minute>59) return false;
  return day<=new Date(Date.UTC(year,month,0)).getUTCDate();
}

function utcFromCalendar(parts,offsetMinutes) {
  const [year,month,day,hour,minute]=parts;
  if (!validCalendar(...parts)) return null;
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes)>14*60) return null;
  return new Date(Date.UTC(year,month-1,day,hour,minute)-offsetMinutes*60000)
    .toISOString();
}

function result(raw,timezone,precision,timestamp,flags,extra={}) {
  return {
    source_timestamp:timestamp,
    source_timestamp_raw:raw==null?null:String(raw),
    source_timezone:timezone,
    timestamp_precision:precision,
    quality_flags:flags,
    conversion_version:TIME_CONVERSION_VERSION,
    ...extra
  };
}

// Verified source script: display hour = raw hour + selected offset - 1.
// This rule is applied only when the caller supplies its verification evidence.
function parseSourceCellTime(raw,{
  ruleVerified=false,evidenceRef=null
}={}) {
  const text=String(raw||'').trim();
  const match=text.match(/^(\d{1,2}),(\d{1,2}),(\d{4}),(\d{1,2}),(\d{1,2})$/);
  if (!match) return result(raw,null,null,null,['SOURCE_TIME_FORMAT_UNKNOWN']);
  const [,day,month,year,hour,minute]=match.map(Number);
  if (!validCalendar(year,month,day,hour,minute)) {
    return result(raw,null,'MINUTE',null,['SOURCE_TIME_INVALID']);
  }
  if (!ruleVerified || !evidenceRef) {
    return result(raw,null,'MINUTE',null,['SOURCE_TIMEZONE_UNVERIFIED']);
  }
  return result(raw,'UTC+01:00','MINUTE',
    utcFromCalendar([year,month,day,hour,minute],60),[],
    {timezone_evidence_ref:evidenceRef});
}

function parseArchiveTime(raw,{
  timezoneOffsetMinutes=null,timezoneVerified=false,
  timezoneEvidenceRef=null,year=null,yearVerified=false,yearEvidenceRef=null
}={}) {
  const text=String(raw||'').trim();
  const match=text.match(/^(\d{1,2})\.(\d{1,2})\.\s+(\d{1,2}):(\d{2})$/);
  if (!match) return result(raw,null,null,null,['SOURCE_TIME_FORMAT_UNKNOWN']);
  const day=Number(match[1]),month=Number(match[2]);
  const hour=Number(match[3]),minute=Number(match[4]);
  const flags=[];
  if (month<1 || month>12 || day<1 || day>31 || hour>23 || minute>59) {
    return result(raw,null,'MINUTE',null,['SOURCE_TIME_INVALID']);
  }
  const clockVerified=timezoneVerified && Boolean(timezoneEvidenceRef) &&
    Number.isInteger(timezoneOffsetMinutes) &&
    Math.abs(timezoneOffsetMinutes)<=14*60;
  const calendarYearVerified=yearVerified && Boolean(yearEvidenceRef) &&
    Number.isInteger(year);
  if (!clockVerified) flags.push('SOURCE_TIMEZONE_UNVERIFIED');
  if (!calendarYearVerified) flags.push('SOURCE_YEAR_UNVERIFIED');
  let timestamp=null;
  if (clockVerified && calendarYearVerified) {
    timestamp=utcFromCalendar([year,month,day,hour,minute],timezoneOffsetMinutes);
    if (!timestamp) flags.push('SOURCE_TIME_INVALID');
  }
  return result(raw,clockVerified?{
    kind:'FIXED_OFFSET',offset_minutes:timezoneOffsetMinutes
  }:null,'MINUTE',timestamp,flags,{
    year_missing_from_source:true,
    year_resolution:calendarYearVerified?{
      year,evidence_ref:yearEvidenceRef
    }:null,
    timezone_evidence_ref:clockVerified?timezoneEvidenceRef:null
  });
}

function eligibleAtCutoff(record,cutoff,mode='strict_as_of') {
  if (!['strict_as_of','retrospective_source_history'].includes(mode)) {
    throw new Error('UNKNOWN_ANALYSIS_MODE');
  }
  const cutoffMs=Date.parse(cutoff);
  if (!Number.isFinite(cutoffMs) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(String(cutoff))) {
    throw new Error('CUTOFF_REQUIRES_EXPLICIT_TIMEZONE');
  }
  const observed=Date.parse(record.observed_at);
  if (!Number.isFinite(observed) ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(String(record.observed_at))) {
    return {eligible:false,reasons:['OBSERVATION_TIME_INVALID']};
  }
  const reasons=[];
  if (mode==='strict_as_of' && observed>cutoffMs) {
    reasons.push('OBSERVED_AFTER_CUTOFF');
  }
  if (record.source_timestamp!=null) {
    const source=Date.parse(record.source_timestamp);
    if (!Number.isFinite(source) ||
        !/(?:Z|[+-]\d{2}:\d{2})$/.test(String(record.source_timestamp))) {
      reasons.push('SOURCE_TIME_INVALID');
    } else if (source>cutoffMs) reasons.push('SOURCE_TIME_AFTER_CUTOFF');
  } else if (mode==='retrospective_source_history' &&
             record.record_origin!=='scraper_observation') {
    reasons.push('HISTORY_TIME_UNVERIFIED');
  }
  return {eligible:reasons.length===0,reasons};
}

module.exports={
 TIME_CONVERSION_VERSION,parseSourceCellTime,parseArchiveTime,eligibleAtCutoff
};
