import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

/// A match export belongs to the app session, never to a mounted screen.
class MatchExportSession extends ChangeNotifier {
  static final Map<String, MatchExportSession> _sessions = {};
  static MatchExportSession forEvent(String eventId) =>
      _sessions.putIfAbsent(eventId, () => MatchExportSession._(eventId));
  static bool isRunning(String eventId) => _sessions[eventId]?.busy == true;
  MatchExportSession._(this.eventId);
  final String eventId;
  static const _files = MethodChannel('com.macradar.macradar/match_files');
  bool busy = false;
  String message = '';
  String phase = 'idle';
  String? savedUri;
  int receivedBytes = 0;
  int totalBytes = 0;
  double get downloadFraction => totalBytes > 0
      ? (receivedBytes / totalBytes).clamp(0.0, 1.0).toDouble() : 0;
  String _dataMessage = '';
  String _saveMessage = 'Maç dosyası seçtiğin klasöre kaydedildi.';

  void progress(String text) {
    message = text;
    phase = text.contains('telefona indiriliyor') ? 'download' : 'prepare';
    notifyListeners();
  }
  void bytesReceived(int received, int total) {
    phase = 'download'; receivedBytes = received; totalBytes = total;
    final percent = total > 0 ? ' · ${(downloadFraction * 100).floor()}%' : '';
    message = 'Dosya indiriliyor: ${(received / 1048576).toStringAsFixed(2)} MB'
        '${total > 0 ? " / ${(total / 1048576).toStringAsFixed(2)} MB" : ""}$percent';
    notifyListeners();
  }
  String _collectionMessage(http.Response response) {
    final raw = response.headers['x-odds-last-success-at'];
    final date = raw == null ? null : DateTime.tryParse(raw);
    final parts = <String>[];
    if (response.headers['x-odds-refresh-success'] != 'true') {
      parts.add('Kaynak yenilemesi tamamlanmadı; kayıtlı veri indirildi. Veri saati ve kapsamı dosyada belirtilir.');
    }
    if (date == null) {
      parts.add('Son başarılı tarama zamanı bulunmuyor.');
    } else {
      final turkey = date.toUtc().add(const Duration(hours: 3));
      String two(int value) => value.toString().padLeft(2, '0');
      parts.add(
        'Son başarılı tarama: ${two(turkey.day)}.${two(turkey.month)}.'
        '${turkey.year} ${two(turkey.hour)}:${two(turkey.minute)} (Türkiye).',
      );
    }
    if (response.headers['x-odds-source-verified'] != 'true') {
      parts.add('Kaynağın doğrulanamayan alanları dosyada işaretlidir.');
    }
    return parts.join('\n');
  }

  Future<void> start({required bool share,
    required Future<http.Response> Function(void Function(String), void Function(int, int)) download,
    Future<void> Function()? onPackageSaved,
  }) async {
    if (busy) return;
    busy = true; phase = 'prepare'; receivedBytes = 0; totalBytes = 0;
    message = 'Güncel veriler kontrol ediliyor…'; notifyListeners();
    try {
      String? uri = share ? savedUri : null;
      if (uri == null) {
        final response = await download(progress, bytesReceived);
        if (response.statusCode != 200) throw Exception('Maç dosyası alınamadı (HTTP ${response.statusCode}).');
        final bytes = response.bodyBytes;
        if (bytes.length < 4 || bytes.length > 128 * 1024 * 1024 ||
            bytes[0] != 0x50 || bytes[1] != 0x4b || bytes[2] != 0x03 || bytes[3] != 0x04) {
          throw Exception('İndirilen dosya geçerli bir ZIP paketi değil.');
        }
        final hash = response.headers['x-export-sha256'];
        if (hash == null || !RegExp(r'^[a-f0-9]{64}$').hasMatch(hash)) {
          throw Exception('Dosya bütünlük bilgisi eksik.');
        }
        phase = 'save'; receivedBytes = bytes.length; totalBytes = bytes.length;
        message = 'İndirme tamamlandı; Download klasörüne kaydediliyor…'; notifyListeners();
        final result = await _files.invokeMapMethod<String, dynamic>('savePackage', {
          'bytes': bytes, 'sha256': hash,
          'filename': 'MacRadar-$eventId-${DateTime.now().microsecondsSinceEpoch}.zip',
        });
        uri = result?['uri'] as String?;
        if (uri == null) { message = 'Kaydetme iptal edildi.'; return; }
        savedUri = uri;
        _saveMessage = result?['directory'] == 'Download'
            ? 'Maç dosyası Download klasörüne kaydedildi.\n${result?["filename"] ?? ""}'
            : 'Maç dosyası seçtiğin klasöre kaydedildi.';
        _dataMessage = _collectionMessage(response);
        try { await onPackageSaved?.call(); } catch (_) { }
      }
      if (share) await _files.invokeMethod<void>('sharePackage', {'uri': uri});
      phase = 'done';
      message = [share ? 'Dosya hazır. Açılan menüden paylaşabilirsin.' : _saveMessage,
        _dataMessage].where((part) => part.isNotEmpty).join('\n');
    } on PlatformException catch (error) {
      phase = 'error'; message = error.message ?? 'Dosya işlemi tamamlanamadı.';
    } catch (error) {
      phase = 'error'; message = error.toString();
    } finally {
      busy = false; notifyListeners();
    }
  }
}
