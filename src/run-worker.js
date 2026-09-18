const { listMatches } = require('./db');
const { pullAndSave } = require('./puller');
const { sleep } = require('./util');

let running = false;

async function runWorkerOnce() {
  if (running) return { skipped: true, reason: 'already_running' };
  running = true;
  try {
    const matches = await listMatches({ activeOnly: true });
    const results = [];
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const r = await pullAndSave(m.url, { attempts: 3 });
      results.push({ eventId: m.event_id, ...r });
      if (i < matches.length - 1) await sleep(12000);
    }
    const ok = results.filter(x => x.ok).length;
    return { skipped: false, total: results.length, ok, fail: results.length - ok, results };
  } finally {
    running = false;
  }
}

module.exports = { runWorkerOnce };
