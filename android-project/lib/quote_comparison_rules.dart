bool comparableQuoteRows(
  Map<String, dynamic> current,
  Map<String, dynamic> previous,
) {
  if (current['main_analysis_eligible'] != true ||
      previous['main_analysis_eligible'] != true) {
    return false;
  }
  for (final field in [
    'event_id',
    'market',
    'bookmaker_id',
    'source_context_id',
    'period',
    'price_type',
  ]) {
    final value = current[field]?.toString();
    if (value == null ||
        value.isEmpty ||
        value == 'UNKNOWN' ||
        previous[field]?.toString() != value) {
      return false;
    }
  }
  final market = current['market'];
  final lineField = market == 'OU'
      ? 'total_line'
      : market == 'ASIAN'
      ? 'handicap_line'
      : null;
  if (lineField != null) {
    final currentLine = double.tryParse(current[lineField]?.toString() ?? '');
    final previousLine = double.tryParse(previous[lineField]?.toString() ?? '');
    if (currentLine == null ||
        !currentLine.isFinite ||
        previousLine == null ||
        currentLine != previousLine) {
      return false;
    }
  }
  final currentTime = DateTime.tryParse(
    current['captured_at']?.toString() ?? '',
  );
  final previousTime = DateTime.tryParse(
    previous['captured_at']?.toString() ?? '',
  );
  return currentTime != null &&
      previousTime != null &&
      previousTime.isBefore(currentTime);
}
