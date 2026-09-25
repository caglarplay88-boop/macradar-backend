const { parseDropping } = require('./dropping-source');

const html = [
  '<tbody>',
  '<tr>',
  '<td class="table-main__date">25.09.2026</td>',
  '<td class="table-main__time">12:30</td>',
  '<td><a href="/football/test/league/MATCH123/">Alpha - Beta</a></td>',
  '<td class="table-main__odds drop1" data-oid="OID1">',
  '<li>Drop: 20%</li>',
  '<span data-odd="2.50"></span> &raquo; <span data-odd="2.00"></span>',
  "B's: 60% (6/10)",
  '</td>',
  '<td class="table-main__odds drop2" data-oid="OIDX">',
  '<li>Drop: 15%</li>',
  '<span data-odd="3.20"></span> &raquo; <span data-odd="2.72"></span>',
  "B's: 70% (7/10)",
  '</td>',
  '<td class="table-main__odds drop3" data-oid="OID2">',
  '<li>Drop: 25%</li>',
  '<span data-odd="4.00"></span> &raquo; <span data-odd="3.00"></span>',
  "B's: 80% (8/10)",
  '</td>',
  '</tr>',
  '</tbody>'
].join('');

const rows = parseDropping(html);

if (rows.length !== 3) {
  throw new Error('expected 3 outcomes, got ' + rows.length);
}
if (rows.map(x => x.selection).join(',') !== '1,X,2') {
  throw new Error('selection mapping failed');
}
if (rows.map(x => x.outcomeId).join(',') !== 'OID1,OIDX,OID2') {
  throw new Error('outcome ids failed');
}
if (rows.map(x => x.currentOdd).join(',') !== '2,2.72,3') {
  throw new Error('current odds failed');
}

console.log('MULTI_OUTCOME=OK ROWS=3 SELECTIONS=1,X,2');
