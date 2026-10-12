import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

Future<http.Response> downloadPreparedMatchPackage({
  required String baseUrl,
  required String eventId,
  required Map<String, String> headers,
  Future<http.Response> Function(Uri, Map<String, String>)? request,
  Future<void> Function(Duration)? wait,
  DateTime Function()? clock,
  Duration maximumWait = const Duration(minutes: 30),
  Future<String?> Function()? readPendingJob,
  Future<void> Function(String?)? savePendingJob,
  void Function(String)? onProgress,
}) async {
  if (!RegExp(r'^[A-Za-z0-9_-]{1,80}$').hasMatch(eventId)) {
    throw Exception('Geçersiz maç kimliği.');
  }
  final get =
      request ??
      (Uri uri, Map<String, String> h) =>
          http.get(uri, headers: h).timeout(Duration(
            minutes: uri.queryParameters.containsKey("status") || uri.queryParameters.containsKey("prepare") ? 1 : 5));
  final pause = wait ?? (Duration duration) => Future<void>.delayed(duration);
  final now = clock ?? DateTime.now;
  final endpoint = Uri.parse(
    '$baseUrl/api/matches/${Uri.encodeComponent(eventId)}/export',
  );
  final started = now();

  Map<String, dynamic> decodeJob(http.Response response) {
    if (response.statusCode != 200 && response.statusCode != 202) {
      throw Exception(
        'Paket hazırlama isteği başarısız (HTTP ${response.statusCode}).',
      );
    }
    final dynamic data = jsonDecode(utf8.decode(response.bodyBytes));
    if (data is! Map<String, dynamic> || data['event_id'] != eventId) {
      throw Exception('Paket yanıtındaki maç kimliği uyuşmuyor.');
    }
    return data;
  }

  Future<http.Response> fetch(Uri uri) async {
    for (var attempt = 0; ; attempt++) {
      try {
        final response = await get(uri, headers);
        if ([429, 502, 503, 504].contains(response.statusCode) && attempt < 2) {
          onProgress?.call('Bağlantı gecikti; aynı paket işi yeniden kontrol ediliyor…');
          await pause(Duration(seconds: 2 * (attempt + 1)));
          continue;
        }
        return response;
      } catch (_) {
        if (attempt >= 2) rethrow;
        onProgress?.call('Bağlantı kesildi; aynı paket işi yeniden kontrol ediliyor…');
        await pause(Duration(seconds: 2 * (attempt + 1)));
      }
    }
  }
  var pending = await readPendingJob?.call();
  Map<String, dynamic>? prepared;
  if (pending != null && RegExp(r'^[a-f0-9-]{36}$').hasMatch(pending)) {
    onProgress?.call('Önceki paket işi kontrol ediliyor…');
    final response = await fetch(endpoint.replace(queryParameters: {'job': pending, 'status': '1'}));
    if (response.statusCode == 404) {
      await savePendingJob?.call(null);
    } else {
      prepared = decodeJob(response);
      if (['FAILED', 'INTERRUPTED'].contains(prepared['status'])) {
        await savePendingJob?.call(null);
        prepared = null;
      }
    }
  }
  prepared ??= decodeJob(
    await fetch(endpoint.replace(queryParameters: {'prepare': '1'})),
  );
  final dynamic id = prepared['job_id'];
  if (id is! String || !RegExp(r'^[a-f0-9-]{36}$').hasMatch(id)) {
    throw Exception('Paket işi kimliği geçersiz.');
  }
  await savePendingJob?.call(id);
  var state = prepared;
  while (true) {
    if (state['job_id'] != id) {
      throw Exception('Paket işi kimliği değişti.');
    }
    final status = state['status'];
    if (status == 'FAILED' || status == 'INTERRUPTED') {
      await savePendingJob?.call(null);
      throw Exception('Paket hazırlanamadı. Hazırlama işi durdu.');
    }
    if (status == 'READY') {
      onProgress?.call('Paket hazır; telefona indiriliyor…');
      final response = await fetch(endpoint.replace(queryParameters: {'job': id}));
      if (response.statusCode != 200) {
        throw Exception('Hazır paket alınamadı (HTTP ${response.statusCode}).');
      }
      final expectedHash = state['sha256'];
      final expectedBytes = state['bytes'];
      if (expectedHash is! String ||
          !RegExp(r'^[a-f0-9]{64}$').hasMatch(expectedHash) ||
          expectedBytes is! int ||
          expectedBytes < 4 ||
          response.headers['x-export-sha256'] != expectedHash ||
          response.bodyBytes.length != expectedBytes) {
        throw Exception('İndirilen paket hazırlama kaydıyla uyuşmuyor.');
      }
      return response;
    }
    if (status != 'QUEUED' && status != 'RUNNING') {
      throw Exception('Paket hazırlama durumu geçersiz.');
    }
    final elapsed = now().difference(started).inSeconds;
    final phase = state['phase'];
    onProgress?.call(status == 'QUEUED'
        ? 'Toplama sırası bekleniyor… ($elapsed sn)'
        : phase == 'BUILDING_PACKAGE'
            ? 'Veriler toplandı; ZIP paketi hazırlanıyor… ($elapsed sn)'
            : 'Kaynak fiyatları ve erişilebilir açılışlar toplanıyor… ($elapsed sn)\nİlk toplama birkaç dakika sürebilir.');
    if (now().difference(started) >= maximumWait) {
      throw TimeoutException('Paket hazırlama bekleme süresi doldu.');
    }
    await pause(const Duration(seconds: 3));
    if (now().difference(started) >= maximumWait) {
      throw TimeoutException('Paket hazırlama bekleme süresi doldu.');
    }
    state = decodeJob(
      await fetch(endpoint.replace(queryParameters: {'job': id, 'status': '1'})),
    );
  }
}
