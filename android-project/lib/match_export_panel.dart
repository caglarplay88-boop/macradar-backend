import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;

class MatchExportPanel extends StatefulWidget {
  final String eventId;
  final String title;
  final Future<http.Response> Function() downloadPackage;
  final Future<http.Response> Function(void Function(String))? downloadPackageWithProgress;
  final Future<void> Function()? onPackageSaved;
  const MatchExportPanel({
    super.key,
    required this.eventId,
    required this.title,
    required this.downloadPackage,
    this.downloadPackageWithProgress,
    this.onPackageSaved,
  });

  @override
  State<MatchExportPanel> createState() => _MatchExportPanelState();
}

class _MatchExportPanelState extends State<MatchExportPanel> {
  static const _files = MethodChannel('com.macradar.macradar/match_files');
  bool _busy = false;
  String? _savedUri;
  String _message = '';
  String _dataMessage = '';
  String _saveMessage = 'Maç dosyası seçtiğin klasöre kaydedildi.';

  void _progress(String message) {
    if (mounted) setState(() => _message = message);
  }

  String _collectionMessage(http.Response response) {
    final raw = response.headers['x-odds-last-success-at'];
    final date = raw == null ? null : DateTime.tryParse(raw);
    final parts = <String>[];
    if (response.headers['x-odds-refresh-success'] != 'true') {
      parts.add('Son yenileme başarılı olmadı; kayıtlı veri indirildi.');
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

  Future<void> _export({required bool share}) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _message = 'Maç dosyası hazırlanıyor…';
    });
    try {
      String? uri = share ? _savedUri : null;
      if (uri == null) {
        final response = widget.downloadPackageWithProgress == null
            ? await widget.downloadPackage()
            : await widget.downloadPackageWithProgress!(_progress);
        if (response.statusCode != 200) {
          throw Exception(
            'Maç dosyası alınamadı (HTTP ${response.statusCode}).',
          );
        }
        final bytes = response.bodyBytes;
        if (bytes.length < 4 ||
            bytes.length > 128 * 1024 * 1024 ||
            bytes[0] != 0x50 ||
            bytes[1] != 0x4b ||
            bytes[2] != 0x03 ||
            bytes[3] != 0x04) {
          throw Exception('İndirilen dosya geçerli bir ZIP paketi değil.');
        }
        final expectedHash = response.headers['x-export-sha256'];
        if (expectedHash == null ||
            !RegExp(r'^[a-f0-9]{64}$').hasMatch(expectedHash)) {
          throw Exception('Dosya bütünlük bilgisi eksik.');
        }
        _progress('Paket indirildi; telefona kaydediliyor…');
        final result = await _files.invokeMapMethod<String, dynamic>(
          'savePackage',
          {
            'bytes': bytes,
            'sha256': expectedHash,
            'filename':
                'MacRadar-${widget.eventId}-${DateTime.now().microsecondsSinceEpoch}.zip',
          },
        );
        uri = result?['uri'] as String?;
        if (uri == null) {
          if (mounted) setState(() => _message = 'Kaydetme iptal edildi.');
          return;
        }
        _savedUri = uri;
        if (result?['directory'] == 'Download') {
          _saveMessage = 'Maç dosyası Download klasörüne kaydedildi.\n${result?["filename"] ?? ""}';
        }
        _dataMessage = _collectionMessage(response);
        try { await widget.onPackageSaved?.call(); } catch (_) { }
      }
      if (share) {
        await _files.invokeMethod<void>('sharePackage', {'uri': uri});
      }
      if (mounted) {
        setState(
          () => _message = [
            share
                ? 'Dosya hazır. Açılan menüden paylaşabilirsin.'
                : _saveMessage,
            _dataMessage,
          ].where((part) => part.isNotEmpty).join('\n'),
        );
      }
    } on PlatformException catch (error) {
      if (mounted) {
        setState(
          () => _message = error.message ?? 'Dosya işlemi tamamlanamadı.',
        );
      }
    } catch (error) {
      if (mounted) setState(() => _message = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Row(
                  children: [
                    Icon(Icons.folder_zip_outlined),
                    SizedBox(width: 10),
                    Text(
                      'Maç kartı',
                      style: TextStyle(
                        fontSize: 20,
                        fontWeight: FontWeight.bold,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 14),
                Text(
                  widget.title,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 12),
                const Text(
                  'Erişilebilen 1X2, Alt/Üst, Asian ve KG fiyatları, kaynak '
                  'açılışları ve geçmiş kayıtları, grafikler ve kayıtlı takım '
                  'performansları tek ZIP dosyasında indirilir. Geçmişin '
                  'kapsamı ve eksik kaynak alanları dosyada belirtilir.',
                ),
                const SizedBox(height: 12),
                const Text(
                  'ZIP içinde okunabilir maç kartı, SVG grafikler ve tüm verileri '
                  'içeren JSON dosyaları bulunur. Eksik performans bilgisi pakette belirtilir.',
                ),
                const SizedBox(height: 18),
                Row(
                  children: [
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: _busy ? null : () => _export(share: false),
                        icon: const Icon(Icons.download),
                        label: const Text('İndir'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: OutlinedButton.icon(
                        onPressed: _busy ? null : () => _export(share: true),
                        icon: const Icon(Icons.share),
                        label: const Text('Paylaş'),
                      ),
                    ),
                  ],
                ),
                if (_busy) ...[
                  const SizedBox(height: 16),
                  const LinearProgressIndicator(),
                ],
                if (_message.isNotEmpty) ...[
                  const SizedBox(height: 14),
                  Text(_message),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}
