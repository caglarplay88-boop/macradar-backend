import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

const String baseUrl = 'https://macradar-backend.onrender.com';
final Api api = Api();

void main() => runApp(const MacRadarApp());

class Api {
  String key = '';

  Future<Map<String, dynamic>> get(String path) async {
    final r = await http.get(Uri.parse(baseUrl + path)).timeout(const Duration(seconds: 90));
    return decode(r);
  }

  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> body) async {
    final r = await http.post(
      Uri.parse(baseUrl + path),
      headers: {
        'content-type': 'application/json',
        if (key.isNotEmpty) 'x-api-key': key,
      },
      body: jsonEncode(body),
    ).timeout(const Duration(minutes: 4));
    return decode(r);
  }

  Future<Map<String, dynamic>> delete(String path) async {
    final r = await http.delete(
      Uri.parse(baseUrl + path),
      headers: {if (key.isNotEmpty) 'x-api-key': key},
    ).timeout(const Duration(seconds: 90));
    return decode(r);
  }

  Map<String, dynamic> decode(http.Response r) {
    Map<String, dynamic> d = {};
    try {
      final x = jsonDecode(r.body);
      if (x is Map) d = Map<String, dynamic>.from(x);
    } catch (_) {}
    if (r.statusCode < 200 || r.statusCode >= 300) {
      throw Exception(d['error']?.toString() ?? ('Sunucu hatası ' + r.statusCode.toString()));
    }
    return d;
  }
}

class MacRadarApp extends StatelessWidget {
  const MacRadarApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'MacRadar',
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.dark,
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        useMaterial3: true,
        colorSchemeSeed: const Color(0xFF58D6A6),
        scaffoldBackgroundColor: const Color(0xFF0D1117),
      ),
      home: const Home(),
    );
  }
}

class Home extends StatefulWidget {
  const Home({super.key});
  @override
  State<Home> createState() => _HomeState();
}

class _HomeState extends State<Home> {
  int index = 0;
  String code = '';

  @override
  void initState() {
    super.initState();
    loadCode();
  }

  Future<void> loadCode() async {
    final p = await SharedPreferences.getInstance();
    code = p.getString('connection_code') ?? '';
    api.key = code;
    if (mounted) setState(() {});
  }

  Future<bool> ensureCode() async {
    if (code.isNotEmpty) return true;
    await editCode();
    return code.isNotEmpty;
  }

  Future<void> editCode() async {
    final c = TextEditingController(text: code);
    await showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Bağlantı kodu'),
        content: TextField(
          controller: c,
          keyboardType: TextInputType.number,
          obscureText: true,
          decoration: const InputDecoration(
            hintText: '8 haneli kod',
            helperText: 'İlk kurulumda bir kez girilir.',
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Vazgeç')),
          FilledButton(
            onPressed: () async {
              final v = c.text.trim();
              final p = await SharedPreferences.getInstance();
              await p.setString('connection_code', v);
              code = v;
              api.key = v;
              if (mounted) setState(() {});
              if (ctx.mounted) Navigator.pop(ctx);
            },
            child: const Text('Kaydet'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      BulletinPage(ensureCode: ensureCode),
      TrackedPage(ensureCode: ensureCode),
      const SystemPage(),
    ];
    const names = ['Bülten', 'Takip', 'Sistem'];
    return Scaffold(
      appBar: AppBar(
        title: Row(children: [
          const Icon(Icons.radar_rounded),
          const SizedBox(width: 8),
          Text('MacRadar · ' + names[index]),
        ]),
        actions: [
          IconButton(
            onPressed: editCode,
            tooltip: 'Bağlantı kodu',
            icon: Icon(Icons.key_rounded, color: code.isEmpty ? Colors.orangeAccent : null),
          )
        ],
      ),
      body: IndexedStack(index: index, children: pages),
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: (v) => setState(() => index = v),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.calendar_month_outlined), selectedIcon: Icon(Icons.calendar_month), label: 'Bülten'),
          NavigationDestination(icon: Icon(Icons.bookmark_border), selectedIcon: Icon(Icons.bookmark), label: 'Takip'),
          NavigationDestination(icon: Icon(Icons.monitor_heart_outlined), selectedIcon: Icon(Icons.monitor_heart), label: 'Sistem'),
        ],
      ),
    );
  }
}

