import 'dart:async';

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
  testWidgets('Maçtan çıkıp dönünce gerçek indirme ilerlemesi ve kayıt işi kaybolmaz', (tester) async {
    var saves=0,downloads=0;
    final completion=Completer<http.Response>();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
      .setMockMethodCallHandler(channel,(call) async {
        saves++; return {'uri':'content://navigation/saved','directory':'Download','filename':'navigation.zip'};
      });
    addTearDown(()=>TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel,null));
    Widget screen() => MaterialApp(home:Scaffold(body:MatchExportPanel(
      eventId:'navigation-event',title:'Navigation test',
      downloadPackage:() async=>throw Exception('unexpected fallback'),
      downloadPackageWithTransfer:(progress,bytes) {
        downloads++; bytes(10,100); return completion.future;
      },
    )));
    await tester.pumpWidget(screen());
    await tester.tap(find.text('İndir'));
    await tester.pump();
    expect(tester.widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator)).value,0.1);
    await tester.pumpWidget(const SizedBox());
    expect(MatchExportPanel.hasActiveJob('navigation-event'),true);
    await tester.pumpWidget(screen());
    expect(find.textContaining('10%'),findsOneWidget);
    expect(tester.widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator)).value,0.1);
    completion.complete(http.Response.bytes([0x50,0x4b,0x03,0x04],200,
      headers:{'x-export-sha256':List.filled(64,'a').join()}));
    await tester.pumpAndSettle();
    expect(downloads,1);
    expect(saves,1);
    expect(find.textContaining('Download klasörüne kaydedildi'),findsOneWidget);
    expect(MatchExportPanel.hasActiveJob('navigation-event'),false);
  });

}
