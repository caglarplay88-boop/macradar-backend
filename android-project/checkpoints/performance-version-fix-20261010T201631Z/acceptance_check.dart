
const int performanceEngineVersion = 85;
bool _hasPerformanceData(Map<String, dynamic> d) {
  final meta = d['meta'];
  final engineVersion = meta is Map
      ? int.tryParse(meta['engineVersion']?.toString() ?? '')
      : null;

  final normalizedCache = meta is Map &&
      meta['analysisNormalizationVersion'] == 'cached-unique-match-analysis-v1';
  return ((engineVersion != null &&
          engineVersion == performanceEngineVersion) || normalizedCache) &&
      d['evTakimi'] is Map &&
      d['deplasmanTakimi'] is Map;
}

void main() {
  void check(bool condition, String name) {
    if (!condition) throw StateError(name);
    print(name + ': GECTI');
  }
  Map<String,dynamic> data(int version) => {
    'meta': <String,dynamic>{'engineVersion':version},
    'evTakimi': <String,dynamic>{},
    'deplasmanTakimi': <String,dynamic>{}
  };
  check(_hasPerformanceData(data(85)), 'HAZIR_V85_KABULU');
  check(!_hasPerformanceData(data(84)), 'NORMALIZE_EDILMEMIS_ESKI_SURUM_REDDI');
  final normalized = data(84);
  (normalized['meta'] as Map)['analysisNormalizationVersion'] =
      'cached-unique-match-analysis-v1';
  check(_hasPerformanceData(normalized), 'DUZELTILMIS_KAYIT_KABULU');
  check(!_hasPerformanceData({'meta':{'engineVersion':85}}),
        'EKSIK_TAKIM_VERISI_REDDI');
}
