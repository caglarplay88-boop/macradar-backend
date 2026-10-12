import 'dart:convert';

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
  if (row['_opening_display_only'] == true) {
    final sides = (row['_opening_sides'] as List).cast<Map<String, dynamic>>();
    const names = {'HOME':'1','DRAW':'X','AWAY':'2','UNDER':'Alt','OVER':'Üst','YES':'Var','NO':'Yok'};
    String label(Map<String,dynamic> side) {
      final verified = side['source_timestamp'];
      if (verified != null) {
        final date = DateTime.tryParse(verified.toString());
        if (date != null) {
          final tr = date.toUtc().add(const Duration(hours:3));
          String two(int n) => n.toString().padLeft(2,'0');
          return '${two(tr.day)}.${two(tr.month)}.${tr.year} ${two(tr.hour)}:${two(tr.minute)}';
        }
      }
      return side['source_timestamp_raw']?.toString().trim().isNotEmpty == true
          ? side['source_timestamp_raw'].toString() : 'Kaynak zamanı yok';
    }
    final times = sides.map(label).toList();
    final common = times.toSet().length == 1;
    final uncertain = sides.any((s)=>s['source_timestamp']==null);
    return 'KAYNAK AÇILIŞI\n${common ? times.first : sides.asMap().entries.map((e)=>"${names[e.value['_source_opening_selection']] ?? e.value['_source_opening_selection']}: ${times[e.key]}").join("\n")}'
        '${uncertain ? "\nKaynak tarihi; UTC dönüşümü doğrulanmadı" : "\nTarafların kaynak zamanları"}';
  }

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

/// Presentation only. Raw side records and graph inputs stay separate.
List<Map<String, dynamic>> compactSourceOpeningCards(List<Map<String,dynamic>> rows) {
  final groups = <String,List<Map<String,dynamic>>>{};
  final passthrough = <Map<String,dynamic>>[];
  for (final row in rows) {
    if (row['_source_opening_selection'] == null) { passthrough.add(row); continue; }
    var key = jsonEncode([row['event_id'],row['source'],row['bookmaker_id'] ?? row['bookmaker_key'] ?? row['bookmaker_name'],
      row['source_context_id'],row['market'],row['period'],row['price_type'],
      row['line'],row['total_line'],row['source_line'],row['handicap_line']]);
    if ((groups[key] ?? []).any((r)=>r['_source_opening_selection']==row['_source_opening_selection'])) {
      key += '|${row['record_id']}';
    }
    groups.putIfAbsent(key,()=>[]).add(row);
  }
  return [...passthrough, ...groups.values.map((sides) {
    final card = <String,dynamic>{...sides.first,
      'captured_at':null,'quote_group_id':null,'_opening_display_only':true,
      '_opening_sides':sides,
      '_source_opening_selections_grouped':false,
      'raw_record_ids':sides.expand((s)=>(s['raw_record_ids'] as List?) ?? []).toList(),
    };
    for (final side in sides) {
      for (final field in ['home_odd','draw_odd','away_odd','under_odd','over_odd','yes_odd','no_odd']) {
        if (side[field] != null) card[field] = side[field];
      }
    }
    return card;
  })];
}
