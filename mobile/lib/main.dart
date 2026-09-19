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

  String shortStamp(dynamic raw) {
    if (raw == null) return 'henüz yok';
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
                      'Son: ' + shortStamp(m['last_capture']) +
                          '  ·  ' +
                          (m['capture_count']?.toString() ?? '0') +
                          ' tur',
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
  bool autoRequested = false;
  String error = '';
  String refreshMessage = '';
  Map<String, dynamic> data = {};

  static const marketSpecs = [
    MarketSpec(
      title: 'MS 1 / X / 2',
      series: [
        ChartSeries('1', 'ms1', Color(0xFF7CC7FF)),
        ChartSeries('X', 'msx', Color(0xFFFFC857)),
        ChartSeries('2', 'ms2', Color(0xFFFF8293)),
      ],
    ),
    MarketSpec(
      title: '1.5 Alt / Üst',
      series: [
        ChartSeries('Alt', 'ou15_under', Color(0xFF7CC7FF)),
        ChartSeries('Üst', 'ou15_over', Color(0xFF62D6A7)),
      ],
    ),
    MarketSpec(
      title: '2.5 Alt / Üst',
      series: [
        ChartSeries('Alt', 'ou25_under', Color(0xFF7CC7FF)),
        ChartSeries('Üst', 'ou25_over', Color(0xFF62D6A7)),
      ],
    ),
    MarketSpec(
      title: 'KG Yok / Var',
      series: [
        ChartSeries('Yok', 'btts_no', Color(0xFFFF8293)),
        ChartSeries('Var', 'btts_yes', Color(0xFF62D6A7)),
      ],
    ),
  ];

  @override
  void initState() {
    super.initState();
    load();
  }

  bool get hasLatest {
    final rows = data['latest_rows'];
    return rows is List && rows.isNotEmpty;
  }

  String friendlyError(Object e) {
    final s = e.toString();
    if (s.contains('SocketException') ||
        s.contains('connection abort') ||
        s.contains('Failed host lookup') ||
        s.contains('Connection reset')) {
      return 'Sunucu bağlantısı kesildi. VPN açıksa kapatıp tekrar dene.';
    }
    return 'Oran çekimi tamamlanamadı. Biraz sonra tekrar dene.';
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
      error = friendlyError(e);
    }

    if (mounted) {
      setState(() => loading = false);

      if (error.isEmpty && !hasLatest && !autoRequested) {
        autoRequested = true;
        Future.microtask(() => refreshNow(auto: true));
      }
    }
  }

  String stamp(dynamic raw) {
    if (raw == null) return 'Henüz kayıt yok';
    try {
      final dt = DateTime.parse(raw.toString()).toLocal();
      return dt.day.toString().padLeft(2, '0') +
          '/' +
          dt.month.toString().padLeft(2, '0') +
          '/' +
          dt.year.toString() +
          ' ' +
          dt.hour.toString().padLeft(2, '0') +
          ':' +
          dt.minute.toString().padLeft(2, '0');
    } catch (_) {
      return raw.toString();
    }
  }

  Future<void> refreshNow({bool auto = false}) async {
    if (refreshing) return;

    final before = data['latest_capture']?.toString();

    if (mounted) {
      setState(() {
        refreshing = true;
        refreshMessage =
            auto ? 'İlk oranlar çekiliyor…' : 'Yeni oranlar çekiliyor…';
      });
    }

    try {
      await api.post('/api/matches/' + widget.eventId + '/refresh', {});

      Map<String, dynamic>? newest;
      bool changed = false;

      for (int i = 0; i < 45; i++) {
        await Future.delayed(Duration(seconds: i == 0 ? 2 : 4));
        final d = await api.get('/api/matches/' + widget.eventId);
        newest = d;

        final rows = d['latest_rows'];
        final after = d['latest_capture']?.toString();

        if (rows is List &&
            rows.isNotEmpty &&
            (before == null || before.isEmpty || after != before)) {
          changed = true;
          break;
        }
      }

      if (newest != null) data = newest;

      if (mounted) {
        setState(() {
          refreshing = false;
          refreshMessage = changed
              ? 'Yeni oran kaydı alındı.'
              : 'Yeni kayıt henüz oluşmadı. Biraz sonra tekrar kontrol et.';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          refreshing = false;
          refreshMessage = friendlyError(e);
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final latest = data['latest_rows'] is List
        ? (data['latest_rows'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .take(3)
            .toList()
        : <Map<String, dynamic>>[];

    final groups = data['history_groups'] is List
        ? (data['history_groups'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList()
        : <Map<String, dynamic>>[];

    final history = data['history'] is List
        ? (data['history'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList()
        : <Map<String, dynamic>>[];

    final historyBookmaker =
        data['history_bookmaker']?.toString().isNotEmpty == true
            ? data['history_bookmaker'].toString()
            : '1xBet';

    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.title,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      body: loading
          ? const Center(child: CircularProgressIndicator())
          : error.isNotEmpty && latest.isEmpty
              ? ErrorPane(message: error, retry: load)
              : RefreshIndicator(
                  onRefresh: load,
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(10, 8, 10, 24),
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text(
                                  'ORAN TAKİBİ',
                                  style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w800,
                                    letterSpacing: 1.0,
                                  ),
                                ),
                                const SizedBox(height: 2),
                                Text(
                                  'Son kayıt: ' +
                                      stamp(data['latest_capture']),
                                  style: const TextStyle(
                                    fontSize: 11,
                                    color: Color(0xFFA7B0B8),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          FilledButton.icon(
                            onPressed:
                                refreshing ? null : () => refreshNow(),
                            icon: refreshing
                                ? const SizedBox(
                                    width: 14,
                                    height: 14,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : const Icon(Icons.refresh, size: 17),
                            label: Text(
                              refreshing ? 'Çekiliyor…' : 'Şimdi güncelle',
                              style: const TextStyle(fontSize: 11),
                            ),
                          ),
                        ],
                      ),
                      if (refreshMessage.isNotEmpty) ...[
                        const SizedBox(height: 7),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 8,
                          ),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(9),
                            color: Theme.of(context)
                                .colorScheme
                                .surfaceContainerHighest,
                          ),
                          child: Text(
                            refreshMessage,
                            style: const TextStyle(fontSize: 11),
                          ),
                        ),
                      ],
                      const SizedBox(height: 10),
                      const Text(
                        'GÜNCEL ORANLAR',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.0,
                        ),
                      ),
                      const SizedBox(height: 6),
                      if (latest.isEmpty)
                        const Card(
                          child: Padding(
                            padding: EdgeInsets.all(14),
                            child: Text(
                              'İlk oran kaydı bekleniyor.',
                              style: TextStyle(fontSize: 12),
                            ),
                          ),
                        )
                      else
                        for (final row in latest)
                          LatestBookmakerCard(row: row),
                      const SizedBox(height: 12),
                      for (final spec in marketSpecs)
                        MarketSection(
                          spec: spec,
                          primaryHistory: history,
                          historyGroups: groups,
                          bookmaker: historyBookmaker,
                          stamp: stamp,
                        ),
                    ],
                  ),
                ),
    );
  }
}

class LatestBookmakerCard extends StatelessWidget {
  final Map<String, dynamic> row;

  const LatestBookmakerCard({
    super.key,
    required this.row,
  });

  String odd(dynamic x) {
    if (x == null) return '-';
    return x is num ? x.toStringAsFixed(2) : x.toString();
  }

  Widget compactMarket(
    String label,
    List<String> names,
    List<dynamic> values,
  ) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          SizedBox(
            width: 72,
            child: Text(
              label,
              style: const TextStyle(
                fontSize: 10,
                color: Color(0xFFB6C0BB),
              ),
            ),
          ),
          for (int i = 0; i < values.length; i++)
            Expanded(
              child: Container(
                margin: const EdgeInsets.only(left: 4),
                padding: const EdgeInsets.symmetric(vertical: 5),
                decoration: BoxDecoration(
                  color: const Color(0xFF28312D),
                  borderRadius: BorderRadius.circular(7),
                ),
                child: Column(
                  children: [
                    Text(
                      names[i],
                      style: const TextStyle(
                        fontSize: 8,
                        color: Color(0xFF9FAAA4),
                      ),
                    ),
                    const SizedBox(height: 1),
                    Text(
                      odd(values[i]),
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final name = row['bookmaker']?.toString() ?? 'Bookmaker';

    return Card(
      margin: const EdgeInsets.only(bottom: 7),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 9, 10, 9),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              name,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w800,
              ),
            ),
            const Divider(height: 12),
            compactMarket(
              'MS',
              const ['1', 'X', '2'],
              [row['ms1'], row['msx'], row['ms2']],
            ),
            compactMarket(
              '1.5',
              const ['Alt', 'Üst'],
              [row['ou15_under'], row['ou15_over']],
            ),
            compactMarket(
              '2.5',
              const ['Alt', 'Üst'],
              [row['ou25_under'], row['ou25_over']],
            ),
            compactMarket(
              'KG',
              const ['Yok', 'Var'],
              [row['btts_no'], row['btts_yes']],
            ),
          ],
        ),
      ),
    );
  }
}

