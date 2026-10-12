void _markSourceOpeningChronology(
  List<Map<String, dynamic>> openings,
  List<Map<String, dynamic>> history,
) {
  DateTime? timeOf(Map<String, dynamic> row) =>
      DateTime.tryParse(row['captured_at']?.toString() ?? '');
  for (final opening in openings) {
    final openingTime = timeOf(opening);
    opening['_opening_time_conflict'] = openingTime != null &&
        history.any((row) {
          final observed = timeOf(row);
          return observed != null && observed.isBefore(openingTime);
        });
  }
}

String _sourceOpeningLabel(Map<String, dynamic> row, String time) =>
    row['_opening_time_conflict'] == true
        ? 'KAYNAK AÇILIŞI\n$time\nTarih çelişkisi'
        : 'KAYNAK AÇILIŞI\n$time';


void main() {
  final opening = <String,dynamic>{'captured_at':'2026-09-21T12:29:00Z'};
  _markSourceOpeningChronology([opening],[
    {'captured_at':'2026-09-17T14:10:00Z'}
  ]);
  if (opening['_opening_time_conflict'] != true) throw StateError('earlier observation missed');
  if (!_sourceOpeningLabel(opening,'21/09 15:29').contains('Tarih çelişkisi')) throw StateError('missing label');
  _markSourceOpeningChronology([opening],[{'captured_at':'2026-09-22T14:10:00Z'}]);
  if (opening['_opening_time_conflict'] != false) throw StateError('false conflict');
  _markSourceOpeningChronology([opening],[{'captured_at':'invalid'}]);
  if (opening['_opening_time_conflict'] != false) throw StateError('invalid date invented');
  print('ACILIS_TARIH_DAVRANISI: GECTI');
}
