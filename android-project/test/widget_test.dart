import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:macradar/main.dart';

void main() {
  testWidgets('MacRadar opens bulletin with its navigation options',
      (WidgetTester tester) async {
    await tester.pumpWidget(const MacRadarApp());

    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.title, 'MacRadar');
    expect(find.byType(Home), findsOneWidget);
    expect(find.byType(BulletinPage), findsOneWidget);
    expect(find.text('Bülten'), findsWidgets);
    expect(find.text('Takip'), findsWidgets);
    expect(find.text('Düşüş'), findsWidgets);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump();
  });
}