class BulletinPage extends StatefulWidget {
  final Future<bool> Function() ensureCode;
  const BulletinPage({super.key, required this.ensureCode});
  @override
  State<BulletinPage> createState() => _BulletinPageState();
}

class _BulletinPageState extends State<BulletinPage> {
  DateTime date = DateTime.now();
  bool loading = true;
  bool saving = false;
  String error = '';
  List<Map<String, dynamic>> matches = [];
  final Set<String> selected = {};

  @override
  void initState() {
    super.initState();
    load();
  }

  String iso(DateTime d) {
    return d.year.toString().padLeft(4, '0') + '-' +
        d.month.toString().padLeft(2, '0') + '-' +
        d.day.toString().padLeft(2, '0');
  }

  Future<void> load() async {
    if (mounted) setState(() { loading = true; error = ''; selected.clear(); });
    try {
      final d = await api.get('/api/bulletin?date=' + iso(date));
      final x = d['matches'];
      matches = x is List
          ? x.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : [];
    } catch (e) {
      error = e.toString();
    }
    if (mounted) setState(() => loading = false);
  }

  Future<void> follow() async {
    if (selected.isEmpty || saving) return;
    if (!await widget.ensureCode()) return;
    setState(() => saving = true);
    try {
      final d = await api.post('/api/follow', {'urls': selected.toList()});
      final rows = d['results'] is List ? d['results'] as List : [];
      final ok = rows.where((e) => e is Map && e['ok'] == true).length;
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(ok.toString() + ' maç takibe alındı.')),
        );
      }
      await load();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    }
    if (mounted) setState(() => saving = false);
  }

  @override
  Widget build(BuildContext context) {
    final groups = <String, List<Map<String, dynamic>>>{};
    for (final m in matches) {
      final l = m['league']?.toString() ?? 'Diğer';
      groups.putIfAbsent(l, () => []).add(m);
    }

    return RefreshIndicator(
      onRefresh: load,
      child: CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: Row(children: [
                IconButton.filledTonal(
                  onPressed: () { date = date.subtract(const Duration(days: 1)); load(); },
                  icon: const Icon(Icons.chevron_left),
                ),
                Expanded(
                  child: Column(children: [
                    const Text('MAÇ BÜLTENİ', style: TextStyle(fontSize: 11, letterSpacing: 1.4)),
                    const SizedBox(height: 3),
                    Text(iso(date), style: Theme.of(context).textTheme.titleLarge),
                  ]),
                ),
                IconButton.filledTonal(
                  onPressed: () { date = date.add(const Duration(days: 1)); load(); },
                  icon: const Icon(Icons.chevron_right),
                ),
              ]),
            ),
          ),
          if (selected.isNotEmpty)
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 10),
                child: FilledButton.icon(
                  onPressed: saving ? null : follow,
                  icon: saving
                      ? const SizedBox(width: 17, height: 17, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.add_task),
                  label: Text(saving ? 'Oranlar alınıyor...' : selected.length.toString() + ' maçı takibe al'),
                ),
              ),
            ),
          if (loading)
            const SliverFillRemaining(child: Center(child: CircularProgressIndicator()))
          else if (error.isNotEmpty)
            SliverFillRemaining(hasScrollBody: false, child: ErrorPane(message: error, retry: load))
          else if (matches.isEmpty)
            const SliverFillRemaining(hasScrollBody: false, child: Center(child: Text('Bu tarihte maç bulunamadı.')))
          else
            for (final g in groups.entries) ...[
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
                  child: Text(g.key, style: const TextStyle(fontWeight: FontWeight.w800, color: Color(0xFF9AA8B6))),
                ),
              ),
              SliverList.builder(
                itemCount: g.value.length,
                itemBuilder: (context, i) {
                  final m = g.value[i];
                  final url = m['url']?.toString() ?? '';
                  final followed = m['followed'] == true;
                  final checked = followed || selected.contains(url);
                  return Padding(
                    padding: const EdgeInsets.fromLTRB(12, 3, 12, 3),
                    child: Card(
                      child: CheckboxListTile(
                        value: checked,
                        onChanged: followed ? null : (v) {
                          setState(() {
                            if (v == true) selected.add(url); else selected.remove(url);
                          });
                        },
                        controlAffinity: ListTileControlAffinity.trailing,
                        title: Text(m['name']?.toString() ?? '-', style: const TextStyle(fontWeight: FontWeight.w650)),
                        subtitle: Text((m['time']?.toString() ?? '--:--') + (followed ? '  ·  Takipte' : '')),
                      ),
                    ),
                  );
                },
              ),
            ],
          const SliverToBoxAdapter(child: SizedBox(height: 28)),
        ],
      ),
    );
  }
}

