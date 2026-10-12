import 'dart:convert';

Map<String, dynamic> quoteIdentityFor(Map<String, dynamic> row) => {
  for (final key in ['source_context_id', 'period', 'price_type'])
    if (row.containsKey(key)) key: row[key],
};
bool matchesQuoteIdentity(
  Map<String, dynamic> row,
  Map<String, dynamic>? identity,
) => identity == null || identity.entries.every((e) => row[e.key] == e.value);
String quoteIdentityQuery(Map<String, dynamic>? identity) => (identity ?? {})
    .entries
    .map(
      (e) =>
          '&' +
          Uri.encodeQueryComponent(e.key) +
          '=' +
          Uri.encodeQueryComponent(e.value?.toString() ?? 'unknown'),
    )
    .join();
String quoteIdentityKey(Map<String, dynamic> row) =>
    jsonEncode(quoteIdentityFor(row));
