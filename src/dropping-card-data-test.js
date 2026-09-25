const { parseDropping } = require('./dropping-source');

const html = [
  '<tbody>',
  '<tr><th><a href="/football/sweden/allsvenskan-women/" class="table-main__tournament">',
  '<i><img src="https://cci.betexplorer.com/se.svg" alt="Sweden" title="Sweden"></i>',
  'Sweden: Allsvenskan Women</a></th></tr>',
  '<tr><th class="table-main__date">26.09.2026</th></tr>',
  '<tr>',
  '<td class="table-main__tt"><span class="table-main__time">16:00</span>',
  '<a href="/football/sweden/allsvenskan-women/uppsala-djurgarden/MATCH123/">Uppsala W - Djurgarden W</a></td>',
  '<td class="table-main__drop">42%</td>',
  '<td class="table-main__odds drop3" data-oid="OID1">',
  '<button data-odd="11.12"></button>',
  '<li>Drop: 42%</li>',
  '<span data-odd="19.23"></span> &raquo; <span data-odd="11.12"></span>',
  "<span>B's: 87% (13/15)</span>",
  '</td>',
  '<td class="table-main__odds" data-oid="OIDX"><button data-odd="6.17"></button></td>',
  '<td class="table-main__odds" data-oid="OID2"><button data-odd="1.18"></button></td>',
  '<td class="bestbet-odd" data-odd="17.00"><strong></strong>&nbsp;@</td>',
  '<td class="bestbet-logo" title="Unibet"></td>',
  '</tr>',
  '</tbody>'
].join('');

const rows = parseDropping(html);
if (rows.length !== 1) throw new Error('expected 1 row, got ' + rows.length);
const row = rows[0];

const expected = {
  country: 'Sweden',
  countryCode: 'se',
  league: 'Sweden: Allsvenskan Women',
  match: 'Uppsala W - Djurgarden W',
  selection: '1',
  odd1: 11.12,
  oddX: 6.17,
  odd2: 1.18,
  bestBetOdd: 17,
  bestBetBookmaker: 'Unibet'
};

for (const [key, value] of Object.entries(expected)) {
  if (row[key] !== value) {
    throw new Error(key + ' expected ' + value + ', got ' + row[key]);
  }
}

console.log('DROPPING_CARD_DATA=OK country=se odds=11.12/6.17/1.18 best=17@Unibet');