class TrackedPage extends StatefulWidget {
  final Future<bool> Function() ensureCode;
  const TrackedPage({super.key, required this.ensureCode});
  @override
  State<TrackedPage> createState() => _TrackedPageState();
}

class _TrackedPageState extends State<TrackedPage> {
  bool loading = true;
  String error = '';
  List<Map<String, dynamic>> matches = [];

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    if (mounted) setState(() { loading = true; error = ''; });
    try {
      final d = await api.get('/api/matches');
      final x = d['matches'];
      matches = x is List
          ? x.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).where((e) => e['active'] == true).toList()
          : [];
    } catch (e) {
      error = e.toString();
    }
    if (mounted) setState(() => loading = false);
  }

  String nice(String s) {
    return s.split('-').map((x) {
      if (x.isEmpty) return x;
      return x[0].toUpperCase() + x.substring(1);
    }).join(' ');
  }

  Future<void> remove(Map<String, dynamic> m) async {
    if (!await widget.ensureCode()) return;
    try {
      await api.delete('/api/matches/' + m['event_id'].toString());
      await load();
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (loading) return const Center(child: CircularProgressIndicator());
    if (error.isNotEmpty) return ErrorPane(message: error, retry: load);
    return RefreshIndicator(
      onRefresh: load,
      child: matches.isEmpty
          ? ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              children: const [
                SizedBox(height: 180),
                Icon(Icons.bookmark_border, size: 54),
                SizedBox(height: 12),
                Center(child: Text('Takip edilen maç yok.')),
              ],
            )
          : ListView.separated(
              padding: const EdgeInsets.all(12),
              itemCount: matches.length,
              separatorBuilder: (_, __) => const SizedBox(height: 7),
              itemBuilder: (context, i) {
                final m = matches[i];
                final slug = m['match_slug']?.toString() ?? m['event_id'].toString();
                return Card(
                  child: ListTile(
                    leading: const CircleAvatar(child: Icon(Icons.sports_soccer)),
                    title: Text(nice(slug), style: const TextStyle(fontWeight: FontWeight.w750)),
                    subtitle: Text('Oran satırı: ' + (m['row_count']?.toString() ?? '0')),
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => MatchDetail(eventId: m['event_id'].toString(), title: nice(slug)),
                      ),
                    ),
                    trailing: PopupMenuButton<String>(
                      onSelected: (x) { if (x == 'remove') remove(m); },
                      itemBuilder: (_) => const [
                        PopupMenuItem(value: 'remove', child: Text('Takipten çıkar')),
                      ],
                    ),
                  ),
                );
              },
            ),
    );
  }
}

class MatchDetail extends StatefulWidget {
  final String eventId;
  final String title;
  const MatchDetail({super.key, required this.eventId, required this.title});
  @override
  State<MatchDetail> createState() => _MatchDetailState();
}