class MarketSpec {
  final String title;
  final List<ChartSeries> series;

  const MarketSpec({
    required this.title,
    required this.series,
  });
}

class ChartSeries {
  final String label;
  final String keyName;
  final Color color;

  const ChartSeries(this.label, this.keyName, this.color);
}

class MarketSection extends StatelessWidget {
  final MarketSpec spec;
  final List<Map<String, dynamic>> primaryHistory;
  final List<Map<String, dynamic>> historyGroups;
  final String bookmaker;
  final String Function(dynamic) stamp;

  const MarketSection({
    super.key,
    required this.spec,
    required this.primaryHistory,
    required this.historyGroups,
    required this.bookmaker,
    required this.stamp,
  });

  double? asDouble(dynamic x) => x is num ? x.toDouble() : null;

  String buildReport() {
    if (primaryHistory.length < 2) {
      return 'Henüz hareket yorumu için en az 2 kayıt gerekiyor.';
    }

    Map<String, dynamic>? first;
    Map<String, dynamic>? last;

    for (final row in primaryHistory) {
      if (spec.series.any((s) => asDouble(row[s.keyName]) != null)) {
        first ??= row;
        last = row;
      }
    }

    if (first == null || last == null || identical(first, last)) {
      return 'Henüz hareket yorumu için yeterli veri yok.';
    }

    ChartSeries? strongest;
    double strongestPct = 0;
    double from = 0;
    double to = 0;

    for (final s in spec.series) {
      final a = asDouble(first[s.keyName]);
      final b = asDouble(last[s.keyName]);
      if (a == null || b == null || a == 0) continue;
      final pct = ((b - a) / a) * 100;
      if (pct.abs() > strongestPct.abs()) {
        strongest = s;
        strongestPct = pct;
        from = a;
        to = b;
      }
    }

    if (strongest == null || strongestPct.abs() < 0.5) {
      return bookmaker +
          ' tarafında son kayıtlar arasında belirgin bir oran hareketi yok.';
    }

    final direction = strongestPct < 0 ? 'düştü' : 'yükseldi';
    final meaning = strongestPct < 0
        ? 'Bu, fiyatlamanın bu seçeneğe doğru güçlendiğini gösteriyor.'
        : 'Bu, fiyatlamanın bu seçenekten uzaklaştığını gösteriyor.';

    return bookmaker +
        ': ' +
        strongest.label +
        ' oranı ' +
        from.toStringAsFixed(2) +
        ' → ' +
        to.toStringAsFixed(2) +
        ' ' +
        direction +
        ' (%' +
        strongestPct.abs().toStringAsFixed(1) +
        '). ' +
        meaning;
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 10),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 10, 10, 9),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    spec.title,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                Text(
                  'Grafik: ' + bookmaker,
                  style: const TextStyle(
                    fontSize: 9,
                    color: Color(0xFFA7B0B8),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            if (primaryHistory.length < 2)
              Container(
                height: 150,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: const Color(0xFF11161D),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Text(
                  'Grafik için en az 2 kayıt gerekli.',
                  style: TextStyle(fontSize: 11),
                ),
              )
            else
              SizedBox(
                height: 205,
                width: double.infinity,
                child: CustomPaint(
                  painter: OddsChartPainter(
                    history: primaryHistory,
                    series: spec.series,
                  ),
                ),
              ),
            const SizedBox(height: 4),
            ExpansionTile(
              tilePadding: EdgeInsets.zero,
              childrenPadding: EdgeInsets.zero,
              dense: true,
              initiallyExpanded: false,
              title: Text(
                'Saatlik oranlar · ' +
                    historyGroups.length.toString() +
                    ' kayıt',
                style: const TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                ),
              ),
              subtitle: const Text(
                'Tarih / saat / dakika ve 3 bookmaker',
                style: TextStyle(fontSize: 9),
              ),
              children: [
                for (final group in historyGroups.reversed)
                  MarketCaptureTile(
                    group: group,
                    spec: spec,
                    stamp: stamp,
                  ),
              ],
            ),
            const Divider(height: 12),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(
                  Icons.insights_rounded,
                  size: 16,
                  color: Color(0xFF62D6A7),
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    buildReport(),
                    style: const TextStyle(
                      fontSize: 11,
                      height: 1.35,
                      color: Color(0xFFD4DDD8),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class MarketCaptureTile extends StatelessWidget {
  final Map<String, dynamic> group;
  final MarketSpec spec;
  final String Function(dynamic) stamp;

  const MarketCaptureTile({
    super.key,
    required this.group,
    required this.spec,
    required this.stamp,
  });

  String odd(dynamic x) {
    if (x == null) return '-';
    return x is num ? x.toStringAsFixed(2) : x.toString();
  }

  @override
  Widget build(BuildContext context) {
    final rows = group['rows'] is List
        ? (group['rows'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .take(3)
            .toList()
        : <Map<String, dynamic>>[];

    return ExpansionTile(
      tilePadding: const EdgeInsets.symmetric(horizontal: 4),
      childrenPadding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
      dense: true,
      title: Text(
        stamp(group['captured_at']),
        style: const TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w700,
        ),
      ),
      subtitle: Text(
        rows.length.toString() + ' bookmaker',
        style: const TextStyle(fontSize: 9),
      ),
      children: [
        for (final row in rows)
          Container(
            margin: const EdgeInsets.only(bottom: 5),
            padding: const EdgeInsets.symmetric(
              horizontal: 8,
              vertical: 7,
            ),
            decoration: BoxDecoration(
              color: const Color(0xFF171E1B),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: [
                SizedBox(
                  width: 82,
                  child: Text(
                    row['bookmaker']?.toString() ?? '-',
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                ),
                for (final s in spec.series)
                  Expanded(
                    child: Column(
                      children: [
                        Text(
                          s.label,
                          style: const TextStyle(
                            fontSize: 8,
                            color: Color(0xFF9FAAA4),
                          ),
                        ),
                        Text(
                          odd(row[s.keyName]),
                          style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
      ],
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
    const left = 40.0;
    const top = 14.0;
    const right = 10.0;
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
      minV -= 0.05;
      maxV += 0.05;
    } else {
      final pad = (maxV - minV) * 0.10;
      minV -= pad;
      maxV += pad;
    }

    final gridPaint = Paint()
      ..color = const Color(0xFF303A36)
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
        Offset(0, y - 6),
        const TextStyle(
          color: Color(0xFF8F9995),
          fontSize: 8,
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

    final labelEvery = n <= 5 ? 1 : math.max(1, (n / 4).ceil());

    for (int i = 0; i < n; i++) {
      if (i % labelEvery != 0 && i != n - 1) continue;

      String label = '--:--';
      try {
        final dt =
            DateTime.parse(history[i]['captured_at'].toString()).toLocal();
        label = dt.hour.toString().padLeft(2, '0') +
            ':' +
            dt.minute.toString().padLeft(2, '0');
      } catch (_) {}

      _centerText(
        canvas,
        label,
        Offset(xFor(i), plot.bottom + 8),
        const TextStyle(
          color: Color(0xFFB0BAB5),
          fontSize: 8,
          fontWeight: FontWeight.w600,
        ),
      );
    }

    for (final s in series) {
      final linePaint = Paint()
        ..color = s.color
        ..strokeWidth = 2.4
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round;

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

        canvas.drawCircle(p, 3.2, pointPaint);
      }

      if (started) canvas.drawPath(path, linePaint);
    }

    double legendX = plot.left;
    for (final s in series) {
      canvas.drawCircle(
        Offset(legendX + 4, 5),
        3.5,
        Paint()..color = s.color,
      );
      _text(
        canvas,
        s.label,
        Offset(legendX + 11, 0),
        const TextStyle(
          color: Color(0xFFD5DDD8),
          fontSize: 9,
        ),
      );
      legendX += 48;
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
