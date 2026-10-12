
import 'package:flutter_test/flutter_test.dart';
import 'package:macradar/asian_quote_lines.dart';
import 'package:macradar/quote_identity_filters.dart';
void main() {
 test('unknown home signs split by exact source line without becoming home handicaps', () {
  final groups=asianQuoteSections([
   {'handicap_line':null,'source_line':0.25},
   {'handicap_line':null,'source_line':-0.75},
   {'handicap_line':null,'source_line':0.25},
   {'handicap_line':0.25,'source_line':0.25},
  ]);
  expect(groups.length,3);
  expect(groups.where((g)=>g.homeHandicap==null).every((g)=>g.homeHandicap==null),isTrue);
  expect(groups.singleWhere((g)=>g.key=='source:0.25').rows.length,2);
  expect(groups.first.homeHandicap,0.25);
 });
 test('source identity preserves explicit unknown and exchange price distinctions', () {
  final id=quoteIdentityFor({'source_context_id':'A','period':null,'price_type':'UNKNOWN'});
  expect(matchesQuoteIdentity({'source_context_id':'B','period':null,'price_type':'UNKNOWN'},id),isFalse);
  expect(matchesQuoteIdentity({'source_context_id':'A','period':null,'price_type':'BACK'},id),isFalse);
  expect(quoteIdentityQuery(id),contains('period=unknown'));
 });
}
