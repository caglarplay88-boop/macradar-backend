import 'dart:convert';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

const String baseUrl = 'https://macradar-backend.onrender.com';
const String mobileKey = '68427531';
final Api api = Api();

void main() => runApp(const MacRadarApp());

class Api {
  Map<String, String> get writeHeaders => {
        'content-type': 'application/json',
        'x-api-key': mobileKey,
      };

  Future<Map<String, dynamic>> get(String path) async {
    final r = await http
        .get(Uri.parse(baseUrl + path))
        .timeout(const Duration(seconds: 90));
    return decode(r);
  }

  Future<Map<String, dynamic>> post(
      String path, Map<String, dynamic> body) async {
    final r = await http
        .post(
          Uri.parse(baseUrl + path),
          headers: writeHeaders,
          body: jsonEncode(body),
        )
        .timeout(const Duration(seconds: 90));
    return decode(r);
  }

  Future<Map<String, dynamic>> delete(String path) async {
    final r = await http
        .delete(Uri.parse(baseUrl + path), headers: writeHeaders)
        .timeout(const Duration(seconds: 90));
    return decode(r);
  }

  Map<String, dynamic> decode(http.Response r) {
    Map<String, dynamic> d = {};
    try {
      final x = jsonDecode(r.body);
      if (x is Map) d = Map<String, dynamic>.from(x);
    } catch (_) {}
    if (r.statusCode < 200 || r.statusCode >= 300) {
      throw Exception(
          d['error']?.toString() ?? ('Sunucu hatası ' + r.statusCode.toString()));
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
      builder: (context, child) {
        final media = MediaQuery.of(context);
        return MediaQuery(
          data: media.copyWith(textScaler: const TextScaler.linear(0.88)),
          child: child ?? const SizedBox.shrink(),
        );
      },
      darkTheme: ThemeData(
        brightness: Brightness.dark,
        useMaterial3: true,
        colorSchemeSeed: const Color(0xFF58D6A6),
        scaffoldBackgroundColor: const Color(0xFF0D1117),
        visualDensity: VisualDensity.compact,
        appBarTheme: const AppBarTheme(
          centerTitle: false,
          titleTextStyle: TextStyle(
            fontSize: 19,
            fontWeight: FontWeight.w600,
            color: Color(0xFFE6ECE8),
          ),
        ),
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

  @override
  Widget build(BuildContext context) {
    const names = ['Bülten', 'Takip', 'Sistem'];
    const pages = [
      BulletinPage(),
      TrackedPage(),
      SystemPage(),
    ];

    return Scaffold(
      appBar: AppBar(
        title: Row(
          children: [
            const Icon(Icons.radar_rounded, size: 22),
            const SizedBox(width: 7),
            Text('MacRadar · ' + names[index]),
          ],
        ),
      ),
      body: IndexedStack(index: index, children: pages),
      bottomNavigationBar: NavigationBar(
        height: 64,
        selectedIndex: index,
        onDestinationSelected: (v) => setState(() => index = v),
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.calendar_month_outlined),
            selectedIcon: Icon(Icons.calendar_month),
            label: 'Bülten',
          ),
          NavigationDestination(
            icon: Icon(Icons.bookmark_border),
            selectedIcon: Icon(Icons.bookmark),
            label: 'Takip',
          ),
          NavigationDestination(
            icon: Icon(Icons.monitor_heart_outlined),
            selectedIcon: Icon(Icons.monitor_heart),
            label: 'Sistem',
          ),
        ],
      ),
    );
  }
}

class BulletinPage extends StatefulWidget {
  const BulletinPage({super.key});

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
    if (mounted) {
      setState(() {
        loading = true;
        error = '';
        selected.clear();
      });
    }

    try {
      final d = await api.get('/api/bulletin?date=' + iso(date));
      final x = d['matches'];
      matches = x is List
          ? x
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList()
          : [];
    } catch (e) {
      error = e.toString();
    }

