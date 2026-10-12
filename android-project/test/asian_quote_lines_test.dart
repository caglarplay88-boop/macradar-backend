import 'package:flutter_test/flutter_test.dart';

import '../lib/asian_quote_lines.dart';

void main() {
  test('unknown signed handicap remains visible beside verified zero', () {
    final rows = <Map<String, dynamic>>[
      {'handicap_line': null, 'source_line': -0.25},
      {'handicap_line': 0},
      {'handicap_line': 0.25},
      {'handicap_line': -0.25},
      {'handicap_line': 'invalid'},
    ];
    expect(asianQuoteLines(rows), <double?>[-0.25, 0, 0.25, null]);
    expect(rows.first['handicap_line'], isNull);
    expect(rows.first['source_line'], -0.25);
  });
  test('empty data creates no unknown line', () {
    expect(asianQuoteLines(<Map<String, dynamic>>[]), isEmpty);
  });
  test('missing and nonfinite lines never become zero', () {
    expect(
      asianQuoteLines(<Map<String, dynamic>>[
        {},
        {'handicap_line': double.nan},
        {'handicap_line': double.infinity},
      ]),
      <double?>[null],
    );
  });
}
