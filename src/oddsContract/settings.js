
'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  version: 'betexplorer-collection-settings-v1',
  scheduling: Object.freeze({
    currentMinutes: Object.freeze({
      moreThan72Hours: 60,
      from72To24Hours: 30,
      from24To6Hours: 10,
      from6To1Hour: 5,
      lastHour: 2
    }),
    unknownKickoffMinutes: 60,
    historyMinutesBeforeLast6Hours: 30,
    historyMinutesWithinLast6Hours: 10,
    maxConcurrentMatches: 2,
    maxConcurrentSourceRequests: 2,
    retryInitialSeconds: 60,
    retryMaximumSeconds: 1800
  })
});

function positive(value, field, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      value <= 0 || (integer && !Number.isInteger(value))) {
    throw new Error('INVALID_COLLECTION_SETTING:' + field);
  }
  return value;
}

function buildSettings(overrides = {}) {
  const input = overrides.scheduling || {};
  const currentMinutes = {
    ...DEFAULT_SETTINGS.scheduling.currentMinutes,
    ...(input.currentMinutes || {})
  };
  const scheduling = {
    ...DEFAULT_SETTINGS.scheduling,
    ...input,
    currentMinutes
  };
  for (const [key, value] of Object.entries(currentMinutes)) {
    if (!(key in DEFAULT_SETTINGS.scheduling.currentMinutes)) {
      throw new Error('UNKNOWN_COLLECTION_SETTING:' + key);
    }
    positive(value, 'currentMinutes.' + key);
  }
  for (const key of Object.keys(scheduling)) {
    if (!(key in DEFAULT_SETTINGS.scheduling)) {
      throw new Error('UNKNOWN_COLLECTION_SETTING:' + key);
    }
    if (key !== 'currentMinutes') {
      positive(scheduling[key], key, key.startsWith('maxConcurrent'));
    }
  }
  if (scheduling.retryMaximumSeconds < scheduling.retryInitialSeconds) {
    throw new Error('INVALID_RETRY_LIMITS');
  }
  return {
    version: DEFAULT_SETTINGS.version,
    scheduling,
    basis: 'CONFIGURABLE_PROGRAM_DEFAULTS',
    sourceUpdateFrequencyClaimed: false,
    scientificOptimalityClaimed: false,
    boundaryRule: 'At a threshold, use the nearer-kickoff interval.'
  };
}

function verifiedInstant(value) {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function collectionSchedule({
  now, kickoff, kickoffVerified = false, settings = buildSettings()
}) {
  const observedNow = verifiedInstant(now);
  if (observedNow === null) throw new Error('NOW_REQUIRES_EXPLICIT_TIMEZONE');
  const kickoffTime = kickoffVerified ? verifiedInstant(kickoff) : null;
  const config = settings.scheduling;
  if (kickoffTime === null) {
    return {
      currentMinutes: config.unknownKickoffMinutes,
      historyMinutes: config.historyMinutesBeforeLast6Hours,
      hoursToKickoff: null,
      stopPreMatch: false,
      reason: 'KICKOFF_UNVERIFIED',
      mainAnalysisEligible: false
    };
  }
  const hours = (kickoffTime - observedNow) / 3600000;
  if (hours <= 0) {
    return {
      currentMinutes: null, historyMinutes: null,
      hoursToKickoff: hours, stopPreMatch: true,
      reason: 'VERIFIED_KICKOFF_REACHED',
      mainAnalysisEligible: false
    };
  }
  const bands = config.currentMinutes;
  const currentMinutes = hours > 72 ? bands.moreThan72Hours :
    hours > 24 ? bands.from72To24Hours :
    hours > 6 ? bands.from24To6Hours :
    hours > 1 ? bands.from6To1Hour : bands.lastHour;
  return {
    currentMinutes,
    historyMinutes: hours > 6 ?
      config.historyMinutesBeforeLast6Hours :
      config.historyMinutesWithinLast6Hours,
    hoursToKickoff: hours, stopPreMatch: false,
    reason: 'VERIFIED_KICKOFF_SCHEDULE',
    mainAnalysisEligible: null
  };
}

function retryDelaySeconds(consecutiveFailures, settings = buildSettings()) {
  if (!Number.isInteger(consecutiveFailures) || consecutiveFailures < 1) {
    throw new Error('INVALID_FAILURE_COUNT');
  }
  const config = settings.scheduling;
  return Math.min(config.retryMaximumSeconds,
    config.retryInitialSeconds * Math.pow(2, Math.min(30, consecutiveFailures - 1)));
}

module.exports = {
  DEFAULT_SETTINGS, buildSettings, collectionSchedule, retryDelaySeconds
};
