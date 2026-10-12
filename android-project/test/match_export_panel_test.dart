import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import '../lib/match_export_panel.dart';

void main() {
  const channel = MethodChannel('com.macradar.macradar/match_files');

  testWidgets('Başarısız yenilemede kayıtlı veri ve tarama saati görünür', (
    tester,
  ) async {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          expect(call.method, 'savePackage');
          return {'uri': 'content://test-only/package', 'directory': 'Download', 'filename': 'test.zip'};
        });
    addTearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    });
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: MatchExportPanel(
            eventId: 'event123',
            title: 'Test maçı',
            downloadPackage: () async => http.Response.bytes(
              [0x50, 0x4b, 0x03, 0x04],
              200,
              headers: {
                'x-export-sha256': List.filled(64, 'a').join(),
                'x-odds-refresh-success': 'false',
                'x-odds-last-success-at': '2026-10-12T14:00:00Z',
                'x-odds-source-verified': 'false',
              },
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('İndir'));
    await tester.pumpAndSettle();
    expect(find.textContaining('kayıtlı veri indirildi'), findsOneWidget);
    expect(find.textContaining('Download klasörüne kaydedildi'), findsOneWidget);
    expect(find.textContaining('12.10.2026 17:00 (Türkiye)'), findsOneWidget);
    expect(find.textContaining('doğrulanamayan alanları'), findsOneWidget);
  });
}
