import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import '../lib/match_package_download.dart';

void main() {
  const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  final hash = List.filled(64, 'a').join();
  Map<String, dynamic> state(String status) => {
    'event_id': 'event123',
    'job_id': id,
    'status': status,
    'bytes': 4,
    'sha256': hash,
  };
  test('Hazırlama ve sorgulama aynı ZIP işini indirir', () async {
    final queries = <Map<String, String>>[];
    var polls = 0;
    final response = await downloadPreparedMatchPackage(
      baseUrl: 'https://example.test',
      eventId: 'event123',
      headers: {'x-test': 'kept'},
      wait: (_) async {},
      request: (uri, headers) async {
        expect(headers['x-test'], 'kept');
        queries.add(uri.queryParameters);
        if (uri.queryParameters['prepare'] == '1') {
          return http.Response(jsonEncode(state('QUEUED')), 202);
        }
        if (uri.queryParameters['status'] == '1') {
          polls++;
          return http.Response(
            jsonEncode(state(polls == 1 ? 'RUNNING' : 'READY')),
            200,
          );
        }
        return http.Response.bytes(
          [0x50, 0x4b, 0x03, 0x04],
          200,
          headers: {'x-export-sha256': hash},
        );
      },
    );
    expect(response.bodyBytes.length, 4);
    expect(queries.where((q) => q['prepare'] == '1').length, 1);
    expect(queries.last, {'job': id});
  });
  test('Yanlış maç ve paket hash kaydı reddedilir', () async {
    await expectLater(
      downloadPreparedMatchPackage(
        baseUrl: 'https://example.test',
        eventId: 'event123',
        headers: {},
        request: (uri, h) async => http.Response(
          jsonEncode({...state('READY'), 'event_id': 'other'}),
          202,
        ),
      ),
      throwsException,
    );
    await expectLater(
      downloadPreparedMatchPackage(
        baseUrl: 'https://example.test',
        eventId: 'event123',
        headers: {},
        request: (uri, h) async => uri.queryParameters['prepare'] == '1'
            ? http.Response(jsonEncode(state('READY')), 202)
            : http.Response.bytes(
                [0x50, 0x4b, 0x03, 0x04],
                200,
                headers: {'x-export-sha256': List.filled(64, 'b').join()},
              ),
      ),
      throwsException,
    );
  });
  test('Kesilen iş indirilmeye çalışılmaz', () async {
    var calls = 0;
    await expectLater(
      downloadPreparedMatchPackage(
        baseUrl: 'https://example.test',
        eventId: 'event123',
        headers: {},
        request: (uri, h) async {
          calls++;
          return http.Response(jsonEncode(state('INTERRUPTED')), 202);
        },
      ),
      throwsException,
    );
    expect(calls, 1);
  });
  test('Bekleme sınırı yeni iş başlatmadan uygulanır', () async {
    var now = DateTime.utc(2026, 10, 11);
    var calls = 0;
    await expectLater(
      downloadPreparedMatchPackage(
        baseUrl: 'https://example.test',
        eventId: 'event123',
        headers: {},
        maximumWait: const Duration(seconds: 3),
        clock: () => now,
        wait: (duration) async {
          now = now.add(duration);
        },
        request: (uri, h) async {
          calls++;
          return http.Response(jsonEncode(state('RUNNING')), 202);
        },
      ),
      throwsException,
    );
    expect(calls, 1);
  });
}
