'use strict';
// Deduplicate scans of one provider's payload, never combine provider statistics.
function dedupeMatches(rows) {
  const fixtures = new Map();
  for (const m of rows) {
    const time = Date.parse(m.date);
    const complete = Number.isFinite(time) && m.home && m.away &&
      Number.isInteger(m.homeScore) && Number.isInteger(m.awayScore);
    const key = complete
      ? JSON.stringify([new Date(time).toISOString(), m.home, m.away, m.homeScore, m.awayScore])
      : JSON.stringify([m.id || '', m.date, m.home, m.away, m.homeScore, m.awayScore, m.url]);
    if (!fixtures.has(key)) fixtures.set(key, []);
    fixtures.get(key).push(m);
  }
  const result = [];
  for (const group of fixtures.values()) {
    const ids = new Set(group.filter(m => m.id != null && m.id !== '').map(m => String(m.id)));
    const clusters = new Map();
    for (const m of group) {
      // An id-less record is ambiguous when multiple provider IDs share the fixture.
      const key = ids.size <= 1 ? 'single' : (m.id != null && m.id !== '' ? String(m.id) : 'unknown');
      if (!clusters.has(key)) clusters.set(key, []);
      clusters.get(key).push(m);
    }
    for (const cluster of clusters.values()) {
      const quality = m => (m.id != null && m.id !== '' ? 4 : 0) + (m.url ? 2 : 0) + (m.status ? 1 : 0);
      const sorted = cluster.slice().sort((a, b) => quality(b) - quality(a));
      const selected = { ...sorted[0] };
      for (const m of sorted.slice(1)) {
        for (const [key, value] of Object.entries(m)) {
          if ((selected[key] == null || selected[key] === '') && value != null && value !== '') selected[key] = value;
        }
      }
      result.push(selected);
    }
  }
  return result;
}
module.exports = { dedupeMatches };