    if (mounted) setState(() => loading = false);
  }

  Future<void> follow() async {
    if (selected.isEmpty || saving) return;

    final count = selected.length;
    setState(() => saving = true);

    try {
      final d = await api.post('/api/follow', {'urls': selected.toList()});
      final rows = d['results'] is List ? d['results'] as List : [];
      final ok = rows.where((e) => e is Map && e['ok'] == true).length;

      if (mounted) {
        setState(() {
          selected.clear();
          saving = false;
        });

        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              ok == count
                  ? ok.toString() + ' maç takibe alındı. Oran çekimi sunucuda başladı.'
                  : ok.toString() + ' / ' + count.toString() + ' maç takibe alındı.',
            ),
          ),
        );
      }

      await load();
    } catch (e) {
      if (mounted) {
        setState(() => saving = false);
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.toString())));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final isToday = date.year == now.year &&
        date.month == now.month &&
        date.day == now.day;

    final groups = <String, List<Map<String, dynamic>>>{};
    for (final m in matches) {
      final league = m['league']?.toString() ?? 'Diğer';
      groups.putIfAbsent(league, () => []).add(m);
    }

    return RefreshIndicator(
      onRefresh: load,
      child: CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 14, 6),
              child: Row(
                children: [
                  IconButton.filledTonal(
                    visualDensity: VisualDensity.compact,
                    onPressed: isToday
                        ? null
                        : () {
                            date = date.subtract(const Duration(days: 1));
                            load();
                          },
                    icon: const Icon(Icons.chevron_left, size: 22),
                  ),
                  Expanded(
                    child: Column(
                      children: [
                        const Text(
                          'MAÇ BÜLTENİ',
                          style: TextStyle(fontSize: 10, letterSpacing: 1.2),
                        ),
                        Text(
                          iso(date),
                          style: const TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ],
                    ),
                  ),
                  IconButton.filledTonal(
                    visualDensity: VisualDensity.compact,
                    onPressed: () {
                      date = date.add(const Duration(days: 1));
                      load();
                    },
                    icon: const Icon(Icons.chevron_right, size: 22),
                  ),
                ],
              ),
            ),
          ),
          if (selected.isNotEmpty)
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 0, 14, 7),
                child: FilledButton.icon(
                  style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(38),
                  ),
                  onPressed: saving ? null : follow,
                  icon: saving
                      ? const SizedBox(
                          width: 15,
                          height: 15,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.add_task, size: 18),
                  label: Text(
                    saving
                        ? 'Kaydediliyor...'
                        : selected.length.toString() + ' maçı takibe al',
                    style: const TextStyle(fontSize: 13),
                  ),
                ),
              ),
            ),
          if (loading)
            const SliverFillRemaining(
              child: Center(child: CircularProgressIndicator()),
            )
          else if (error.isNotEmpty)
            SliverFillRemaining(
              hasScrollBody: false,
              child: ErrorPane(message: error, retry: load),
            )
          else if (matches.isEmpty)
            const SliverFillRemaining(
              hasScrollBody: false,
              child: Center(child: Text('Bu tarihte maç bulunamadı.')),
            )
          else
            for (final g in groups.entries) ...[
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(14, 10, 14, 4),
                  child: Text(
                    g.key,
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                      color: Color(0xFF9AA8B6),
                    ),
                  ),
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
                    padding: const EdgeInsets.fromLTRB(10, 2, 10, 2),
                    child: Card(
                      child: CheckboxListTile(
                        dense: true,
                        visualDensity: const VisualDensity(vertical: -2),
                        contentPadding:
                            const EdgeInsets.symmetric(horizontal: 10),
                        value: checked,
                        onChanged: followed
                            ? null
                            : (v) {
                                setState(() {
                                  if (v == true) {
                                    selected.add(url);
                                  } else {
                                    selected.remove(url);
                                  }
                                });
                              },
                        controlAffinity: ListTileControlAffinity.trailing,
                        title: Text(
                          m['name']?.toString() ?? '-',
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        subtitle: Text(
                          (m['time']?.toString() ?? '--:--') +
                              (followed ? '  ·  Takipte' : ''),
                          style: const TextStyle(fontSize: 12),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ],
          const SliverToBoxAdapter(child: SizedBox(height: 20)),
        ],
      ),
    );
  }
}

