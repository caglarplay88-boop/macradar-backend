function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function median(values) {
  const a = values.map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function parseBetExplorerUrl(raw) {
  const u = new URL(raw);
  if (!/(^|\.)betexplorer\.com$/i.test(u.hostname)) {
    throw new Error('BetExplorer maç linki olmalı.');
  }
  const p = u.pathname.split('/').filter(Boolean);
  const eventId = p[p.length - 1] || '';
  const slug = p[p.length - 2] || eventId;
  if (!/^[A-Za-z0-9]{6,12}$/.test(eventId)) {
    throw new Error('BetExplorer event ID bulunamadı.');
  }
  u.search = '';
  u.hash = '';
  return { url: u.toString(), eventId, slug };
}

function currentIsoTurkey() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const o = {};
  for (const p of parts) if (p.type !== 'literal') o[p.type] = p.value;
  return `${o.year}-${o.month}-${o.day}`;
}

module.exports = { sleep, median, parseBetExplorerUrl, currentIsoTurkey };
