List<Map<String, dynamic>>? sourceOpeningDisplayRows(
  Map<String, dynamic> live,
  String market,
) {
  final source = live['source_openings'];
  if (source is! Map || source['handled'] != true) return null;
  final raw = source['records'];
  if (raw is! List) return <Map<String, dynamic>>[];
  const fields = <String, Map<String, String>>{
    '1X2': {'HOME': 'home_odd', 'DRAW': 'draw_odd', 'AWAY': 'away_odd'},
    'OU': {'UNDER': 'under_odd', 'OVER': 'over_odd'},
    'ASIAN': {'HOME': 'home_odd', 'AWAY': 'away_odd'},
    'KG': {'YES': 'yes_odd', 'NO': 'no_odd'},
  };
  final marketFields = fields[market];
  if (marketFields == null) throw ArgumentError.value(market, 'market');
  final rows = <Map<String, dynamic>>[];
  for (final item in raw.whereType<Map>()) {
    final record = Map<String, dynamic>.from(item);
    if (record['market'] != market ||
        record['record_origin'] != 'source_opening') continue;
    final selection = record['selection']?.toString();
    final field = marketFields[selection];
    if (field == null) continue;
    final row = <String, dynamic>{
      ...record,
      for (final key in marketFields.values) key: null,
      'id': record['record_id'],
      'raw_record_ids': [record['record_id']],
      'captured_at': record['source_timestamp'],
      '_captured_at_display_basis': 'PER_SELECTION_SOURCE_PRICE_TIME',
      'capture_type': 'opening',
      '_opening': true,
      '_source_opening_selection': selection,
      '_source_opening_selections_grouped': false,
      if (market == 'OU') 'total_line': record['line'],
      if (market == 'ASIAN') ...{
        'handicap_line': record['home_handicap'],
        'source_line': record['line'],
      },
    };
    final price = record['odds_decimal'];
    row[field] = price is num && price.isFinite && price > 1 ? price : null;
    rows.add(row);
  }
  return rows;
}

String sourceOpeningDisplayLabel(Map<String, dynamic> row, String time) {
  const labels = {
    'HOME': 'Ev', 'DRAW': 'Beraberlik', 'AWAY': 'Deplasman',
    'UNDER': 'Alt', 'OVER': 'Üst', 'YES': 'Var', 'NO': 'Yok',
  };
  final selection = row['_source_opening_selection'];
  final label = labels[selection];
  var shownTime = time;
  if (selection != null && row['source_timestamp'] == null) {
    final raw = row['source_timestamp_raw']?.toString().trim() ?? '';
    shownTime = raw.isEmpty
        ? 'Kaynak saati doğrulanmadı'
        : '$raw · Kaynak saati doğrulanmadı';
  }
  final heading = label == null ? 'KAYNAK AÇILIŞI' : 'KAYNAK AÇILIŞI · $label';
  final conflict = row['_opening_time_conflict'] == true ? '\nTarih çelişkisi' : '';
  return '$heading\n$shownTime$conflict';
}