class TrackedPage extends StatefulWidget {
  const TrackedPage({super.key});

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
    if (mounted) {
      setState(() {
        loading = true;
        error = '';
      });
    }

    try {
      final d = await api.get('/api/matches');
      final x = d['matches'];
      matches = x is List
          ? x
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .where((e) => e['active'] == true)
              .toList()
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
    try {
      await api.delete('/api/matches/' + m['event_id'].toString());
      await load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.toString())));
      }
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
                SizedBox(height: 170),
                Icon(Icons.bookmark_border, size: 46),
                SizedBox(height: 10),
                Center(child: Text('Takip edilen maç yok.')),
              ],
            )
          : ListView.separated(
              padding: const EdgeInsets.all(10),
              itemCount: matches.length,
              separatorBuilder: (_, __) => const SizedBox(height: 5),
              itemBuilder: (context, i) {
                final m = matches[i];
                final slug = m['match_slug']?.toString() ??
                    m['event_id'].toString();

                return Card(
                  child: ListTile(
                    dense: true,
                    visualDensity: const VisualDensity(vertical: -1),
                    leading: const CircleAvatar(
                      radius: 18,
                      child: Icon(Icons.sports_soccer, size: 19),
                    ),
                    title: Text(
                      nice(slug),
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    subtitle: Text(
                      'Oran satırı: ' + (m['row_count']?.toString() ?? '0'),
                      style: const TextStyle(fontSize: 11),
                    ),
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => MatchDetail(
                          eventId: m['event_id'].toString(),
                          title: nice(slug),
                        ),
                      ),
                    ),
                    trailing: PopupMenuButton<String>(
                      onSelected: (x) {
                        if (x == 'remove') remove(m);
                      },
                      itemBuilder: (_) => const [
                        PopupMenuItem(
                          value: 'remove',
                          child: Text('Takipten çıkar'),
                        ),
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

  const MatchDetail({
    super.key,
    required this.eventId,
    required this.title,
  });

  @override
  State<MatchDetail> createState() => _MatchDetailState();
}

class _MatchDetailState extends State<MatchDetail> {
  bool loading = true;
  bool refreshing = false;
  String error = '';
  Map<String, dynamic> data = {};

  @override
  void initState() {
    super.initState();
    load();
  }

  Future<void> load() async {
    if (mounted) {
      setState(() {
        loading = true;
        error = '';
      });
    }

    try {
      data = await api.get('/api/matches/' + widget.eventId);
    } catch (e) {
      error = e.toString();
    }

    if (mounted) setState(() => loading = false);
  }

  String odd(dynamic x) {
    if (x == null) return '-';
    return x is num ? x.toStringAsFixed(2) : x.toString();
  }

  String stamp(dynamic raw) {
    if (raw == null) return 'Henüz kayıt yok';
    try {
      final dt = DateTime.parse(raw.toString()).toLocal();
      return dt.day.toString().padLeft(2, '0') +
          '/' +
          dt.month.toString().padLeft(2, '0') +
          ' ' +
          dt.hour.toString().padLeft(2, '0') +
          ':' +
          dt.minute.toString().padLeft(2, '0');
    } catch (_) {
      return raw.toString();
    }
  }

  Future<void> refreshNow() async {
    if (refreshing) return;

    final before = data['latest_capture']?.toString();
    setState(() => refreshing = true);

    try {
      await api.post('/api/matches/' + widget.eventId + '/refresh', {});

      Map<String, dynamic>? newest;
      bool changed = false;

      for (int i = 0; i < 24; i++) {
        await Future.delayed(Duration(seconds: i == 0 ? 2 : 4));
        final d = await api.get('/api/matches/' + widget.eventId);
        newest = d;

        final after = d['latest_capture']?.toString();
        if (after != null && after.isNotEmpty && after != before) {
          changed = true;
          break;
        }
      }

      if (newest != null) data = newest;

      if (mounted) {
        setState(() => refreshing = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              changed
                  ? 'Yeni oran kaydı alındı.'
                  : 'Çekim sırada veya devam ediyor. Birazdan tekrar kontrol et.',
            ),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        setState(() => refreshing = false);
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(e.toString())));
      }
    }
  }

  Widget oddBox(dynamic value) {
    return Expanded(
      child: Container(
        margin: const EdgeInsets.only(left: 4),
        padding: const EdgeInsets.symmetric(vertical: 6),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(8),
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
        ),
        child: Text(
          odd(value),
          style: const TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w800,
          ),
        ),
      ),
    );
  }

  Widget line(String label, List<dynamic> values) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          SizedBox(
            width: 78,
            child: Text(label, style: const TextStyle(fontSize: 12)),
          ),
          for (final v in values) oddBox(v),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final history = data['history'] is List
        ? (data['history'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList()
        : <Map<String, dynamic>>[];

    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.title,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      body: loading
          ? const Center(child: CircularProgressIndicator())
          : error.isNotEmpty
              ? ErrorPane(message: error, retry: load)
              : RefreshIndicator(
                  onRefresh: load,
                  child: ListView(
                    padding: const EdgeInsets.all(10),
                    children: [
                      Row(
                        children: [
                          const Expanded(
                            child: Text(
                              'SON ORANLAR',
                              style: TextStyle(
                                fontSize: 13,
                                fontWeight: FontWeight.w800,
                                letterSpacing: 1.0,
                              ),
                            ),
                          ),
                          FilledButton.icon(
                            onPressed: refreshing ? null : refreshNow,
                            icon: refreshing
                                ? const SizedBox(
                                    width: 14,
                                    height: 14,
                                    child: CircularProgressIndicator(strokeWidth: 2),
                                  )
                                : const Icon(Icons.refresh, size: 17),
                            label: Text(
                              refreshing ? 'Çekiliyor...' : 'Oranları şimdi al',
                              style: const TextStyle(fontSize: 11),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Text(
                        'Son kayıt: ' + stamp(data['latest_capture']),
                        style: const TextStyle(
                          fontSize: 11,
                          color: Color(0xFFA7B0B8),
                        ),
                      ),
                      const SizedBox(height: 7),
                      if (!(data['latest_rows'] is List) ||
                          (data['latest_rows'] as List).isEmpty)
                        const Card(
                          child: Padding(
                            padding: EdgeInsets.all(12),
                            child: Text(
                              'İlk oran kaydı henüz oluşmadı. Takibe alınca otomatik çekilir; istersen yukarıdaki butonla şimdi de başlatabilirsin.',
                              style: TextStyle(fontSize: 12),
                            ),
                          ),
                        ),
                      ...(data['latest_rows'] is List
                              ? data['latest_rows'] as List
                              : [])
                          .whereType<Map>()
                          .map((raw) {
                        final r = Map<String, dynamic>.from(raw);
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 7),
                          child: Card(
                            child: Padding(
                              padding: const EdgeInsets.all(10),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    r['bookmaker']?.toString() ?? 'Bookmaker',
                                    style: const TextStyle(
                                      fontSize: 14,
                                      fontWeight: FontWeight.w800,
                                    ),
                                  ),
                                  const Divider(height: 14),
                                  line('MS 1/X/2',
                                      [r['ms1'], r['msx'], r['ms2']]),
                                  line('1.5 Alt/Üst',
                                      [r['ou15_under'], r['ou15_over']]),
                                  line('2.5 Alt/Üst',
                                      [r['ou25_under'], r['ou25_over']]),
                                  line('KG Yok/Var',
                                      [r['btts_no'], r['btts_yes']]),
                                ],
                              ),
                            ),
                          ),
                        );
                      }),
                      const SizedBox(height: 10),
                      Text(
                        'ORAN HAREKETİ · ' +
                            history.length.toString() +
                            ' KAYIT',
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.0,
                        ),
                      ),
                      const SizedBox(height: 3),
                      const Text(
                        'Her kayıt gün/saat/dakika ile saklanır. ↑ yükseldi, ↓ düştü, → değişmedi.',
                        style: TextStyle(
                          fontSize: 11,
                          color: Color(0xFFA7B0B8),
                        ),
                      ),
                      const SizedBox(height: 8),
                      if (history.length < 2)
                        const Card(
                          child: Padding(
                            padding: EdgeInsets.all(14),
                            child: Text(
                              'Grafik için en az 2 oran kaydı gerekiyor. Yeni turlar geldikçe grafik oluşacak.',
                              style: TextStyle(fontSize: 12),
                            ),
                          ),
                        )
                      else ...[
                        OddsHistoryChart(
                          title: 'MS 1 / X / 2',
                          history: history,
                          series: const [
                            ChartSeries('1', 'ms1', Color(0xFF62D6A7)),
                            ChartSeries('X', 'msx', Color(0xFFFFC857)),
                            ChartSeries('2', 'ms2', Color(0xFFFF7A90)),
                          ],
                        ),
                        OddsHistoryChart(
                          title: '1.5 Alt / Üst',
                          history: history,
                          series: const [
                            ChartSeries(
                                'Alt', 'ou15_under', Color(0xFF7CB7FF)),
                            ChartSeries(
                                'Üst', 'ou15_over', Color(0xFF62D6A7)),
                          ],
                        ),
                        OddsHistoryChart(
                          title: '2.5 Alt / Üst',
                          history: history,
                          series: const [
                            ChartSeries(
                                'Alt', 'ou25_under', Color(0xFF7CB7FF)),
                            ChartSeries(
                                'Üst', 'ou25_over', Color(0xFF62D6A7)),
                          ],
                        ),
                        OddsHistoryChart(
                          title: 'KG Yok / Var',
                          history: history,
                          series: const [
                            ChartSeries(
                                'Yok', 'btts_no', Color(0xFFFF7A90)),
                            ChartSeries(
                                'Var', 'btts_yes', Color(0xFF62D6A7)),
                          ],
                        ),
                      ],
                      const SizedBox(height: 18),
                    ],
                  ),
                ),
    );
  }
}

