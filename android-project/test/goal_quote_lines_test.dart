import 'package:flutter_test/flutter_test.dart';
import 'package:macradar/goal_quote_lines.dart';
void main() {
  test('all source lines remain separate including quarter lines', () {
    final input = [{'total_line': 3.0}, {'total_line': 2.75},
      {'total_line': 2.5}, {'total_line': 0.5},
      {'total_line': 4.25}, {'total_line': 2.75}];
    expect(goalQuoteLines(input), [0.5, 2.5, 2.75, 3.0, 4.25]);
    expect(goalLineLabel(2.75), '2.75');expect(goalLineLabel(3.0), '3.0');
  });
  test('missing lines never become zero or invented default lines', () {
    expect(goalQuoteLines([]), isEmpty);
    expect(goalQuoteLines([{'total_line': 3.0}]), [3.0]);
    expect(goalQuoteLines([{'total_line': null}, {'total_line': double.nan}]), [null]);
    expect(goalLineLabel(null), 'Çizgi doğrulanmadı');
  });
}
