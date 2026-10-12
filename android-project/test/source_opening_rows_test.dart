import 'package:flutter_test/flutter_test.dart';
import 'package:macradar/source_opening_rows.dart';

Map<String, dynamic> live(List<Map<String, dynamic>> records) =>
    {'source_openings': {'handled': true, 'records': records}};

Map<String, dynamic> record(String market, String selection, String id) => {
  'record_id': id, 'record_origin': 'source_opening',
  'market': market, 'selection': selection, 'bookmaker_id': '417',
  'source_context_id': 'ctx', 'raw_evidence_ref': 'evidence-$id',
  'odds_decimal': 2.2, 'source_timestamp': '2026-10-10T08:00:00Z',
  'observed_at': '2026-10-11T12:00:00Z',
};

void main() {
  test('side openings retain different times and never become a quote', () {
    final home = record('1X2', 'HOME', 'h');
    final away = {...record('1X2', 'AWAY', 'a'),
      'source_timestamp': '2026-10-10T09:00:00Z'};
    final rows = sourceOpeningDisplayRows(live([home, away]), '1X2')!;
    expect(rows, hasLength(2));
    expect(rows[0]['home_odd'], 2.2);
    expect(rows[0]['draw_odd'], isNull);
    expect(rows[0]['away_odd'], isNull);
    expect(rows[1]['home_odd'], isNull);
    expect(rows[1]['away_odd'], 2.2);
    expect(rows[0]['captured_at'], home['source_timestamp']);
    expect(rows[1]['captured_at'], away['source_timestamp']);
    expect(rows[0]['raw_record_ids'], ['h']);
    expect(rows[0]['raw_evidence_ref'], 'evidence-h');
    expect(rows[0]['_source_opening_selections_grouped'], false);
    expect(rows[0]['quote_group_id'], isNull);
  });
  test('unverified source time never uses receipt time', () {
    final raw = {...record('KG', 'YES', 'y'),
      'source_timestamp': null, 'source_timestamp_raw': '10.10.'};
    final row = sourceOpeningDisplayRows(live([raw]), 'KG')!.single;
    expect(row['captured_at'], isNull);
    expect(row['no_odd'], isNull);
    expect(sourceOpeningDisplayLabel(row, 'ignored'),
      contains('Kaynak saati doğrulanmadı'));
    expect(sourceOpeningDisplayLabel(row, 'ignored'), contains('10.10.'));
    expect(sourceOpeningDisplayLabel(row, 'ignored'), isNot(contains('ignored')));
  });
  test('quarter goal line remains exact', () {
    final raw = {...record('OU', 'UNDER', 'u'), 'line': 2.75};
    final row = sourceOpeningDisplayRows(live([raw]), 'OU')!.single;
    expect(row['total_line'], 2.75);
    expect(row['under_odd'], 2.2);
    expect(row['over_odd'], isNull);
  });
  test('Asian source line never supplies a verified home sign', () {
    final raw = {...record('ASIAN', 'HOME', 'ah'),
      'line': -0.75, 'home_handicap': null, 'away_handicap': null};
    final row = sourceOpeningDisplayRows(live([raw]), 'ASIAN')!.single;
    expect(row['source_line'], -0.75);
    expect(row['handicap_line'], isNull);
    expect(row['away_odd'], isNull);
  });
  test('legacy fallback differs from initialized source with no openings', () {
    expect(sourceOpeningDisplayRows({}, '1X2'), isNull);
    expect(sourceOpeningDisplayRows(live([]), '1X2'), isEmpty);
    expect(sourceOpeningDisplayRows(live([
      {...record('1X2', 'HOME', 'c'), 'record_origin': 'scraper_observation'}
    ]), '1X2'), isEmpty);
  });
  test('Açılış kartı tarafları bir arada gösterir, zamanları ve ham kayıtları değiştirmez', () {
    final home = record('1X2','HOME','compact-home');
    final away = {...record('1X2','AWAY','compact-away'),
      'source_timestamp':'2026-10-10T09:00:00Z'};
    final sides = sourceOpeningDisplayRows(live([home,away]),'1X2')!;
    final cards = compactSourceOpeningCards(sides);
    expect(cards,hasLength(1));
    expect(cards.single['home_odd'],2.2);
    expect(cards.single['away_odd'],2.2);
    expect(cards.single['draw_odd'],isNull);
    expect(cards.single['captured_at'],isNull);
    expect(cards.single['quote_group_id'],isNull);
    expect(cards.single['_source_opening_selections_grouped'],false);
    expect(cards.single['raw_record_ids'],['compact-home','compact-away']);
    final label=sourceOpeningDisplayLabel(cards.single,'ignored');
    expect(label,contains('11:00'));
    expect(label,contains('12:00'));
    expect(sides[0]['captured_at'],home['source_timestamp']);
    expect(sides[1]['captured_at'],away['source_timestamp']);
  });
  test('Açılış kartları farklı bağlamları ve çizgileri birleştirmez', () {
    final sides=sourceOpeningDisplayRows(live([
      {...record('OU','UNDER','compact-u'), 'line':2.5},
      {...record('OU','OVER','compact-o'), 'line':2.75},
      {...record('OU','OVER','compact-other'), 'line':2.5, 'source_context_id':'other'},
    ]),'OU')!;
    expect(compactSourceOpeningCards(sides),hasLength(3));
  });

}