class ChartSeries {
  final String label;
  final String keyName;
  final Color color;

  const ChartSeries(this.label, this.keyName, this.color);
}

class OddsHistoryChart extends StatelessWidget {
  final String title;
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;

  const OddsHistoryChart({
    super.key,
    required this.title,
    required this.history,
    required this.series,
  });

  @override
  Widget build(BuildContext context) {
    final available = MediaQuery.of(context).size.width - 36;
    final chartWidth = math.max(available, history.length * 70.0);

    return Card(
      margin: const EdgeInsets.only(bottom: 9),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 10, 8, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    title,
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                Wrap(
                  spacing: 8,
                  children: series
                      .map(
                        (s) => Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                color: s.color,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 3),
                            Text(
                              s.label,
                              style: const TextStyle(fontSize: 10),
                            ),
                          ],
                        ),
                      )
                      .toList(),
                ),
              ],
            ),
            const SizedBox(height: 6),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: CustomPaint(
                size: Size(chartWidth, 190),
                painter: OddsChartPainter(
                  history: history,
                  series: series,
                ),
              ),
            ),
            const Divider(height: 14),
            SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: _HistoryTable(
                history: history,
                series: series,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _HistoryTable extends StatelessWidget {
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;

  const _HistoryTable({
    required this.history,
    required this.series,
  });

  String when(dynamic raw) {
    try {
      final dt = DateTime.parse(raw.toString()).toLocal();
      return dt.day.toString().padLeft(2, '0') +
          '/' +
          dt.month.toString().padLeft(2, '0') +
          ' ' +
          dt.hour.toString().padLeft(2, '0') +
          ':' +
          dt.minute.toString().padLeft(2, '0');
    } catch (_) {
      return '--/-- --:--';
    }
  }

  Widget valueCell(int row, ChartSeries s) {
    final raw = history[row][s.keyName];
    final current = raw is num ? raw.toDouble() : null;
    if (current == null) {
      return const SizedBox(
        width: 78,
        child: Text('-', textAlign: TextAlign.center),
      );
    }

    String arrow = '→';
    Color arrowColor = const Color(0xFF9AA5A0);

    if (row > 0) {
      final prevRaw = history[row - 1][s.keyName];
      final prev = prevRaw is num ? prevRaw.toDouble() : null;
      if (prev != null) {
        if (current > prev + 0.0001) {
          arrow = '↑';
          arrowColor = const Color(0xFF62D6A7);
        } else if (current < prev - 0.0001) {
          arrow = '↓';
          arrowColor = const Color(0xFFFF7A90);
        }
      }
    }

    return SizedBox(
      width: 78,
      child: RichText(
        textAlign: TextAlign.center,
        text: TextSpan(
          style: const TextStyle(
            color: Color(0xFFE4EAE6),
            fontSize: 11,
          ),
          children: [
            TextSpan(text: current.toStringAsFixed(2) + ' '),
            TextSpan(
              text: arrow,
              style: TextStyle(
                color: arrowColor,
                fontWeight: FontWeight.w800,
              ),
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final width = 112.0 + (78.0 * series.length);

    return SizedBox(
      width: width,
      child: Column(
        children: [
          Container(
            padding: const EdgeInsets.symmetric(vertical: 7),
            decoration: const BoxDecoration(
              border: Border(
                bottom: BorderSide(color: Color(0xFF39413E)),
              ),
            ),
            child: Row(
              children: [
                const SizedBox(
                  width: 112,
                  child: Text(
                    'Tarih / Saat',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                for (final s in series)
                  SizedBox(
                    width: 78,
                    child: Text(
                      s.label,
                      textAlign: TextAlign.center,
                      style: const TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ),
              ],
            ),
          ),
          for (int i = 0; i < history.length; i++)
            Container(
              padding: const EdgeInsets.symmetric(vertical: 7),
              decoration: const BoxDecoration(
                border: Border(
                  bottom: BorderSide(color: Color(0xFF2B3330)),
                ),
              ),
              child: Row(
                children: [
                  SizedBox(
                    width: 112,
                    child: Text(
                      when(history[i]['captured_at']),
                      style: const TextStyle(fontSize: 10),
                    ),
                  ),
                  for (final s in series) valueCell(i, s),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class OddsChartPainter extends CustomPainter {
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;

  OddsChartPainter({
    required this.history,
    required this.series,
  });

  @override
  void paint(Canvas canvas, Size size) {
    const left = 42.0;
    const top = 8.0;
    const right = 12.0;
    const bottom = 34.0;

    final plot = Rect.fromLTRB(
      left,
      top,
      size.width - right,
      size.height - bottom,
    );

    final values = <double>[];
    for (final row in history) {
      for (final s in series) {
        final v = row[s.keyName];
        if (v is num) values.add(v.toDouble());
      }
    }

    if (values.isEmpty) return;

    double minV = values.reduce(math.min);
    double maxV = values.reduce(math.max);

    if ((maxV - minV).abs() < 0.001) {
      minV -= 0.1;
      maxV += 0.1;
    } else {
      final pad = (maxV - minV) * 0.12;
      minV -= pad;
      maxV += pad;
    }

    final gridPaint = Paint()
      ..color = const Color(0xFF3A4340)
      ..strokeWidth = 1;

    for (int i = 0; i <= 4; i++) {
      final y = plot.top + plot.height * i / 4;
      canvas.drawLine(
        Offset(plot.left, y),
        Offset(plot.right, y),
        gridPaint,
      );

      final value = maxV - (maxV - minV) * i / 4;
      _text(
        canvas,
        value.toStringAsFixed(2),
        Offset(1, y - 7),
        const TextStyle(
          color: Color(0xFF8F9995),
          fontSize: 9,
        ),
      );
    }

    final n = history.length;

    double xFor(int i) {
      if (n <= 1) return plot.left;
      return plot.left + plot.width * i / (n - 1);
    }

    double yFor(double value) {
      return plot.bottom -
          ((value - minV) / (maxV - minV)) * plot.height;
    }

    for (int i = 0; i < n; i++) {
      final x = xFor(i);
      final stamp = history[i]['captured_at']?.toString() ?? '';
      String label = '--:--';

      try {
        final dt = DateTime.parse(stamp).toLocal();
        label = dt.hour.toString().padLeft(2, '0') +
            ':' +
            dt.minute.toString().padLeft(2, '0');
      } catch (_) {}

      _centerText(
        canvas,
        label,
        Offset(x, plot.bottom + 9),
        const TextStyle(
          color: Color(0xFFB0BAB5),
          fontSize: 9,
          fontWeight: FontWeight.w600,
        ),
      );
    }

    for (final s in series) {
      final paint = Paint()
        ..color = s.color
        ..strokeWidth = 2
        ..style = PaintingStyle.stroke;

      final pointPaint = Paint()
        ..color = s.color
        ..style = PaintingStyle.fill;

      final path = Path();
      bool started = false;

      for (int i = 0; i < n; i++) {
        final raw = history[i][s.keyName];
        if (raw is! num) continue;

        final p = Offset(xFor(i), yFor(raw.toDouble()));

        if (!started) {
          path.moveTo(p.dx, p.dy);
          started = true;
        } else {
          path.lineTo(p.dx, p.dy);
        }

        canvas.drawCircle(p, 3, pointPaint);
      }

      if (started) canvas.drawPath(path, paint);
    }
  }

  void _text(
    Canvas canvas,
    String text,
    Offset pos,
    TextStyle style,
  ) {
    final tp = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: TextDirection.ltr,
    )..layout();

    tp.paint(canvas, pos);
  }

  void _centerText(
    Canvas canvas,
    String text,
    Offset center,
    TextStyle style,
  ) {
    final tp = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: TextDirection.ltr,
    )..layout();

    tp.paint(
      canvas,
      Offset(center.dx - tp.width / 2, center.dy),
    );
  }

  @override
  bool shouldRepaint(covariant OddsChartPainter oldDelegate) => true;
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
    if (mounted) {
      setState(() {
        loading = true;
        error = '';
      });
    }

    try {
      data = await api.get('/api/system/status');
    } catch (e) {
      error = e.toString();
    }

    if (mounted) setState(() => loading = false);
  }

  Widget stat(String k, dynamic v) {
    return Card(
      margin: const EdgeInsets.only(bottom: 6),
      child: ListTile(
        dense: true,
        title: Text(k, style: const TextStyle(fontSize: 12)),
        trailing: Text(
          v?.toString() ?? '-',
          style: const TextStyle(
            fontWeight: FontWeight.w800,
            fontSize: 13,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (loading) return const Center(child: CircularProgressIndicator());
    if (error.isNotEmpty) return ErrorPane(message: error, retry: load);

    final run = data['last_run'] is Map
        ? Map<String, dynamic>.from(data['last_run'])
        : <String, dynamic>{};

    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        padding: const EdgeInsets.all(14),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const Icon(Icons.cloud_done_rounded, size: 44),
          const SizedBox(height: 7),
          const Center(
            child: Text(
              'Sunucu bağlı',
              style: TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(height: 18),
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

  const ErrorPane({
    super.key,
    required this.message,
    required this.retry,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.cloud_off_rounded, size: 42),
            const SizedBox(height: 10),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 12),
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: retry,
              icon: const Icon(Icons.refresh, size: 18),
              label: const Text('Tekrar dene'),
            ),
          ],
        ),
      ),
    );
  }
}
