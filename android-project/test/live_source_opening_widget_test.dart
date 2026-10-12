
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:macradar/main.dart';
import 'package:macradar/quote_identity_filters.dart';

void main() {
 final fixture=jsonDecode(File('test/fixtures/live-source-opening-ui.json').readAsStringSync()) as Map;
 for(final market in ['1X2','OU','ASIAN','KG']) {
  testWidgets('real $market source openings render while history request is pending', (tester) async {
   tester.view.physicalSize=const Size(1100,1900);
   tester.view.devicePixelRatio=1;
   addTearDown(tester.view.resetPhysicalSize);
   addTearDown(tester.view.resetDevicePixelRatio);
   final data=Map<String,dynamic>.from(fixture['markets'][market]);
   final current=(data['current']['rows'] as List).cast<Map>();
   final openings=(data['source_openings']['records'] as List).cast<Map>();
   final row=Map<String,dynamic>.from(current.firstWhere((r)=>openings.any((o)=>
      o['bookmaker_id'].toString()==r['bookmaker_id'].toString() &&
      matchesQuoteIdentity(Map<String,dynamic>.from(o),quoteIdentityFor(Map<String,dynamic>.from(r))) &&
      (market=='OU' ? o['line']==r['total_line'] :
       market=='ASIAN' ? o['line']==r['source_line'] : true))));
   final gate=Completer<http.Response>();
   final previous=api.client;
   api.client=MockClient((req) async {
    if(req.url.path.endsWith('/history')) {
      expect(req.url.queryParameters['source_context_id'],row['source_context_id']);
      if(market=='ASIAN') {
       expect(req.url.queryParameters.containsKey('source_line'),isTrue);
       expect(req.url.queryParameters.containsKey('line'),isFalse);
      }
      return gate.future;
    }
    return http.Response(jsonEncode(data),200,headers:{'content-type':'application/json'});
   });
   final id=quoteIdentityFor(row);
   final book=row['bookmaker_name'].toString();
   final bid=row['bookmaker_id'].toString();
   late Widget screen;
   if(market=='1X2') screen=BookmakerOddsDetail(eventId:'pjTVIO7M',matchTitle:'Central Norte - Ferro',bookmakerName:book,bookmakerId:bid,quoteIdentity:id);
   if(market=='OU') screen=BookmakerOverUnderDetail(eventId:'pjTVIO7M',matchTitle:'Central Norte - Ferro',bookmakerName:book,bookmakerId:bid,totalLine:(row['total_line'] as num).toDouble(),quoteIdentity:id);
   if(market=='ASIAN') screen=BookmakerAsianDetail(eventId:'pjTVIO7M',matchTitle:'Central Norte - Ferro',bookmakerName:book,bookmakerId:bid,handicapLine:null,sourceLine:(row['source_line'] as num).toDouble(),quoteIdentity:id);
   if(market=='KG') screen=BookmakerKgDetail(eventId:'pjTVIO7M',matchTitle:'Central Norte - Ferro',bookmakerName:book,bookmakerId:bid,quoteIdentity:id);
   await tester.pumpWidget(MaterialApp(home:screen));
   for(var i=0;i<8;i++) await tester.pump(const Duration(milliseconds:50));
   expect(find.textContaining('KAYNAK AÇILIŞI'),findsWidgets);
   expect(find.text('Açılış yok'),findsNothing);
   expect(gate.isCompleted,isFalse);
   expect(tester.takeException(),isNull);
   gate.complete(http.Response(jsonEncode({'rows':[],'has_next':false}),200));
   await tester.pump(const Duration(milliseconds:100));
   expect(find.textContaining('KAYNAK AÇILIŞI'),findsWidgets);
   await tester.pumpWidget(const SizedBox.shrink());
   api.client.close();api.client=previous;
  });
 }
 testWidgets('match market list shows every goal line and current odds before history completes', (tester) async {
  tester.view.physicalSize=const Size(1100,2400);
  tester.view.devicePixelRatio=1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final gates=<Completer<http.Response>>[];
  final previous=api.client;
  api.client=MockClient((req) async {
   if(req.url.path.endsWith('/history')) {
    final gate=Completer<http.Response>();gates.add(gate);return gate.future;
   }
   final markets=fixture['markets'] as Map;
   final key=req.url.path.endsWith('/over-under')?'OU':req.url.path.endsWith('/asian')?'ASIAN':req.url.path.endsWith('/kg')?'KG':'1X2';
   return http.Response(jsonEncode({...Map<String,dynamic>.from(markets[key]),'tracking_enabled':false}),200);
  });
  await tester.pumpWidget(const MaterialApp(home:MatchDetail(eventId:'pjTVIO7M',title:'Central Norte - Ferro')));
  for(var i=0;i<8;i++) await tester.pump(const Duration(milliseconds:50));
  expect(find.text('1X2 oranı bulunamadı.'),findsNothing);
  expect(find.text('1xbet'),findsWidgets);
  for(final gate in gates) {if(!gate.isCompleted)gate.complete(http.Response('{"rows":[],"has_next":false}',200));}
  await tester.pump(const Duration(milliseconds:100));
  await tester.tap(find.text('Alt/Üst').first);
  for(var i=0;i<8;i++) await tester.pump(const Duration(milliseconds:50));
  final sourceRows=fixture['markets']['OU']['current']['rows'] as List;
  final lines=sourceRows.map((r)=>r['total_line']).whereType<num>().toSet();
  expect(lines.any((v)=>v!=1.5&&v!=2.5),isTrue);
  expect(find.text('0.5 Alt/Üst'),findsWidgets);
  expect(gates.last.isCompleted,isFalse);
  for(final gate in gates) {if(!gate.isCompleted)gate.complete(http.Response('{"rows":[],"has_next":false}',200));}
  await tester.pump(const Duration(milliseconds:100));
  await tester.tap(find.text('Asian').first);
  for(var i=0;i<8;i++) await tester.pump(const Duration(milliseconds:50));
  expect(find.text('Asian: takım ve işaret doğrulanmadı'),findsNothing);
  expect(find.textContaining('Kaynak çizgisi'),findsWidgets);
  for(final gate in gates) {if(!gate.isCompleted)gate.complete(http.Response('{"rows":[],"has_next":false}',200));}
  await tester.pump(const Duration(milliseconds:100));
  await tester.pumpWidget(const SizedBox.shrink());
  api.client.close();api.client=previous;
 });

}
