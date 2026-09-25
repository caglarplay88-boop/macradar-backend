const { fetchDropping } = require('./dropping-source');

function keyOf(row) {
  return row.matchId + '|' + row.outcomeId;
}

function diffRows(before, after) {
  const previous = new Map(before.map(row => [keyOf(row), row]));
  const current = new Map(after.map(row => [keyOf(row), row]));

  const unchanged = [];
  const changed = [];
  const added = [];
  const removed = [];

  for (const [key, row] of current) {
    const old = previous.get(key);
    if (!old) {
      added.push(row);
    } else if (Number(old.currentOdd) !== Number(row.currentOdd)) {
      changed.push({ before: old, after: row });
    } else {
      unchanged.push(row);
    }
  }

  for (const [key, row] of previous) {
    if (!current.has(key)) removed.push(row);
  }

  return { unchanged, changed, added, removed };
}

async function main() {
  const first = await fetchDropping();
  console.log('FIRST=' + first.length);

  await new Promise(resolve => setTimeout(resolve, 2500));

  const second = await fetchDropping();
  console.log('SECOND=' + second.length);

  const diff = diffRows(first, second);
  console.log(
    'UNCHANGED=' + diff.unchanged.length +
    ' CHANGED=' + diff.changed.length +
    ' ADDED=' + diff.added.length +
    ' REMOVED=' + diff.removed.length
  );

  if (diff.changed.length) {
    console.log(JSON.stringify(diff.changed, null, 2));
  }
}

main().catch(error => {
  console.error('DIFF_TEST_ERROR=' + (error.message || error));
  process.exitCode = 1;
});