class _MatchDetailState extends State<MatchDetail> {
  bool loading = true;
  String error = '';
  Map<String, dynamic> data = {};

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    if (mounted) setState(() { loading = true; error = ''; });
    try {
      data = await api.get('/api/matches/' + widget.eventId);
    } catch (e) {
      error = e.toString();
    }
    if (mounted) setState(() => loading = false);
  }

  String odd(dynamic x) => x == null ? '-' : (x is num ? x.toStringAsFixed(2) : x.toString());

  Widget line(String label, dynamic a, dynamic b, [dynamic c]) {
    final vals = [a, b, if (c != null) c];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(children: [
        SizedBox(width: 72, child: Text(label)),
        for (final v in vals) Expanded(
          child: Container(
            margin: const EdgeInsets.only(left: 5),
            padding: const EdgeInsets.symmetric(vertical: 8),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(10),
              color: Theme.of(context).colorScheme.surfaceContainerHighest,
            ),
            child: Text(odd(v), style: const TextStyle(fontWeight: FontWeight.w800)),
          ),
        ),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: loading
          ? const Center(child: CircularProgressIndicator())
          : error.isNotEmpty
              ? ErrorPane(message: error, retry: load)
              : RefreshIndicator(
                  onRefresh: load,
                  child: ListView(
                    padding: const EdgeInsets.all(12),
                    children: [
                      const Text('SON ORANLAR', style: TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1.2)),
                      const SizedBox(height: 8),
                      ...(data['latest_rows'] is List ? data['latest_rows'] as List : [])
                          .whereType<Map>()
                          .map((raw) {
                        final r = Map<String, dynamic>.from(raw);
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 9),
                          child: Card(
                            child: Padding(
                              padding: const EdgeInsets.all(13),
                              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Text(r['bookmaker']?.toString() ?? 'Bookmaker', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
                                const Divider(),
                                line('MS', r['ms1'], r['msx'], r['ms2']),
                                line('1.5 A/Ü', r['ou15_under'], r['ou15_over']),
                                line('2.5 A/Ü', r['ou25_under'], r['ou25_over']),
                                line('KG Y/V', r['btts_no'], r['btts_yes']),
                              ]),
                            ),
                          ),
                        );
                      }),
                      const SizedBox(height: 6),
                      Text('Geçmiş ölçüm: ' + ((data['history'] is List) ? (data['history'] as List).length.toString() : '0') + ' tur'),
                    ],
                  ),
                ),
    );
  }
}

class SystemPage extends StatefulWidget {
  const SystemPage({super.key});
  @override
  State<SystemPage> createState() => _SystemPageState();
}

class _SystemPageState extends State<SystemPage> {
  bool loading = true;
  String error = '';
  Map<String, dynamic> data = {};

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    if (mounted) setState(() { loading = true; error = ''; });
    try {
      data = await api.get('/api/system/status');
    } catch (e) {
      error = e.toString();
    }
    if (mounted) setState(() => loading = false);
  }

  Widget stat(String k, dynamic v) => Card(
    margin: const EdgeInsets.only(bottom: 8),
    child: ListTile(
      title: Text(k),
      trailing: Text(v?.toString() ?? '-', style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 16)),
    ),
  );

  @override
  Widget build(BuildContext context) {
    if (loading) return const Center(child: CircularProgressIndicator());
    if (error.isNotEmpty) return ErrorPane(message: error, retry: load);
    final run = data['last_run'] is Map ? Map<String, dynamic>.from(data['last_run']) : <String, dynamic>{};
    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        padding: const EdgeInsets.all(16),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const Icon(Icons.cloud_done_rounded, size: 58),
          const SizedBox(height: 10),
          Center(child: Text('Sunucu bağlı', style: Theme.of(context).textTheme.headlineSmall)),
          const SizedBox(height: 24),
          stat('Aktif maç', data['active_matches']),
          stat('Toplam oran satırı', data['snapshot_rows']),
          stat('Son tur', run['status']),
          stat('Başarılı', run['ok_count']),
          stat('Hatalı', run['fail_count']),
          stat('Taze / atlanan', run['skipped_count']),
        ],
      ),
    );
  }
}

class ErrorPane extends StatelessWidget {
  final String message;
  final Future<void> Function() retry;
  const ErrorPane({super.key, required this.message, required this.retry});

  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        const Icon(Icons.cloud_off_rounded, size: 48),
        const SizedBox(height: 12),
        Text(message, textAlign: TextAlign.center),
        const SizedBox(height: 14),
        FilledButton.icon(onPressed: retry, icon: const Icon(Icons.refresh), label: const Text('Tekrar dene')),
      ]),
    ),
  );
}
