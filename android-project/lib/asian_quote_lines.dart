List<double?> asianQuoteLines(Iterable<Map<String, dynamic>> rows) {
  final known = <double>{};
  var unknown = false;
  for (final row in rows) {
    final value = double.tryParse(row['handicap_line']?.toString() ?? '');
    if (value == null || !value.isFinite) {
      unknown = true;
    } else {
      known.add(value);
    }
  }
  final sorted = known.toList()..sort();
  return <double?>[...sorted, if (unknown) null];
}

class AsianQuoteSection {
  final String key;
  final double? homeHandicap;
  final double? sourceLine;
  final List<Map<String, dynamic>> rows;
  AsianQuoteSection(this.key, this.homeHandicap, this.sourceLine, this.rows);
}

List<AsianQuoteSection> asianQuoteSections(
  Iterable<Map<String, dynamic>> rows,
) {
  final groups = <String, AsianQuoteSection>{};
  double? finite(dynamic raw) {
    final n = double.tryParse(raw?.toString() ?? '');
    return n != null && n.isFinite ? n : null;
  }

  for (final row in rows) {
    final home = finite(row['handicap_line']);
    final source = finite(row['source_line']);
    final key = home != null
        ? 'home:$home'
        : source != null
        ? 'source:$source'
        : 'unknown:' +
              (row['quote_group_id'] ?? row['id'] ?? groups.length).toString();
    final group = groups.putIfAbsent(
      key,
      () => AsianQuoteSection(key, home, source, []),
    );
    group.rows.add(row);
  }
  return groups.values.toList()..sort((a, b) {
    final kind = (a.homeHandicap == null ? 1 : 0).compareTo(
      b.homeHandicap == null ? 1 : 0,
    );
    if (kind != 0) return kind;
    final av = a.homeHandicap ?? a.sourceLine;
    final bv = b.homeHandicap ?? b.sourceLine;
    if (av == null) return bv == null ? a.key.compareTo(b.key) : 1;
    if (bv == null) return -1;
    return av.compareTo(bv);
  });
}
