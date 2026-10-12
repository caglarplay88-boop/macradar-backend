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
}) async {
  if (!RegExp(r'^[A-Za-z0-9_-]{1,80}$').hasMatch(eventId)) {
    throw Exception('Geçersiz maç kimliği.');
  }
  final get =
      request ??
      (Uri uri, Map<String, String> h) =>
          http.get(uri, headers: h).timeout(const Duration(seconds: 60));
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

  final prepared = decodeJob(
    await get(endpoint.replace(queryParameters: {'prepare': '1'}), headers),
  );
  final dynamic id = prepared['job_id'];
  if (id is! String || !RegExp(r'^[a-f0-9-]{36}$').hasMatch(id)) {
    throw Exception('Paket işi kimliği geçersiz.');
  }
  var state = prepared;
  while (true) {
    if (state['job_id'] != id) {
      throw Exception('Paket işi kimliği değişti.');
    }
    final status = state['status'];
    if (status == 'FAILED' || status == 'INTERRUPTED') {
      throw Exception('Paket hazırlanamadı. Hazırlama işi durdu.');
    }
    if (status == 'READY') {
      final response = await get(
        endpoint.replace(queryParameters: {'job': id}),
        headers,
      );
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
    if (now().difference(started) >= maximumWait) {
      throw TimeoutException('Paket hazırlama bekleme süresi doldu.');
    }
    await pause(const Duration(seconds: 3));
    if (now().difference(started) >= maximumWait) {
      throw TimeoutException('Paket hazırlama bekleme süresi doldu.');
    }
    state = decodeJob(
      await get(
        endpoint.replace(queryParameters: {'job': id, 'status': '1'}),
        headers,
      ),
    );
  }
}
