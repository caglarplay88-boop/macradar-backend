const { fetchDropping } = require('./dropping-source');

function matchBlock(matchId, outcomeId, selectionClass, oldOdd, currentOdd) {
  return [
    '<tbody>',
    '<tr>',
    '<td class="table-main__date">25.09.2026</td>',
    '<td class="table-main__time">12:30</td>',
    '<td><a href="/football/test/league/' + matchId + '/">Alpha - Beta</a></td>',
    '<td class="table-main__odds ' + selectionClass + '" data-oid="' + outcomeId + '">',
    '<li>Drop: 20%</li>',
    '<span data-odd="' + oldOdd + '"></span> &raquo; <span data-odd="' + currentOdd + '"></span>',
    "B's: 60% (6/10)",
    '</td>',
    '<td class="table-main__odds" data-oid="' + outcomeId + 'X"></td>',
    '<td class="table-main__odds" data-oid="' + outcomeId + '2"></td>',
    '</tr>',
    '</tbody>'
  ].join('');
}

const page1 =
  matchBlock('PAGE1', 'OID1', 'drop1', '2.50', '2.00') +
  '<a rel="next" href="?sport_id=1&hours=1&days=1&bookies=30&lang=en&page=2">Next</a>';

const page2 =
  matchBlock('PAGE2', 'OID2', 'drop1', '3.00', '2.40');

let calls = 0;
async function fetchImpl(url) {
  calls++;
  const html = String(url).includes('page=2') ? page2 : page1;
  return {
    ok: true,
    status: 200,
    text: async () => html
  };
}

(async () => {
  const rows = await fetchDropping({
    hours: 1,
    days: 1,
    bookies: 30,
    fetchImpl,
    maxPages: 5
  });

  if (calls !== 2) throw new Error('expected 2 page fetches, got ' + calls);
  if (rows.length !== 2) throw new Error('expected 2 rows, got ' + rows.length);
  if (rows.map(x => x.matchId).sort().join(',') !== 'PAGE1,PAGE2') {
    throw new Error('pagination rows missing');
  }

  let overflow = false;
  calls = 0;
  try {
    await fetchDropping({
      hours: 1,
      days: 1,
      bookies: 30,
      fetchImpl,
      maxPages: 1
    });
  } catch (error) {
    overflow = /pagination overflow/.test(error.message);
  }

  if (!overflow) throw new Error('overflow guard did not trigger');

  console.log('PAGINATION=OK PAGES=2 ROWS=2 OVERFLOW_GUARD=OK');
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
