import 'package:flutter/material.dart';
import 'match_export_session.dart';
import 'package:http/http.dart' as http;

class MatchExportPanel extends StatefulWidget {
  final String eventId;
  final String title;
  final Future<http.Response> Function() downloadPackage;
  final Future<http.Response> Function(void Function(String))? downloadPackageWithProgress;
  final Future<void> Function()? onPackageSaved;
  final Future<http.Response> Function(void Function(String), void Function(int, int))? downloadPackageWithTransfer;
  const MatchExportPanel({
    super.key,
    required this.eventId,
    required this.title,
    required this.downloadPackage,
    this.downloadPackageWithProgress,
    this.onPackageSaved,
    this.downloadPackageWithTransfer,
  });

  static bool hasActiveJob(String eventId) => MatchExportSession.isRunning(eventId);

  @override
  State<MatchExportPanel> createState() => _MatchExportPanelState();
}

class _MatchExportPanelState extends State<MatchExportPanel> {
  late final MatchExportSession _session;
  bool get _busy => _session.busy;
  String get _message => _session.message;
  @override
  void initState() {
    super.initState();
    _session = MatchExportSession.forEvent(widget.eventId);
    _session.addListener(_changed);
  }
  void _changed() { if (mounted) setState(() {}); }
  @override
  void dispose() { _session.removeListener(_changed); super.dispose(); }
  Future<void> _export({required bool share}) => _session.start(
    share: share,
    onPackageSaved: widget.onPackageSaved,
    download: (progress, bytes) {
      if (widget.downloadPackageWithTransfer != null) {
        return widget.downloadPackageWithTransfer!(progress, bytes);
      }
      if (widget.downloadPackageWithProgress != null) {
        return widget.downloadPackageWithProgress!(progress);
      }
      return widget.downloadPackage();
    },
  );

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
                  LinearProgressIndicator(value: _session.phase == "save" ? 1 : _session.downloadFraction),
                  if (_session.phase == "prepare") const Padding(padding: EdgeInsets.only(top: 8), child: Text("Paket hazırlanıyor. Dosya aktarımı başladığında yüzde gösterilecek.")),
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
