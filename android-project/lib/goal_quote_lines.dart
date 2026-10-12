List<double?> goalQuoteLines(Iterable<Map<String, dynamic>> rows) {
  final lines = <double>{};
  var unknown = false;
  for (final row in rows) {
    final line = double.tryParse(row['total_line']?.toString() ?? '');
    if (line == null || !line.isFinite || line < 0) {
      unknown = true;
    } else {
      lines.add(line);
    }
  }
  final sorted = lines.toList()..sort();
  return <double?>[...sorted, if (unknown) null];
}
String goalLineLabel(double? line) => line == null || !line.isFinite
    ? 'Çizgi doğrulanmadı' : line.toString();
