const { DroppingWatcher } = require('./dropping-watcher-core');

function row(currentOdd, outcomeId = '1') {
  return {
    matchId: 'MATCH1',
    outcomeId,
    match: 'Home - Away',
    selection: outcomeId,
    currentOdd
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const watcher = new DroppingWatcher();

let r = watcher.compare([row(2.00)]);
assert(r.primed === true && r.events.length === 0, 'prime failed');

r = watcher.compare([]);
assert(r.events.length === 0 && r.tracked === 0, 'disappear failed');

r = watcher.compare([row(2.00)]);
assert(r.events.length === 0, 'same-odd reappear duplicated');

r = watcher.compare([]);
assert(r.events.length === 0, 'second disappear failed');

r = watcher.compare([row(1.90)]);
assert(r.events.length === 1, 'changed reappear did not alert');
assert(r.events[0].type === 'odd_changed', 'changed reappear wrong type');
assert(Number(r.events[0].before.currentOdd) === 2.00, 'previous odd lost');
assert(Number(r.events[0].after.currentOdd) === 1.90, 'new odd wrong');

r = watcher.compare([row(1.90), row(3.10, '2')]);
assert(r.events.length === 1, 'different outcome not treated separately');
assert(r.events[0].type === 'new', 'different outcome wrong type');

console.log('REAPPEAR_DEDUPE=OK SAME=0 CHANGED=1 OTHER_OUTCOME=1');
