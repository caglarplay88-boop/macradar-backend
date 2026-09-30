function batchTimeMs(batch) {
  const value = new Date(batch?.captured_at).getTime();
  return Number.isFinite(value) ? value : null;
}

function batchSequence(batch) {
  try {
    return BigInt(String(batch?.capture_sequence || '0'));
  } catch {
    return 0n;
  }
}

function latestLiveOddsBatch(current, periodic) {
  if (!current) return periodic || null;
  if (!periodic) return current;

  const currentMs = batchTimeMs(current);
  const periodicMs = batchTimeMs(periodic);

  if (currentMs !== null && periodicMs !== null) {
    if (periodicMs > currentMs) return periodic;
    if (currentMs > periodicMs) return current;
  }

  return batchSequence(periodic) > batchSequence(current)
    ? periodic
    : current;
}

module.exports = {
  latestLiveOddsBatch
};
