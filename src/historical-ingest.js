const { getBulletin } = require('./bulletin');
const { upsertMatch, finishMatch } = require('./db');
const { parseBetExplorerUrl, sleep } = require('./util');

function normalizeIsoDate(value) {
  const m = String(value || '').match(/^\d{4}-\d{2}-\d{2}$/);
  return m ? m[0] : null;
}

function enumerateDates(from, to) {
  const start = normalizeIsoDate(from);
  const end = normalizeIsoDate(to);
  if (!start || !end) throw new Error('from/to YYYY-MM-DD olmalı.');

  const startMs = Date.parse(start + 'T00:00:00Z');
  const endMs = Date.parse(end + 'T00:00:00Z');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs > endMs) {
    throw new Error('Geçerli tarih aralığı gerekli.');
  }

  const dates = [];
  for (let ms = startMs; ms <= endMs; ms += 86400000) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

async function ingestHistoricalRange({
  from,
  to,
  dryRun = false,
  maxDays = 31,
  delayMs = 250
} = {}) {
  const dates = enumerateDates(from, to);
  if (dates.length > maxDays) {
    throw new Error('Tarih aralığı maxDays sınırını aşıyor: ' + dates.length);
  }

  const summary = {
    from: dates[0],
    to: dates[dates.length - 1],
    days: dates.length,
    fetched_days: 0,
    finished_seen: 0,
    saved: 0,
    skipped_without_score: 0,
    failed_days: 0,
    errors: []
  };

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];

    try {
      const daily = await getBulletin(date, { force: true });
      summary.fetched_days++;

      for (const match of daily.matches || []) {
        if (match.status !== 'finished') continue;
        summary.finished_seen++;

        if (!Number.isInteger(match.homeScore) || !Number.isInteger(match.awayScore)) {
          summary.skipped_without_score++;
          continue;
        }

        if (dryRun) continue;

        const parsed = parseBetExplorerUrl(match.url);
        await upsertMatch({
          eventId: parsed.eventId,
          url: parsed.url,
          slug: parsed.slug,
          active: false,
          displayName: match.name || null,
          league: match.league || null,
          matchDate: normalizeIsoDate(match.date) || date,
          kickoffTime: /^\d{1,2}:\d{2}$/.test(String(match.time || ''))
            ? String(match.time)
            : null
        });
        await finishMatch(parsed.eventId, match.homeScore, match.awayScore);
        summary.saved++;
      }
    } catch (error) {
      summary.failed_days++;
      summary.errors.push({
        date,
        error: String(error?.message || error).slice(0, 300)
      });
    }

    if (i < dates.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return summary;
}

module.exports = {
  enumerateDates,
  ingestHistoricalRange
};

