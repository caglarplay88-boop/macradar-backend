const { fetchDropping } = require('./dropping-source');

function itemKey(row) {
  return row.matchId + '|' + row.outcomeId;
}

class DroppingWatcher {
  constructor(initialRows = []) {
    this.state = new Map();
    this.primed = false;
    if (Array.isArray(initialRows) && initialRows.length) this.hydrate(initialRows);
  }

  snapshot(rows) {
    const next = new Map();
    for (const row of rows) next.set(itemKey(row), row);
    return next;
  }

  hydrate(rows) {
    this.state = this.snapshot(rows || []);
    this.primed = true;
    return this.state.size;
  }

  prime(rows) {
    this.state = this.snapshot(rows);
    this.primed = true;
    return { primed: true, tracked: this.state.size, events: [] };
  }

  compare(rows) {
    if (!this.primed) return this.prime(rows);
    const next = this.snapshot(rows);
    const events = [];

    for (const [key, row] of next) {
      const previous = this.state.get(key);
      if (!previous) {
        events.push({ type: 'new', key, before: null, after: row });
      } else if (Number(previous.currentOdd) !== Number(row.currentOdd)) {
        events.push({ type: 'odd_changed', key, before: previous, after: row });
      }
    }

    for (const [key, row] of next) {
      this.state.set(key, row);
    }

    return { primed: false, tracked: next.size, events };
  }

  async poll(options = {}) {
    const rows = await fetchDropping(options);
    return { rows, result: this.compare(rows) };
  }
}

module.exports = { DroppingWatcher, itemKey };
