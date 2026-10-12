import 'package:flutter_test/flutter_test.dart';

import '../lib/quote_comparison_rules.dart';

void main() {
  final previous = <String, dynamic>{
    'event_id': 'e',
    'market': 'OU',
    'bookmaker_id': 'b',
    'source_context_id': 'context',
    'period': 'FULL_TIME_90',
    'price_type': 'SPORTSBOOK',
    'total_line': 2.75,
    'main_analysis_eligible': true,
    'captured_at': '2026-10-11T12:00:00Z',
  };
  final current = <String, dynamic>{
    ...previous,
    'captured_at': '2026-10-11T12:02:00Z',
  };
  test('same verified identity compares in observation order', () {
    expect(comparableQuoteRows(current, previous), isTrue);
    expect(comparableQuoteRows(previous, current), isFalse);
    expect(comparableQuoteRows(current, current), isFalse);
  });
  test('different context, quarter line and exchange type never compare', () {
    for (final change in <Map<String, dynamic>>[
      {'source_context_id': 'other'},
      {'total_line': 3.0},
      {'price_type': 'EXCHANGE_BACK'},
      {'event_id': 'other'},
      {'period': 'FIRST_HALF'},
    ]) {
      expect(comparableQuoteRows({...current, ...change}, previous), isFalse);
    }
  });
  test('unverified values and ambiguous Asian signs never compare', () {
    expect(
      comparableQuoteRows({
        ...current,
        'main_analysis_eligible': false,
      }, previous),
      isFalse,
    );
    expect(
      comparableQuoteRows(
        {...current, 'price_type': 'UNKNOWN'},
        {...previous, 'price_type': 'UNKNOWN'},
      ),
      isFalse,
    );
    expect(
      comparableQuoteRows(
        {...current, 'market': 'ASIAN', 'handicap_line': null},
        {...previous, 'market': 'ASIAN', 'handicap_line': null},
      ),
      isFalse,
    );
  });
}
