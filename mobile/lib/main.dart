import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:workmanager/workmanager.dart';

const String baseUrl = 'https://macradar-backend.onrender.com';
const String mobileKey = '68427531';
final Api api = Api();
final FlutterLocalNotificationsPlugin localNotifications =
    FlutterLocalNotificationsPlugin();

const String oddsAlertTask = 'macradarOddsAlertPoll';

String niceMatchName(String slug) {
  return slug.split('-').map((x) {
    if (x.isEmpty) return x;
    return x[0].toUpperCase() + x.substring(1);
  }).join(' ');
}

Future<void> initLocalNotifications({bool requestPermission = false}) async {
  const android = AndroidInitializationSettings('@mipmap/ic_launcher');
  const settings = InitializationSettings(android: android);
  await localNotifications.initialize(settings: settings);

  if (requestPermission) {
    await localNotifications
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.requestNotificationsPermission();
  }
}

Future<Map<String, dynamic>> fetchAlerts(int afterId) async {
  final r = await http
      .get(
        Uri.parse(
          baseUrl +
              '/api/alerts?after_id=' +
              afterId.toString() +
              '&limit=50',
        ),
      )
      .timeout(const Duration(seconds: 60));

  if (r.statusCode < 200 || r.statusCode >= 300) {
    throw Exception('Alert sunucusu ' + r.statusCode.toString());
  }

  final decoded = jsonDecode(r.body);
  return decoded is Map
      ? Map<String, dynamic>.from(decoded)
      : <String, dynamic>{};
}

Future<void> checkOddsAlerts({
  bool showNotifications = true,
  bool primeOnly = false,
}) async {
  final prefs = await SharedPreferences.getInstance();
  final hasCursor = prefs.containsKey('last_alert_id');
  final currentId = prefs.getInt('last_alert_id') ?? 0;

  final data = await fetchAlerts(currentId);
  final latestId = (data['latest_id'] as num?)?.toInt() ?? currentId;

  if (!hasCursor || primeOnly) {
    await prefs.setInt('last_alert_id', latestId);
    return;
  }

  final alerts = data['alerts'] is List ? data['alerts'] as List : const [];

  if (showNotifications) {
    for (final raw in alerts.whereType<Map>()) {
      final a = Map<String, dynamic>.from(raw);
      final id = (a['id'] as num?)?.toInt() ?? 0;
      final slug = a['match_slug']?.toString() ?? 'Maç';
      final market = a['market']?.toString() ?? '';
      final selection = a['selection']?.toString() ?? '';
      final before = (a['previous_odd'] as num?)?.toDouble();
      final after = (a['current_odd'] as num?)?.toDouble();
      final pct = (a['drop_pct'] as num?)?.toDouble();
      final bookmaker = a['bookmaker']?.toString() ?? '1xBet';

      if (before == null || after == null || pct == null) continue;

      const androidDetails = AndroidNotificationDetails(
        'macradar_odds_drop',
        'Oran Düşüşleri',
        channelDescription: 'Anlamlı oran düşüşü uyarıları',
        importance: Importance.high,
        priority: Priority.high,
      );

      await localNotifications.show(
        id: id % 2147483647,
        title: 'MacRadar · Anlamlı oran düşüşü',
        body: niceMatchName(slug) +
            ' · ' +
            market +
            ' ' +
            selection +
            ' · ' +
            before.toStringAsFixed(2) +
            ' → ' +
            after.toStringAsFixed(2) +
            ' (-%' +
            pct.toStringAsFixed(1) +
            ') · ' +
            bookmaker,
        notificationDetails:
            const NotificationDetails(android: androidDetails),
      );
    }
  }

  await prefs.setInt('last_alert_id', latestId);
}

@pragma('vm:entry-point')
void callbackDispatcher() {
  Workmanager().executeTask((task, inputData) async {
    WidgetsFlutterBinding.ensureInitialized();
    DartPluginRegistrant.ensureInitialized();

    try {
      await initLocalNotifications();
      await checkOddsAlerts(showNotifications: true);
      return true;
    } catch (_) {
      return false;
    }
  });
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await initLocalNotifications(requestPermission: true);

  Workmanager().initialize(
    callbackDispatcher,
  );

  await Workmanager().registerPeriodicTask(
    'macradar-hourly-alerts',
    oddsAlertTask,
    frequency: const Duration(hours: 1),
    initialDelay: const Duration(minutes: 5),
    constraints: Constraints(
      networkType: NetworkType.connected,
    ),
  );

  try {
    final prefs = await SharedPreferences.getInstance();
    if (!prefs.containsKey('last_alert_id')) {
      await checkOddsAlerts(
        showNotifications: false,
        primeOnly: true,
      );
    } else {
      await checkOddsAlerts(showNotifications: true);
    }
  } catch (_) {}

  runApp(const MacRadarApp());
}


class Api {
  Map<String, String> get writeHeaders => {
        'content-type': 'application/json',
        'x-api-key': mobileKey,
      };

  Future<http.Response> _retry(
    Future<http.Response> Function() request,
  ) async {
    Object? last;

    for (int attempt = 1; attempt <= 3; attempt++) {
      try {
        return await request();
      } catch (e) {
        last = e;
        if (attempt < 3) {
          await Future.delayed(Duration(seconds: attempt * 2));
        }
      }
    }

    throw last ?? Exception('Bağlantı kurulamadı.');
  }

  Future<Map<String, dynamic>> get(String path) async {
    final r = await _retry(
      () => http
          .get(Uri.parse(baseUrl + path))
          .timeout(const Duration(seconds: 90)),
    );
    return decode(r);
  }

  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> body,
  ) async {
    final r = await _retry(
      () => http
          .post(
            Uri.parse(baseUrl + path),
            headers: writeHeaders,
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 90)),
    );
    return decode(r);
  }

  Future<Map<String, dynamic>> delete(String path) async {
    final r = await _retry(
      () => http
          .delete(
            Uri.parse(baseUrl + path),
            headers: writeHeaders,
          )
          .timeout(const Duration(seconds: 90)),
    );
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
        d['error']?.toString() ??
            ('Sunucu hatası ' + r.statusCode.toString()),
      );
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

  bool bulletinLocked(Map<String, dynamic> m) {
    if (m['archived'] == true) return true;

    final status = m['status']?.toString().toLowerCase() ?? '';
    final time = m['time']?.toString().trim() ?? '';

    if (status == 'finished' ||
        const {'FIN', 'FT', 'AET', 'PEN'}.contains(time.toUpperCase())) {
      return true;
    }

    final dateText = m['date']?.toString() ?? iso(date);
    final match = RegExp(r'^(\d{4})-(\d{2})-(\d{2})  Future<void> load() async {
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
      final chosen = matches
          .where((m) => selected.contains(m['url']?.toString() ?? ''))
          .map((m) => {
                'url': m['url']?.toString() ?? '',
                'eventId': m['eventId']?.toString() ?? '',
                'name': m['name']?.toString() ?? '',
                'league': m['league']?.toString() ?? '',
                'date': m['date']?.toString() ?? iso(date),
                'time': m['time']?.toString() ?? '',
                'status': m['status']?.toString() ?? '',
                'homeScore': m['homeScore'],
                'awayScore': m['awayScore'],
              })
          .toList();

      final d = await api.post('/api/follow', {'matches': chosen});
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
                  final locked = bulletinLocked(m);
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
                        onChanged: (followed || locked)
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
                          bulletinStatus(m) +
                              (followed ? '  ·  Takipte' : '') +
                              (m['archived'] == true ? '  ·  Geçmişte' : ''),
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

      matches.sort((a, b) {
        final ad = a['match_date']?.toString() ?? '9999-12-31';
        final bd = b['match_date']?.toString() ?? '9999-12-31';
        final dateCmp = ad.compareTo(bd);
        if (dateCmp != 0) return dateCmp;

        final at = a['kickoff_time']?.toString() ?? '99:99';
        final bt = b['kickoff_time']?.toString() ?? '99:99';
        return at.compareTo(bt);
      });
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

  String matchDateLabel(dynamic raw) {
    if (raw == null || raw.toString().isEmpty) return 'Tarih yok';
    final s = raw.toString();
    try {
      final p = s.substring(0, 10).split('-');
      return p[2] + '/' + p[1] + '/' + p[0];
    } catch (_) {
      return s;
    }
  }

  String trackedTitle(Map<String, dynamic> m) {
    final display = m['display_name']?.toString().trim() ?? '';
    if (display.isNotEmpty) return display;
    final slug = m['match_slug']?.toString() ?? m['event_id'].toString();
    return nice(slug);
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
                      trackedTitle(m),
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    subtitle: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          matchDateLabel(m['match_date']) +
                              '  ·  ' +
                              (m['kickoff_time']?.toString().isNotEmpty == true
                                  ? m['kickoff_time'].toString()
                                  : '--:--') +
                              (m['league']?.toString().isNotEmpty == true
                                  ? '  ·  ' + m['league'].toString()
                                  : ''),
                          style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Son oran: ' + shortStamp(m['last_capture']) +
                              '  ·  ' +
                              (m['capture_count']?.toString() ?? '0') +
                              ' tur',
                          style: const TextStyle(fontSize: 10),
                        ),
                      ],
                    ),
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => MatchDetail(
                          eventId: m['event_id'].toString(),
                          title: trackedTitle(m),
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
  String selectedMarket = 'MS';
  Map<String, dynamic> data = {};

  @override
  void initState() {
    super.initState();
    load();
  }

  bool get hasLatest {
    final rows = data['latest_rows'];
    return rows is List && rows.isNotEmpty;
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
      error = _friendlyError(e);
    }

    if (mounted) {
      setState(() => loading = false);

      if (error.isEmpty && !hasLatest && !autoRequested) {
        autoRequested = true;
        Future.microtask(() => refreshNow(auto: true));
      }
    }
  }

  String _friendlyError(Object e) {
    final s = e.toString();

    if (s.contains('SocketException') ||
        s.contains('connection abort') ||
        s.contains('Failed host lookup') ||
        s.contains('Connection reset')) {
      return 'Sunucu bağlantısı kısa süre kesildi. VPN açıksa kapatıp tekrar dene.';
    }

    return s.replaceFirst('Exception: ', '');
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

        try {
          newest = await api.get('/api/matches/' + widget.eventId);
        } catch (_) {
          continue;
        }

        final rows = newest['latest_rows'];
        final after = newest['latest_capture']?.toString();

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
              : 'Yeni kayıt henüz gelmedi. Çekim devam ediyor olabilir.';
        });

        if (!auto || changed) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(refreshMessage)),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          refreshing = false;
          refreshMessage = _friendlyError(e);
        });

        if (!auto) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(refreshMessage)),
          );
        }
      }
    }
  }

  String marketReport(
    List<Map<String, dynamic>> history,
    String market,
    List<ChartSeries> series,
  ) {
    if (history.length < 2) {
      return 'İlk kayıt oluştu. Hareket yorumu için en az iki çekim gerekiyor.';
    }

    final first = history.first;
    final last = history.last;
    final parts = <String>[];
    double strongestDrop = 0;
    String strongestLabel = '';

    for (final s in series) {
      final a = first[s.keyName];
      final b = last[s.keyName];

      if (a is! num || b is! num) continue;

      final start = a.toDouble();
      final end = b.toDouble();
      final diff = end - start;

      String move;
      if (diff.abs() < 0.005) {
        move = 'değişmedi';
      } else if (diff < 0) {
        move = start.toStringAsFixed(2) +
            '→' +
            end.toStringAsFixed(2) +
            ' düştü';
      } else {
        move = start.toStringAsFixed(2) +
            '→' +
            end.toStringAsFixed(2) +
            ' yükseldi';
      }

      parts.add(s.label + ' ' + move);

      if (diff < strongestDrop) {
        strongestDrop = diff;
        strongestLabel = s.label;
      }
    }

    String note = parts.join(' · ') + '.';

    if (strongestLabel.isNotEmpty) {
      if (market == 'MS') {
        final label = strongestLabel == '1'
            ? 'ev sahibi'
            : strongestLabel == '2'
                ? 'deplasman'
                : 'beraberlik';
        note +=
            ' En belirgin oran düşüşü ' + label + ' tarafında; piyasa fiyatlaması bu seçeneği önceye göre daha güçlü gösteriyor.';
      } else if (market.contains('Alt / Üst')) {
        note +=
            ' En belirgin sıkışma ' + strongestLabel + ' tarafında.';
      } else if (market.contains('KG')) {
        note +=
            ' En belirgin sıkışma ' + strongestLabel + ' tarafında.';
      }
    }

    return note;
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

    const msSeries = [
      ChartSeries('1', 'ms1', Color(0xFF69C8FF)),
      ChartSeries('X', 'msx', Color(0xFFFFC857)),
      ChartSeries('2', 'ms2', Color(0xFFFF8495)),
    ];

    const ou15Series = [
      ChartSeries('Alt', 'ou15_under', Color(0xFF69C8FF)),
      ChartSeries('Üst', 'ou15_over', Color(0xFF6DE0AA)),
    ];

    const ou25Series = [
      ChartSeries('Alt', 'ou25_under', Color(0xFF69C8FF)),
      ChartSeries('Üst', 'ou25_over', Color(0xFF6DE0AA)),
    ];

    const kgSeries = [
      ChartSeries('Yok', 'btts_no', Color(0xFFFF8495)),
      ChartSeries('Var', 'btts_yes', Color(0xFF6DE0AA)),
    ];

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
                    padding: const EdgeInsets.fromLTRB(10, 10, 10, 24),
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
                              refreshing
                                  ? 'Çekiliyor…'
                                  : 'Şimdi güncelle',
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
                            color: const Color(0xFF18201C),
                          ),
                          child: Text(
                            refreshMessage,
                            style: const TextStyle(fontSize: 11),
                          ),
                        ),
                      ],
                      const SizedBox(height: 12),
                      const Text(
                        'SON ORANLAR',
                        style: TextStyle(
                          fontSize: 13,
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
                      const SizedBox(height: 10),
                      const Text(
                        'ORAN HAREKETİ',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.0,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (final item in const [
                            ('MS', 'MS'),
                            ('1.5', '1.5'),
                            ('2.5', '2.5'),
                            ('KG', 'KG'),
                          ])
                            ChoiceChip(
                              label: Text(
                                item.$1,
                                style: const TextStyle(fontSize: 11),
                              ),
                              selected: selectedMarket == item.$2,
                              onSelected: (_) {
                                setState(() => selectedMarket = item.$2);
                              },
                            ),
                        ],
                      ),
                      const SizedBox(height: 7),
                      if (selectedMarket == 'MS')
                        MarketSection(
                          title: 'MS 1 / X / 2',
                          marketCode: 'MS',
                          bookmaker: historyBookmaker,
                          history: history,
                          series: msSeries,
                          report: marketReport(history, 'MS', msSeries),
                        )
                      else if (selectedMarket == '1.5')
                        MarketSection(
                          title: '1.5 Alt / Üst',
                          marketCode: '1.5 Alt / Üst',
                          bookmaker: historyBookmaker,
                          history: history,
                          series: ou15Series,
                          report: marketReport(
                            history,
                            '1.5 Alt / Üst',
                            ou15Series,
                          ),
                        )
                      else if (selectedMarket == '2.5')
                        MarketSection(
                          title: '2.5 Alt / Üst',
                          marketCode: '2.5 Alt / Üst',
                          bookmaker: historyBookmaker,
                          history: history,
                          series: ou25Series,
                          report: marketReport(
                            history,
                            '2.5 Alt / Üst',
                            ou25Series,
                          ),
                        )
                      else
                        MarketSection(
                          title: 'KG Yok / Var',
                          marketCode: 'KG Yok / Var',
                          bookmaker: historyBookmaker,
                          history: history,
                          series: kgSeries,
                          report: marketReport(
                            history,
                            'KG Yok / Var',
                            kgSeries,
                          ),
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

  String odd(dynamic value) {
    if (value == null) return '-';
    return value is num ? value.toStringAsFixed(2) : value.toString();
  }

  Widget valueBox(String text) {
    return Expanded(
      child: Container(
        margin: const EdgeInsets.only(left: 4),
        padding: const EdgeInsets.symmetric(vertical: 6),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: const Color(0xFF2A322E),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(
          text,
          style: const TextStyle(
            fontSize: 12,
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
            width: 82,
            child: Text(
              label,
              style: const TextStyle(fontSize: 11),
            ),
          ),
          for (final value in values) valueBox(odd(value)),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 7),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              row['bookmaker']?.toString() ?? 'Bookmaker',
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w800,
              ),
            ),
            const Divider(height: 14),
            line('MS 1/X/2', [
              row['ms1'],
              row['msx'],
              row['ms2'],
            ]),
            line('1.5 Alt/Üst', [
              row['ou15_under'],
              row['ou15_over'],
            ]),
            line('2.5 Alt/Üst', [
              row['ou25_under'],
              row['ou25_over'],
            ]),
            line('KG Yok/Var', [
              row['btts_no'],
              row['btts_yes'],
            ]),
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

class MarketSection extends StatelessWidget {
  final String title;
  final String marketCode;
  final String bookmaker;
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;
  final String report;

  const MarketSection({
    super.key,
    required this.title,
    required this.marketCode,
    required this.bookmaker,
    required this.history,
    required this.series,
    required this.report,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              'Bookmaker: ' + bookmaker,
              style: const TextStyle(
                fontSize: 10,
                color: Color(0xFF9DA8A2),
              ),
            ),
            const SizedBox(height: 9),
            CombinedMarketChart(
              history: history,
              series: series,
            ),
            const SizedBox(height: 5),
            Theme(
              data: Theme.of(context).copyWith(
                dividerColor: Colors.transparent,
              ),
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                childrenPadding: EdgeInsets.zero,
                dense: true,
                title: Text(
                  'Geçmiş oranlar · ' +
                      history.length.toString() +
                      ' kayıt',
                  style: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                subtitle: const Text(
                  'Tarih / saat / dakika',
                  style: TextStyle(fontSize: 9),
                ),
                children: [
                  CombinedHistoryTable(
                    history: history,
                    series: series,
                  ),
                ],
              ),
            ),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: const Color(0xFF151C19),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'KISA RAPOR',
                    style: TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.6,
                      color: Color(0xFF8CDAB8),
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    report,
                    style: const TextStyle(
                      fontSize: 10,
                      height: 1.35,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class CombinedMarketChart extends StatefulWidget {
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;

  const CombinedMarketChart({
    super.key,
    required this.history,
    required this.series,
  });

  @override
  State<CombinedMarketChart> createState() =>
      _CombinedMarketChartState();
}

class _CombinedMarketChartState
    extends State<CombinedMarketChart> {
  int? selectedIndex;

  List<Map<String, dynamic>> get rows {
    return widget.history.where((row) {
      return widget.series.any(
        (s) => row[s.keyName] is num,
      );
    }).toList();
  }

  String stamp(dynamic raw) {
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
      return '--/--/---- --:--';
    }
  }

  String odd(dynamic raw) {
    if (raw is num) return raw.toDouble().toStringAsFixed(2);
    return '-';
  }

  void selectNearest(Offset position, double width) {
    final data = rows;
    if (data.isEmpty) return;

    const left = 18.0;
    const right = 8.0;
    final plotWidth = math.max(1.0, width - left - right);

    int index = 0;
    if (data.length > 1) {
      final ratio =
          ((position.dx - left) / plotWidth).clamp(0.0, 1.0);
      index = (ratio * (data.length - 1)).round();
    }

    setState(() => selectedIndex = index);
  }

  @override
  Widget build(BuildContext context) {
    final data = rows;
    final latest =
        data.isEmpty ? null : data.last;

    final selected = selectedIndex != null &&
            selectedIndex! >= 0 &&
            selectedIndex! < data.length
        ? data[selectedIndex!]
        : null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (latest != null)
          Row(
            children: [
              for (final s in widget.series)
                Expanded(
                  child: Container(
                    margin: const EdgeInsets.only(right: 4),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 5,
                      vertical: 7,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0xFF101619),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Column(
                      children: [
                        Row(
                          mainAxisAlignment:
                              MainAxisAlignment.center,
                          children: [
                            Container(
                              width: 7,
                              height: 7,
                              decoration: BoxDecoration(
                                color: s.color,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              s.label,
                              style: const TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          odd(latest[s.keyName]),
                          style: const TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        const SizedBox(height: 8),
        if (data.length < 2)
          Container(
            height: 155,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: const Color(0xFF0D1215),
              borderRadius: BorderRadius.circular(9),
            ),
            child: const Text(
              'Grafik için ikinci kayıt bekleniyor.',
              style: TextStyle(fontSize: 11),
            ),
          )
        else
          LayoutBuilder(
            builder: (context, constraints) {
              return GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapDown: (details) => selectNearest(
                  details.localPosition,
                  constraints.maxWidth,
                ),
                onHorizontalDragUpdate: (details) =>
                    selectNearest(
                  details.localPosition,
                  constraints.maxWidth,
                ),
                child: CustomPaint(
                  size: Size(
                    constraints.maxWidth,
                    185,
                  ),
                  painter: CombinedMarketPainter(
                    history: data,
                    series: widget.series,
                    selectedIndex: selectedIndex,
                  ),
                ),
              );
            },
          ),
        if (selected != null) ...[
          const SizedBox(height: 5),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(
              horizontal: 9,
              vertical: 7,
            ),
            decoration: BoxDecoration(
              color: const Color(0xFF18211D),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  stamp(selected['captured_at']),
                  style: const TextStyle(
                    fontSize: 9,
                    color: Color(0xFFAEB8B3),
                  ),
                ),
                const SizedBox(height: 5),
                Row(
                  children: [
                    for (final s in widget.series)
                      Expanded(
                        child: Row(
                          mainAxisAlignment:
                              MainAxisAlignment.center,
                          children: [
                            Container(
                              width: 7,
                              height: 7,
                              decoration: BoxDecoration(
                                color: s.color,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              s.label +
                                  ' ' +
                                  odd(selected[s.keyName]),
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
              ],
            ),
          ),
        ] else
          const Padding(
            padding: EdgeInsets.only(top: 4),
            child: Text(
              'Grafikte bir noktaya dokun: o dakikanın gerçek oranlarını göster.',
              style: TextStyle(
                fontSize: 9,
                color: Color(0xFF8F9994),
              ),
            ),
          ),
      ],
    );
  }
}

class CombinedHistoryTable extends StatelessWidget {
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;

  const CombinedHistoryTable({
    super.key,
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

  String odd(dynamic raw) {
    if (raw is num) return raw.toDouble().toStringAsFixed(2);
    return '-';
  }

  @override
  Widget build(BuildContext context) {
    if (history.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(10),
        child: Text(
          'Henüz geçmiş kayıt yok.',
          style: TextStyle(fontSize: 10),
        ),
      );
    }

    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(vertical: 6),
          decoration: const BoxDecoration(
            border: Border(
              bottom: BorderSide(
                color: Color(0xFF39413E),
              ),
            ),
          ),
          child: Row(
            children: [
              const SizedBox(
                width: 88,
                child: Text(
                  'Tarih / Saat',
                  style: TextStyle(
                    fontSize: 9,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              for (final s in series)
                Expanded(
                  child: Text(
                    s.label,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
            ],
          ),
        ),
        for (int i = history.length - 1; i >= 0; i--)
          Container(
            padding: const EdgeInsets.symmetric(vertical: 7),
            decoration: const BoxDecoration(
              border: Border(
                bottom: BorderSide(
                  color: Color(0xFF29312E),
                ),
              ),
            ),
            child: Row(
              children: [
                SizedBox(
                  width: 88,
                  child: Text(
                    when(history[i]['captured_at']),
                    style: const TextStyle(
                      fontSize: 8.5,
                    ),
                  ),
                ),
                for (final s in series)
                  Expanded(
                    child: Builder(
                      builder: (context) {
                        final raw = history[i][s.keyName];
                        final current =
                            raw is num ? raw.toDouble() : null;

                        String arrow = '→';
                        Color arrowColor =
                            const Color(0xFF98A39D);

                        if (i > 0 && current != null) {
                          final prevRaw =
                              history[i - 1][s.keyName];

                          if (prevRaw is num) {
                            final previous =
                                prevRaw.toDouble();

                            if (current <
                                previous - 0.0001) {
                              arrow = '↓';
                              arrowColor =
                                  const Color(0xFFFF8495);
                            } else if (current >
                                previous + 0.0001) {
                              arrow = '↑';
                              arrowColor =
                                  const Color(0xFF6DE0AA);
                            }
                          }
                        }

                        return Row(
                          mainAxisAlignment:
                              MainAxisAlignment.center,
                          children: [
                            Text(
                              current == null
                                  ? '-'
                                  : current
                                      .toStringAsFixed(2),
                              style: const TextStyle(
                                fontSize: 10,
                                fontWeight:
                                    FontWeight.w700,
                              ),
                            ),
                            const SizedBox(width: 3),
                            Text(
                              arrow,
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight:
                                    FontWeight.w900,
                                color: arrowColor,
                              ),
                            ),
                          ],
                        );
                      },
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class CombinedMarketPainter extends CustomPainter {
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;
  final int? selectedIndex;

  CombinedMarketPainter({
    required this.history,
    required this.series,
    this.selectedIndex,
  });

  @override
  void paint(Canvas canvas, Size size) {
    const left = 18.0;
    const top = 10.0;
    const right = 8.0;
    const bottom = 28.0;

    final plot = Rect.fromLTRB(
      left,
      top,
      size.width - right,
      size.height - bottom,
    );

    final gridPaint = Paint()
      ..color = const Color(0xFF2B3338)
      ..strokeWidth = 1;

    for (int i = 0; i <= 4; i++) {
      final y = plot.top + plot.height * i / 4;
      canvas.drawLine(
        Offset(plot.left, y),
        Offset(plot.right, y),
        gridPaint,
      );
    }

    final n = history.length;

    double xFor(int i) {
      if (n <= 1) return plot.left;
      return plot.left +
          (plot.width * i / (n - 1));
    }

    for (final s in series) {
      final values = <double>[];
      for (final row in history) {
        final raw = row[s.keyName];
        if (raw is num) values.add(raw.toDouble());
      }

      if (values.isEmpty) continue;

      double minV = values.reduce(math.min);
      double maxV = values.reduce(math.max);
      final range = maxV - minV;

      if (range.abs() < 0.0001) {
        final pad =
            math.max(maxV.abs() * 0.01, 0.03);
        minV -= pad;
        maxV += pad;
      } else {
        final pad = math.max(range * 0.35, 0.01);
        minV -= pad;
        maxV += pad;
      }

      double yFor(double value) {
        return plot.bottom -
            ((value - minV) /
                    (maxV - minV)) *
                plot.height;
      }

      final path = Path();
      final linePaint = Paint()
        ..color = s.color
        ..strokeWidth = 2.7
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..style = PaintingStyle.stroke;

      final pointPaint = Paint()
        ..color = s.color
        ..style = PaintingStyle.fill;

      bool started = false;

      for (int i = 0; i < n; i++) {
        final raw = history[i][s.keyName];
        if (raw is! num) continue;

        final point = Offset(
          xFor(i),
          yFor(raw.toDouble()),
        );

        if (!started) {
          path.moveTo(point.dx, point.dy);
          started = true;
        } else {
          path.lineTo(point.dx, point.dy);
        }

        canvas.drawCircle(
          point,
          selectedIndex == i ? 5.2 : 3.4,
          pointPaint,
        );
      }

      if (started) {
        canvas.drawPath(path, linePaint);
      }
    }

    if (selectedIndex != null &&
        selectedIndex! >= 0 &&
        selectedIndex! < n) {
      final x = xFor(selectedIndex!);

      canvas.drawLine(
        Offset(x, plot.top),
        Offset(x, plot.bottom),
        Paint()
          ..color =
              const Color(0xFF8FA09A)
                  .withValues(alpha: 0.35)
          ..strokeWidth = 1,
      );
    }

    final labelIndexes = <int>{
      0,
      if (n > 2) n ~/ 2,
      if (n > 1) n - 1,
    };

    for (final i in labelIndexes) {
      if (i < 0 || i >= n) continue;

      String label = '--:--';
      try {
        final dt = DateTime.parse(
          history[i]['captured_at'].toString(),
        ).toLocal();
        label =
            dt.hour.toString().padLeft(2, '0') +
                ':' +
                dt.minute
                    .toString()
                    .padLeft(2, '0');
      } catch (_) {}

      _centerText(
        canvas,
        label,
        Offset(
          xFor(i),
          plot.bottom + 8,
        ),
        const TextStyle(
          color: Color(0xFFA0AAA5),
          fontSize: 8,
          fontWeight: FontWeight.w600,
        ),
      );
    }
  }

  void _centerText(
    Canvas canvas,
    String text,
    Offset center,
    TextStyle style,
  ) {
    final tp = TextPainter(
      text: TextSpan(
        text: text,
        style: style,
      ),
      textDirection: TextDirection.ltr,
    )..layout();

    tp.paint(
      canvas,
      Offset(
        center.dx - tp.width / 2,
        center.dy,
      ),
    );
  }

  @override
  bool shouldRepaint(
    covariant CombinedMarketPainter oldDelegate,
  ) {
    return oldDelegate.selectedIndex !=
            selectedIndex ||
        oldDelegate.history != history ||
        oldDelegate.series != series;
  }
}

class SystemPage extends StatefulWidget {
  const SystemPage({super.key});

  @override
  State<SystemPage> createState() => _SystemPageState();
}

class _SystemPageState extends State<SystemPage> {
  bool loading = true;
  bool savingInterval = false;
  String error = '';
  Map<String, dynamic> data = {};
  int refreshMinutes = 60;

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
      refreshMinutes =
          (data['refresh_minutes'] as num?)?.toInt() ?? 60;
    } catch (e) {
      error = e.toString();
    }

    if (mounted) setState(() => loading = false);
  }

  Future<void> saveInterval(int minutes) async {
    if (savingInterval || minutes == refreshMinutes) return;

    setState(() => savingInterval = true);

    try {
      final d = await api.post(
        '/api/settings/refresh-interval',
        {'minutes': minutes},
      );

      final saved =
          (d['refresh_minutes'] as num?)?.toInt() ?? minutes;

      if (mounted) {
        setState(() {
          refreshMinutes = saved;
          savingInterval = false;
        });

        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'Oran çekme aralığı ' +
                  saved.toString() +
                  ' dakika oldu.',
            ),
          ),
        );
      }

      await load();
    } catch (e) {
      if (mounted) {
        setState(() => savingInterval = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.toString())),
        );
      }
    }
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
    if (loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (error.isNotEmpty) {
      return ErrorPane(message: error, retry: load);
    }

    final run = data['last_run'] is Map
        ? Map<String, dynamic>.from(data['last_run'])
        : <String, dynamic>{};

    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        padding: const EdgeInsets.all(14),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const Icon(Icons.cloud_done_rounded, size: 42),
          const SizedBox(height: 6),
          const Center(
            child: Text(
              'Sunucu bağlı',
              style: TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(height: 14),
          Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 11, 12, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Oran çekme sıklığı',
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 3),
                  const Text(
                    'Bütün aktif takip maçları için geçerlidir. Manuel “Şimdi güncelle” her zaman ayrıca çalışır.',
                    style: TextStyle(
                      fontSize: 10,
                      color: Color(0xFFA7B0B8),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 7,
                    runSpacing: 7,
                    children: [
                      for (final minutes in const [15, 30, 45, 60])
                        ChoiceChip(
                          label: Text(
                            minutes.toString() + ' dk',
                            style: const TextStyle(fontSize: 11),
                          ),
                          selected: refreshMinutes == minutes,
                          onSelected: savingInterval
                              ? null
                              : (_) => saveInterval(minutes),
                        ),
                    ],
                  ),
                  if (savingInterval) ...[
                    const SizedBox(height: 8),
                    const LinearProgressIndicator(),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
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
).firstMatch(dateText);
    final tm = RegExp(r'^(\d{1,2}):(\d{2})  Future<void> load() async {
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
      final chosen = matches
          .where((m) => selected.contains(m['url']?.toString() ?? ''))
          .map((m) => {
                'url': m['url']?.toString() ?? '',
                'eventId': m['eventId']?.toString() ?? '',
                'name': m['name']?.toString() ?? '',
                'league': m['league']?.toString() ?? '',
                'date': iso(date),
                'time': m['time']?.toString() ?? '',
              })
          .toList();

      final d = await api.post('/api/follow', {'matches': chosen});
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

      matches.sort((a, b) {
        final ad = a['match_date']?.toString() ?? '9999-12-31';
        final bd = b['match_date']?.toString() ?? '9999-12-31';
        final dateCmp = ad.compareTo(bd);
        if (dateCmp != 0) return dateCmp;

        final at = a['kickoff_time']?.toString() ?? '99:99';
        final bt = b['kickoff_time']?.toString() ?? '99:99';
        return at.compareTo(bt);
      });
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

  String matchDateLabel(dynamic raw) {
    if (raw == null || raw.toString().isEmpty) return 'Tarih yok';
    final s = raw.toString();
    try {
      final p = s.substring(0, 10).split('-');
      return p[2] + '/' + p[1] + '/' + p[0];
    } catch (_) {
      return s;
    }
  }

  String trackedTitle(Map<String, dynamic> m) {
    final display = m['display_name']?.toString().trim() ?? '';
    if (display.isNotEmpty) return display;
    final slug = m['match_slug']?.toString() ?? m['event_id'].toString();
    return nice(slug);
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
                      trackedTitle(m),
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    subtitle: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          matchDateLabel(m['match_date']) +
                              '  ·  ' +
                              (m['kickoff_time']?.toString().isNotEmpty == true
                                  ? m['kickoff_time'].toString()
                                  : '--:--') +
                              (m['league']?.toString().isNotEmpty == true
                                  ? '  ·  ' + m['league'].toString()
                                  : ''),
                          style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Son oran: ' + shortStamp(m['last_capture']) +
                              '  ·  ' +
                              (m['capture_count']?.toString() ?? '0') +
                              ' tur',
                          style: const TextStyle(fontSize: 10),
                        ),
                      ],
                    ),
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => MatchDetail(
                          eventId: m['event_id'].toString(),
                          title: trackedTitle(m),
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
  String selectedMarket = 'MS';
  Map<String, dynamic> data = {};

  @override
  void initState() {
    super.initState();
    load();
  }

  bool get hasLatest {
    final rows = data['latest_rows'];
    return rows is List && rows.isNotEmpty;
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
      error = _friendlyError(e);
    }

    if (mounted) {
      setState(() => loading = false);

      if (error.isEmpty && !hasLatest && !autoRequested) {
        autoRequested = true;
        Future.microtask(() => refreshNow(auto: true));
      }
    }
  }

  String _friendlyError(Object e) {
    final s = e.toString();

    if (s.contains('SocketException') ||
        s.contains('connection abort') ||
        s.contains('Failed host lookup') ||
        s.contains('Connection reset')) {
      return 'Sunucu bağlantısı kısa süre kesildi. VPN açıksa kapatıp tekrar dene.';
    }

    return s.replaceFirst('Exception: ', '');
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

        try {
          newest = await api.get('/api/matches/' + widget.eventId);
        } catch (_) {
          continue;
        }

        final rows = newest['latest_rows'];
        final after = newest['latest_capture']?.toString();

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
              : 'Yeni kayıt henüz gelmedi. Çekim devam ediyor olabilir.';
        });

        if (!auto || changed) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(refreshMessage)),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          refreshing = false;
          refreshMessage = _friendlyError(e);
        });

        if (!auto) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(refreshMessage)),
          );
        }
      }
    }
  }

  String marketReport(
    List<Map<String, dynamic>> history,
    String market,
    List<ChartSeries> series,
  ) {
    if (history.length < 2) {
      return 'İlk kayıt oluştu. Hareket yorumu için en az iki çekim gerekiyor.';
    }

    final first = history.first;
    final last = history.last;
    final parts = <String>[];
    double strongestDrop = 0;
    String strongestLabel = '';

    for (final s in series) {
      final a = first[s.keyName];
      final b = last[s.keyName];

      if (a is! num || b is! num) continue;

      final start = a.toDouble();
      final end = b.toDouble();
      final diff = end - start;

      String move;
      if (diff.abs() < 0.005) {
        move = 'değişmedi';
      } else if (diff < 0) {
        move = start.toStringAsFixed(2) +
            '→' +
            end.toStringAsFixed(2) +
            ' düştü';
      } else {
        move = start.toStringAsFixed(2) +
            '→' +
            end.toStringAsFixed(2) +
            ' yükseldi';
      }

      parts.add(s.label + ' ' + move);

      if (diff < strongestDrop) {
        strongestDrop = diff;
        strongestLabel = s.label;
      }
    }

    String note = parts.join(' · ') + '.';

    if (strongestLabel.isNotEmpty) {
      if (market == 'MS') {
        final label = strongestLabel == '1'
            ? 'ev sahibi'
            : strongestLabel == '2'
                ? 'deplasman'
                : 'beraberlik';
        note +=
            ' En belirgin oran düşüşü ' + label + ' tarafında; piyasa fiyatlaması bu seçeneği önceye göre daha güçlü gösteriyor.';
      } else if (market.contains('Alt / Üst')) {
        note +=
            ' En belirgin sıkışma ' + strongestLabel + ' tarafında.';
      } else if (market.contains('KG')) {
        note +=
            ' En belirgin sıkışma ' + strongestLabel + ' tarafında.';
      }
    }

    return note;
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

    const msSeries = [
      ChartSeries('1', 'ms1', Color(0xFF69C8FF)),
      ChartSeries('X', 'msx', Color(0xFFFFC857)),
      ChartSeries('2', 'ms2', Color(0xFFFF8495)),
    ];

    const ou15Series = [
      ChartSeries('Alt', 'ou15_under', Color(0xFF69C8FF)),
      ChartSeries('Üst', 'ou15_over', Color(0xFF6DE0AA)),
    ];

    const ou25Series = [
      ChartSeries('Alt', 'ou25_under', Color(0xFF69C8FF)),
      ChartSeries('Üst', 'ou25_over', Color(0xFF6DE0AA)),
    ];

    const kgSeries = [
      ChartSeries('Yok', 'btts_no', Color(0xFFFF8495)),
      ChartSeries('Var', 'btts_yes', Color(0xFF6DE0AA)),
    ];

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
                    padding: const EdgeInsets.fromLTRB(10, 10, 10, 24),
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
                              refreshing
                                  ? 'Çekiliyor…'
                                  : 'Şimdi güncelle',
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
                            color: const Color(0xFF18201C),
                          ),
                          child: Text(
                            refreshMessage,
                            style: const TextStyle(fontSize: 11),
                          ),
                        ),
                      ],
                      const SizedBox(height: 12),
                      const Text(
                        'SON ORANLAR',
                        style: TextStyle(
                          fontSize: 13,
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
                      const SizedBox(height: 10),
                      const Text(
                        'ORAN HAREKETİ',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.0,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (final item in const [
                            ('MS', 'MS'),
                            ('1.5', '1.5'),
                            ('2.5', '2.5'),
                            ('KG', 'KG'),
                          ])
                            ChoiceChip(
                              label: Text(
                                item.$1,
                                style: const TextStyle(fontSize: 11),
                              ),
                              selected: selectedMarket == item.$2,
                              onSelected: (_) {
                                setState(() => selectedMarket = item.$2);
                              },
                            ),
                        ],
                      ),
                      const SizedBox(height: 7),
                      if (selectedMarket == 'MS')
                        MarketSection(
                          title: 'MS 1 / X / 2',
                          marketCode: 'MS',
                          bookmaker: historyBookmaker,
                          history: history,
                          series: msSeries,
                          report: marketReport(history, 'MS', msSeries),
                        )
                      else if (selectedMarket == '1.5')
                        MarketSection(
                          title: '1.5 Alt / Üst',
                          marketCode: '1.5 Alt / Üst',
                          bookmaker: historyBookmaker,
                          history: history,
                          series: ou15Series,
                          report: marketReport(
                            history,
                            '1.5 Alt / Üst',
                            ou15Series,
                          ),
                        )
                      else if (selectedMarket == '2.5')
                        MarketSection(
                          title: '2.5 Alt / Üst',
                          marketCode: '2.5 Alt / Üst',
                          bookmaker: historyBookmaker,
                          history: history,
                          series: ou25Series,
                          report: marketReport(
                            history,
                            '2.5 Alt / Üst',
                            ou25Series,
                          ),
                        )
                      else
                        MarketSection(
                          title: 'KG Yok / Var',
                          marketCode: 'KG Yok / Var',
                          bookmaker: historyBookmaker,
                          history: history,
                          series: kgSeries,
                          report: marketReport(
                            history,
                            'KG Yok / Var',
                            kgSeries,
                          ),
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

  String odd(dynamic value) {
    if (value == null) return '-';
    return value is num ? value.toStringAsFixed(2) : value.toString();
  }

  Widget valueBox(String text) {
    return Expanded(
      child: Container(
        margin: const EdgeInsets.only(left: 4),
        padding: const EdgeInsets.symmetric(vertical: 6),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: const Color(0xFF2A322E),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(
          text,
          style: const TextStyle(
            fontSize: 12,
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
            width: 82,
            child: Text(
              label,
              style: const TextStyle(fontSize: 11),
            ),
          ),
          for (final value in values) valueBox(odd(value)),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 7),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              row['bookmaker']?.toString() ?? 'Bookmaker',
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w800,
              ),
            ),
            const Divider(height: 14),
            line('MS 1/X/2', [
              row['ms1'],
              row['msx'],
              row['ms2'],
            ]),
            line('1.5 Alt/Üst', [
              row['ou15_under'],
              row['ou15_over'],
            ]),
            line('2.5 Alt/Üst', [
              row['ou25_under'],
              row['ou25_over'],
            ]),
            line('KG Yok/Var', [
              row['btts_no'],
              row['btts_yes'],
            ]),
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

class MarketSection extends StatelessWidget {
  final String title;
  final String marketCode;
  final String bookmaker;
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;
  final String report;

  const MarketSection({
    super.key,
    required this.title,
    required this.marketCode,
    required this.bookmaker,
    required this.history,
    required this.series,
    required this.report,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              'Bookmaker: ' + bookmaker,
              style: const TextStyle(
                fontSize: 10,
                color: Color(0xFF9DA8A2),
              ),
            ),
            const SizedBox(height: 9),
            CombinedMarketChart(
              history: history,
              series: series,
            ),
            const SizedBox(height: 5),
            Theme(
              data: Theme.of(context).copyWith(
                dividerColor: Colors.transparent,
              ),
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                childrenPadding: EdgeInsets.zero,
                dense: true,
                title: Text(
                  'Geçmiş oranlar · ' +
                      history.length.toString() +
                      ' kayıt',
                  style: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                subtitle: const Text(
                  'Tarih / saat / dakika',
                  style: TextStyle(fontSize: 9),
                ),
                children: [
                  CombinedHistoryTable(
                    history: history,
                    series: series,
                  ),
                ],
              ),
            ),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: const Color(0xFF151C19),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'KISA RAPOR',
                    style: TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.6,
                      color: Color(0xFF8CDAB8),
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    report,
                    style: const TextStyle(
                      fontSize: 10,
                      height: 1.35,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class CombinedMarketChart extends StatefulWidget {
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;

  const CombinedMarketChart({
    super.key,
    required this.history,
    required this.series,
  });

  @override
  State<CombinedMarketChart> createState() =>
      _CombinedMarketChartState();
}

class _CombinedMarketChartState
    extends State<CombinedMarketChart> {
  int? selectedIndex;

  List<Map<String, dynamic>> get rows {
    return widget.history.where((row) {
      return widget.series.any(
        (s) => row[s.keyName] is num,
      );
    }).toList();
  }

  String stamp(dynamic raw) {
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
      return '--/--/---- --:--';
    }
  }

  String odd(dynamic raw) {
    if (raw is num) return raw.toDouble().toStringAsFixed(2);
    return '-';
  }

  void selectNearest(Offset position, double width) {
    final data = rows;
    if (data.isEmpty) return;

    const left = 18.0;
    const right = 8.0;
    final plotWidth = math.max(1.0, width - left - right);

    int index = 0;
    if (data.length > 1) {
      final ratio =
          ((position.dx - left) / plotWidth).clamp(0.0, 1.0);
      index = (ratio * (data.length - 1)).round();
    }

    setState(() => selectedIndex = index);
  }

  @override
  Widget build(BuildContext context) {
    final data = rows;
    final latest =
        data.isEmpty ? null : data.last;

    final selected = selectedIndex != null &&
            selectedIndex! >= 0 &&
            selectedIndex! < data.length
        ? data[selectedIndex!]
        : null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (latest != null)
          Row(
            children: [
              for (final s in widget.series)
                Expanded(
                  child: Container(
                    margin: const EdgeInsets.only(right: 4),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 5,
                      vertical: 7,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0xFF101619),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Column(
                      children: [
                        Row(
                          mainAxisAlignment:
                              MainAxisAlignment.center,
                          children: [
                            Container(
                              width: 7,
                              height: 7,
                              decoration: BoxDecoration(
                                color: s.color,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              s.label,
                              style: const TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          odd(latest[s.keyName]),
                          style: const TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        const SizedBox(height: 8),
        if (data.length < 2)
          Container(
            height: 155,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: const Color(0xFF0D1215),
              borderRadius: BorderRadius.circular(9),
            ),
            child: const Text(
              'Grafik için ikinci kayıt bekleniyor.',
              style: TextStyle(fontSize: 11),
            ),
          )
        else
          LayoutBuilder(
            builder: (context, constraints) {
              return GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapDown: (details) => selectNearest(
                  details.localPosition,
                  constraints.maxWidth,
                ),
                onHorizontalDragUpdate: (details) =>
                    selectNearest(
                  details.localPosition,
                  constraints.maxWidth,
                ),
                child: CustomPaint(
                  size: Size(
                    constraints.maxWidth,
                    185,
                  ),
                  painter: CombinedMarketPainter(
                    history: data,
                    series: widget.series,
                    selectedIndex: selectedIndex,
                  ),
                ),
              );
            },
          ),
        if (selected != null) ...[
          const SizedBox(height: 5),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(
              horizontal: 9,
              vertical: 7,
            ),
            decoration: BoxDecoration(
              color: const Color(0xFF18211D),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  stamp(selected['captured_at']),
                  style: const TextStyle(
                    fontSize: 9,
                    color: Color(0xFFAEB8B3),
                  ),
                ),
                const SizedBox(height: 5),
                Row(
                  children: [
                    for (final s in widget.series)
                      Expanded(
                        child: Row(
                          mainAxisAlignment:
                              MainAxisAlignment.center,
                          children: [
                            Container(
                              width: 7,
                              height: 7,
                              decoration: BoxDecoration(
                                color: s.color,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              s.label +
                                  ' ' +
                                  odd(selected[s.keyName]),
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
              ],
            ),
          ),
        ] else
          const Padding(
            padding: EdgeInsets.only(top: 4),
            child: Text(
              'Grafikte bir noktaya dokun: o dakikanın gerçek oranlarını göster.',
              style: TextStyle(
                fontSize: 9,
                color: Color(0xFF8F9994),
              ),
            ),
          ),
      ],
    );
  }
}

class CombinedHistoryTable extends StatelessWidget {
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;

  const CombinedHistoryTable({
    super.key,
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

  String odd(dynamic raw) {
    if (raw is num) return raw.toDouble().toStringAsFixed(2);
    return '-';
  }

  @override
  Widget build(BuildContext context) {
    if (history.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(10),
        child: Text(
          'Henüz geçmiş kayıt yok.',
          style: TextStyle(fontSize: 10),
        ),
      );
    }

    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(vertical: 6),
          decoration: const BoxDecoration(
            border: Border(
              bottom: BorderSide(
                color: Color(0xFF39413E),
              ),
            ),
          ),
          child: Row(
            children: [
              const SizedBox(
                width: 88,
                child: Text(
                  'Tarih / Saat',
                  style: TextStyle(
                    fontSize: 9,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              for (final s in series)
                Expanded(
                  child: Text(
                    s.label,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
            ],
          ),
        ),
        for (int i = history.length - 1; i >= 0; i--)
          Container(
            padding: const EdgeInsets.symmetric(vertical: 7),
            decoration: const BoxDecoration(
              border: Border(
                bottom: BorderSide(
                  color: Color(0xFF29312E),
                ),
              ),
            ),
            child: Row(
              children: [
                SizedBox(
                  width: 88,
                  child: Text(
                    when(history[i]['captured_at']),
                    style: const TextStyle(
                      fontSize: 8.5,
                    ),
                  ),
                ),
                for (final s in series)
                  Expanded(
                    child: Builder(
                      builder: (context) {
                        final raw = history[i][s.keyName];
                        final current =
                            raw is num ? raw.toDouble() : null;

                        String arrow = '→';
                        Color arrowColor =
                            const Color(0xFF98A39D);

                        if (i > 0 && current != null) {
                          final prevRaw =
                              history[i - 1][s.keyName];

                          if (prevRaw is num) {
                            final previous =
                                prevRaw.toDouble();

                            if (current <
                                previous - 0.0001) {
                              arrow = '↓';
                              arrowColor =
                                  const Color(0xFFFF8495);
                            } else if (current >
                                previous + 0.0001) {
                              arrow = '↑';
                              arrowColor =
                                  const Color(0xFF6DE0AA);
                            }
                          }
                        }

                        return Row(
                          mainAxisAlignment:
                              MainAxisAlignment.center,
                          children: [
                            Text(
                              current == null
                                  ? '-'
                                  : current
                                      .toStringAsFixed(2),
                              style: const TextStyle(
                                fontSize: 10,
                                fontWeight:
                                    FontWeight.w700,
                              ),
                            ),
                            const SizedBox(width: 3),
                            Text(
                              arrow,
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight:
                                    FontWeight.w900,
                                color: arrowColor,
                              ),
                            ),
                          ],
                        );
                      },
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class CombinedMarketPainter extends CustomPainter {
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;
  final int? selectedIndex;

  CombinedMarketPainter({
    required this.history,
    required this.series,
    this.selectedIndex,
  });

  @override
  void paint(Canvas canvas, Size size) {
    const left = 18.0;
    const top = 10.0;
    const right = 8.0;
    const bottom = 28.0;

    final plot = Rect.fromLTRB(
      left,
      top,
      size.width - right,
      size.height - bottom,
    );

    final gridPaint = Paint()
      ..color = const Color(0xFF2B3338)
      ..strokeWidth = 1;

    for (int i = 0; i <= 4; i++) {
      final y = plot.top + plot.height * i / 4;
      canvas.drawLine(
        Offset(plot.left, y),
        Offset(plot.right, y),
        gridPaint,
      );
    }

    final n = history.length;

    double xFor(int i) {
      if (n <= 1) return plot.left;
      return plot.left +
          (plot.width * i / (n - 1));
    }

    for (final s in series) {
      final values = <double>[];
      for (final row in history) {
        final raw = row[s.keyName];
        if (raw is num) values.add(raw.toDouble());
      }

      if (values.isEmpty) continue;

      double minV = values.reduce(math.min);
      double maxV = values.reduce(math.max);
      final range = maxV - minV;

      if (range.abs() < 0.0001) {
        final pad =
            math.max(maxV.abs() * 0.01, 0.03);
        minV -= pad;
        maxV += pad;
      } else {
        final pad = math.max(range * 0.35, 0.01);
        minV -= pad;
        maxV += pad;
      }

      double yFor(double value) {
        return plot.bottom -
            ((value - minV) /
                    (maxV - minV)) *
                plot.height;
      }

      final path = Path();
      final linePaint = Paint()
        ..color = s.color
        ..strokeWidth = 2.7
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..style = PaintingStyle.stroke;

      final pointPaint = Paint()
        ..color = s.color
        ..style = PaintingStyle.fill;

      bool started = false;

      for (int i = 0; i < n; i++) {
        final raw = history[i][s.keyName];
        if (raw is! num) continue;

        final point = Offset(
          xFor(i),
          yFor(raw.toDouble()),
        );

        if (!started) {
          path.moveTo(point.dx, point.dy);
          started = true;
        } else {
          path.lineTo(point.dx, point.dy);
        }

        canvas.drawCircle(
          point,
          selectedIndex == i ? 5.2 : 3.4,
          pointPaint,
        );
      }

      if (started) {
        canvas.drawPath(path, linePaint);
      }
    }

    if (selectedIndex != null &&
        selectedIndex! >= 0 &&
        selectedIndex! < n) {
      final x = xFor(selectedIndex!);

      canvas.drawLine(
        Offset(x, plot.top),
        Offset(x, plot.bottom),
        Paint()
          ..color =
              const Color(0xFF8FA09A)
                  .withValues(alpha: 0.35)
          ..strokeWidth = 1,
      );
    }

    final labelIndexes = <int>{
      0,
      if (n > 2) n ~/ 2,
      if (n > 1) n - 1,
    };

    for (final i in labelIndexes) {
      if (i < 0 || i >= n) continue;

      String label = '--:--';
      try {
        final dt = DateTime.parse(
          history[i]['captured_at'].toString(),
        ).toLocal();
        label =
            dt.hour.toString().padLeft(2, '0') +
                ':' +
                dt.minute
                    .toString()
                    .padLeft(2, '0');
      } catch (_) {}

      _centerText(
        canvas,
        label,
        Offset(
          xFor(i),
          plot.bottom + 8,
        ),
        const TextStyle(
          color: Color(0xFFA0AAA5),
          fontSize: 8,
          fontWeight: FontWeight.w600,
        ),
      );
    }
  }

  void _centerText(
    Canvas canvas,
    String text,
    Offset center,
    TextStyle style,
  ) {
    final tp = TextPainter(
      text: TextSpan(
        text: text,
        style: style,
      ),
      textDirection: TextDirection.ltr,
    )..layout();

    tp.paint(
      canvas,
      Offset(
        center.dx - tp.width / 2,
        center.dy,
      ),
    );
  }

  @override
  bool shouldRepaint(
    covariant CombinedMarketPainter oldDelegate,
  ) {
    return oldDelegate.selectedIndex !=
            selectedIndex ||
        oldDelegate.history != history ||
        oldDelegate.series != series;
  }
}

class SystemPage extends StatefulWidget {
  const SystemPage({super.key});

  @override
  State<SystemPage> createState() => _SystemPageState();
}

class _SystemPageState extends State<SystemPage> {
  bool loading = true;
  bool savingInterval = false;
  String error = '';
  Map<String, dynamic> data = {};
  int refreshMinutes = 60;

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
      refreshMinutes =
          (data['refresh_minutes'] as num?)?.toInt() ?? 60;
    } catch (e) {
      error = e.toString();
    }

    if (mounted) setState(() => loading = false);
  }

  Future<void> saveInterval(int minutes) async {
    if (savingInterval || minutes == refreshMinutes) return;

    setState(() => savingInterval = true);

    try {
      final d = await api.post(
        '/api/settings/refresh-interval',
        {'minutes': minutes},
      );

      final saved =
          (d['refresh_minutes'] as num?)?.toInt() ?? minutes;

      if (mounted) {
        setState(() {
          refreshMinutes = saved;
          savingInterval = false;
        });

        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'Oran çekme aralığı ' +
                  saved.toString() +
                  ' dakika oldu.',
            ),
          ),
        );
      }

      await load();
    } catch (e) {
      if (mounted) {
        setState(() => savingInterval = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.toString())),
        );
      }
    }
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
    if (loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (error.isNotEmpty) {
      return ErrorPane(message: error, retry: load);
    }

    final run = data['last_run'] is Map
        ? Map<String, dynamic>.from(data['last_run'])
        : <String, dynamic>{};

    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        padding: const EdgeInsets.all(14),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const Icon(Icons.cloud_done_rounded, size: 42),
          const SizedBox(height: 6),
          const Center(
            child: Text(
              'Sunucu bağlı',
              style: TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(height: 14),
          Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 11, 12, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Oran çekme sıklığı',
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 3),
                  const Text(
                    'Bütün aktif takip maçları için geçerlidir. Manuel “Şimdi güncelle” her zaman ayrıca çalışır.',
                    style: TextStyle(
                      fontSize: 10,
                      color: Color(0xFFA7B0B8),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 7,
                    runSpacing: 7,
                    children: [
                      for (final minutes in const [15, 30, 45, 60])
                        ChoiceChip(
                          label: Text(
                            minutes.toString() + ' dk',
                            style: const TextStyle(fontSize: 11),
                          ),
                          selected: refreshMinutes == minutes,
                          onSelected: savingInterval
                              ? null
                              : (_) => saveInterval(minutes),
                        ),
                    ],
                  ),
                  if (savingInterval) ...[
                    const SizedBox(height: 8),
                    const LinearProgressIndicator(),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
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
).firstMatch(time);
    if (match == null || tm == null) return false;

    final kickoff = DateTime(
      int.parse(match.group(1)!),
      int.parse(match.group(2)!),
      int.parse(match.group(3)!),
      int.parse(tm.group(1)!),
      int.parse(tm.group(2)!),
    );
    return !DateTime.now().isBefore(kickoff);
  }

  String bulletinStatus(Map<String, dynamic> m) {
    final score = m['score']?.toString();
    final status = m['status']?.toString().toLowerCase() ?? '';
    final time = m['time']?.toString().trim() ?? '';

    if (status == 'finished' ||
        const {'FIN', 'FT', 'AET', 'PEN'}.contains(time.toUpperCase())) {
      return score != null && score.isNotEmpty ? 'Bitti · $score' : 'Bitti';
    }

    if (bulletinLocked(m)) return 'Başladı · oran takibi kilitli';
    return time.isEmpty ? '--:--' : time;
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
      final chosen = matches
          .where((m) => selected.contains(m['url']?.toString() ?? ''))
          .map((m) => {
                'url': m['url']?.toString() ?? '',
                'eventId': m['eventId']?.toString() ?? '',
                'name': m['name']?.toString() ?? '',
                'league': m['league']?.toString() ?? '',
                'date': iso(date),
                'time': m['time']?.toString() ?? '',
              })
          .toList();

      final d = await api.post('/api/follow', {'matches': chosen});
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

      matches.sort((a, b) {
        final ad = a['match_date']?.toString() ?? '9999-12-31';
        final bd = b['match_date']?.toString() ?? '9999-12-31';
        final dateCmp = ad.compareTo(bd);
        if (dateCmp != 0) return dateCmp;

        final at = a['kickoff_time']?.toString() ?? '99:99';
        final bt = b['kickoff_time']?.toString() ?? '99:99';
        return at.compareTo(bt);
      });
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

  String matchDateLabel(dynamic raw) {
    if (raw == null || raw.toString().isEmpty) return 'Tarih yok';
    final s = raw.toString();
    try {
      final p = s.substring(0, 10).split('-');
      return p[2] + '/' + p[1] + '/' + p[0];
    } catch (_) {
      return s;
    }
  }

  String trackedTitle(Map<String, dynamic> m) {
    final display = m['display_name']?.toString().trim() ?? '';
    if (display.isNotEmpty) return display;
    final slug = m['match_slug']?.toString() ?? m['event_id'].toString();
    return nice(slug);
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
                      trackedTitle(m),
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    subtitle: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          matchDateLabel(m['match_date']) +
                              '  ·  ' +
                              (m['kickoff_time']?.toString().isNotEmpty == true
                                  ? m['kickoff_time'].toString()
                                  : '--:--') +
                              (m['league']?.toString().isNotEmpty == true
                                  ? '  ·  ' + m['league'].toString()
                                  : ''),
                          style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Son oran: ' + shortStamp(m['last_capture']) +
                              '  ·  ' +
                              (m['capture_count']?.toString() ?? '0') +
                              ' tur',
                          style: const TextStyle(fontSize: 10),
                        ),
                      ],
                    ),
                    onTap: () => Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => MatchDetail(
                          eventId: m['event_id'].toString(),
                          title: trackedTitle(m),
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
  String selectedMarket = 'MS';
  Map<String, dynamic> data = {};

  @override
  void initState() {
    super.initState();
    load();
  }

  bool get hasLatest {
    final rows = data['latest_rows'];
    return rows is List && rows.isNotEmpty;
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
      error = _friendlyError(e);
    }

    if (mounted) {
      setState(() => loading = false);

      if (error.isEmpty && !hasLatest && !autoRequested) {
        autoRequested = true;
        Future.microtask(() => refreshNow(auto: true));
      }
    }
  }

  String _friendlyError(Object e) {
    final s = e.toString();

    if (s.contains('SocketException') ||
        s.contains('connection abort') ||
        s.contains('Failed host lookup') ||
        s.contains('Connection reset')) {
      return 'Sunucu bağlantısı kısa süre kesildi. VPN açıksa kapatıp tekrar dene.';
    }

    return s.replaceFirst('Exception: ', '');
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

        try {
          newest = await api.get('/api/matches/' + widget.eventId);
        } catch (_) {
          continue;
        }

        final rows = newest['latest_rows'];
        final after = newest['latest_capture']?.toString();

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
              : 'Yeni kayıt henüz gelmedi. Çekim devam ediyor olabilir.';
        });

        if (!auto || changed) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(refreshMessage)),
          );
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          refreshing = false;
          refreshMessage = _friendlyError(e);
        });

        if (!auto) {
          ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(refreshMessage)),
          );
        }
      }
    }
  }

  String marketReport(
    List<Map<String, dynamic>> history,
    String market,
    List<ChartSeries> series,
  ) {
    if (history.length < 2) {
      return 'İlk kayıt oluştu. Hareket yorumu için en az iki çekim gerekiyor.';
    }

    final first = history.first;
    final last = history.last;
    final parts = <String>[];
    double strongestDrop = 0;
    String strongestLabel = '';

    for (final s in series) {
      final a = first[s.keyName];
      final b = last[s.keyName];

      if (a is! num || b is! num) continue;

      final start = a.toDouble();
      final end = b.toDouble();
      final diff = end - start;

      String move;
      if (diff.abs() < 0.005) {
        move = 'değişmedi';
      } else if (diff < 0) {
        move = start.toStringAsFixed(2) +
            '→' +
            end.toStringAsFixed(2) +
            ' düştü';
      } else {
        move = start.toStringAsFixed(2) +
            '→' +
            end.toStringAsFixed(2) +
            ' yükseldi';
      }

      parts.add(s.label + ' ' + move);

      if (diff < strongestDrop) {
        strongestDrop = diff;
        strongestLabel = s.label;
      }
    }

    String note = parts.join(' · ') + '.';

    if (strongestLabel.isNotEmpty) {
      if (market == 'MS') {
        final label = strongestLabel == '1'
            ? 'ev sahibi'
            : strongestLabel == '2'
                ? 'deplasman'
                : 'beraberlik';
        note +=
            ' En belirgin oran düşüşü ' + label + ' tarafında; piyasa fiyatlaması bu seçeneği önceye göre daha güçlü gösteriyor.';
      } else if (market.contains('Alt / Üst')) {
        note +=
            ' En belirgin sıkışma ' + strongestLabel + ' tarafında.';
      } else if (market.contains('KG')) {
        note +=
            ' En belirgin sıkışma ' + strongestLabel + ' tarafında.';
      }
    }

    return note;
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

    const msSeries = [
      ChartSeries('1', 'ms1', Color(0xFF69C8FF)),
      ChartSeries('X', 'msx', Color(0xFFFFC857)),
      ChartSeries('2', 'ms2', Color(0xFFFF8495)),
    ];

    const ou15Series = [
      ChartSeries('Alt', 'ou15_under', Color(0xFF69C8FF)),
      ChartSeries('Üst', 'ou15_over', Color(0xFF6DE0AA)),
    ];

    const ou25Series = [
      ChartSeries('Alt', 'ou25_under', Color(0xFF69C8FF)),
      ChartSeries('Üst', 'ou25_over', Color(0xFF6DE0AA)),
    ];

    const kgSeries = [
      ChartSeries('Yok', 'btts_no', Color(0xFFFF8495)),
      ChartSeries('Var', 'btts_yes', Color(0xFF6DE0AA)),
    ];

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
                    padding: const EdgeInsets.fromLTRB(10, 10, 10, 24),
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
                              refreshing
                                  ? 'Çekiliyor…'
                                  : 'Şimdi güncelle',
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
                            color: const Color(0xFF18201C),
                          ),
                          child: Text(
                            refreshMessage,
                            style: const TextStyle(fontSize: 11),
                          ),
                        ),
                      ],
                      const SizedBox(height: 12),
                      const Text(
                        'SON ORANLAR',
                        style: TextStyle(
                          fontSize: 13,
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
                      const SizedBox(height: 10),
                      const Text(
                        'ORAN HAREKETİ',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.0,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (final item in const [
                            ('MS', 'MS'),
                            ('1.5', '1.5'),
                            ('2.5', '2.5'),
                            ('KG', 'KG'),
                          ])
                            ChoiceChip(
                              label: Text(
                                item.$1,
                                style: const TextStyle(fontSize: 11),
                              ),
                              selected: selectedMarket == item.$2,
                              onSelected: (_) {
                                setState(() => selectedMarket = item.$2);
                              },
                            ),
                        ],
                      ),
                      const SizedBox(height: 7),
                      if (selectedMarket == 'MS')
                        MarketSection(
                          title: 'MS 1 / X / 2',
                          marketCode: 'MS',
                          bookmaker: historyBookmaker,
                          history: history,
                          series: msSeries,
                          report: marketReport(history, 'MS', msSeries),
                        )
                      else if (selectedMarket == '1.5')
                        MarketSection(
                          title: '1.5 Alt / Üst',
                          marketCode: '1.5 Alt / Üst',
                          bookmaker: historyBookmaker,
                          history: history,
                          series: ou15Series,
                          report: marketReport(
                            history,
                            '1.5 Alt / Üst',
                            ou15Series,
                          ),
                        )
                      else if (selectedMarket == '2.5')
                        MarketSection(
                          title: '2.5 Alt / Üst',
                          marketCode: '2.5 Alt / Üst',
                          bookmaker: historyBookmaker,
                          history: history,
                          series: ou25Series,
                          report: marketReport(
                            history,
                            '2.5 Alt / Üst',
                            ou25Series,
                          ),
                        )
                      else
                        MarketSection(
                          title: 'KG Yok / Var',
                          marketCode: 'KG Yok / Var',
                          bookmaker: historyBookmaker,
                          history: history,
                          series: kgSeries,
                          report: marketReport(
                            history,
                            'KG Yok / Var',
                            kgSeries,
                          ),
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

  String odd(dynamic value) {
    if (value == null) return '-';
    return value is num ? value.toStringAsFixed(2) : value.toString();
  }

  Widget valueBox(String text) {
    return Expanded(
      child: Container(
        margin: const EdgeInsets.only(left: 4),
        padding: const EdgeInsets.symmetric(vertical: 6),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: const Color(0xFF2A322E),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Text(
          text,
          style: const TextStyle(
            fontSize: 12,
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
            width: 82,
            child: Text(
              label,
              style: const TextStyle(fontSize: 11),
            ),
          ),
          for (final value in values) valueBox(odd(value)),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 7),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              row['bookmaker']?.toString() ?? 'Bookmaker',
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w800,
              ),
            ),
            const Divider(height: 14),
            line('MS 1/X/2', [
              row['ms1'],
              row['msx'],
              row['ms2'],
            ]),
            line('1.5 Alt/Üst', [
              row['ou15_under'],
              row['ou15_over'],
            ]),
            line('2.5 Alt/Üst', [
              row['ou25_under'],
              row['ou25_over'],
            ]),
            line('KG Yok/Var', [
              row['btts_no'],
              row['btts_yes'],
            ]),
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

class MarketSection extends StatelessWidget {
  final String title;
  final String marketCode;
  final String bookmaker;
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;
  final String report;

  const MarketSection({
    super.key,
    required this.title,
    required this.marketCode,
    required this.bookmaker,
    required this.history,
    required this.series,
    required this.report,
  });

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: 2),
            Text(
              'Bookmaker: ' + bookmaker,
              style: const TextStyle(
                fontSize: 10,
                color: Color(0xFF9DA8A2),
              ),
            ),
            const SizedBox(height: 9),
            CombinedMarketChart(
              history: history,
              series: series,
            ),
            const SizedBox(height: 5),
            Theme(
              data: Theme.of(context).copyWith(
                dividerColor: Colors.transparent,
              ),
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                childrenPadding: EdgeInsets.zero,
                dense: true,
                title: Text(
                  'Geçmiş oranlar · ' +
                      history.length.toString() +
                      ' kayıt',
                  style: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                subtitle: const Text(
                  'Tarih / saat / dakika',
                  style: TextStyle(fontSize: 9),
                ),
                children: [
                  CombinedHistoryTable(
                    history: history,
                    series: series,
                  ),
                ],
              ),
            ),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: const Color(0xFF151C19),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'KISA RAPOR',
                    style: TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 0.6,
                      color: Color(0xFF8CDAB8),
                    ),
                  ),
                  const SizedBox(height: 3),
                  Text(
                    report,
                    style: const TextStyle(
                      fontSize: 10,
                      height: 1.35,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class CombinedMarketChart extends StatefulWidget {
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;

  const CombinedMarketChart({
    super.key,
    required this.history,
    required this.series,
  });

  @override
  State<CombinedMarketChart> createState() =>
      _CombinedMarketChartState();
}

class _CombinedMarketChartState
    extends State<CombinedMarketChart> {
  int? selectedIndex;

  List<Map<String, dynamic>> get rows {
    return widget.history.where((row) {
      return widget.series.any(
        (s) => row[s.keyName] is num,
      );
    }).toList();
  }

  String stamp(dynamic raw) {
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
      return '--/--/---- --:--';
    }
  }

  String odd(dynamic raw) {
    if (raw is num) return raw.toDouble().toStringAsFixed(2);
    return '-';
  }

  void selectNearest(Offset position, double width) {
    final data = rows;
    if (data.isEmpty) return;

    const left = 18.0;
    const right = 8.0;
    final plotWidth = math.max(1.0, width - left - right);

    int index = 0;
    if (data.length > 1) {
      final ratio =
          ((position.dx - left) / plotWidth).clamp(0.0, 1.0);
      index = (ratio * (data.length - 1)).round();
    }

    setState(() => selectedIndex = index);
  }

  @override
  Widget build(BuildContext context) {
    final data = rows;
    final latest =
        data.isEmpty ? null : data.last;

    final selected = selectedIndex != null &&
            selectedIndex! >= 0 &&
            selectedIndex! < data.length
        ? data[selectedIndex!]
        : null;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (latest != null)
          Row(
            children: [
              for (final s in widget.series)
                Expanded(
                  child: Container(
                    margin: const EdgeInsets.only(right: 4),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 5,
                      vertical: 7,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0xFF101619),
                      borderRadius: BorderRadius.circular(8),
                    ),
                    child: Column(
                      children: [
                        Row(
                          mainAxisAlignment:
                              MainAxisAlignment.center,
                          children: [
                            Container(
                              width: 7,
                              height: 7,
                              decoration: BoxDecoration(
                                color: s.color,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              s.label,
                              style: const TextStyle(
                                fontSize: 10,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          odd(latest[s.keyName]),
                          style: const TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w900,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
            ],
          ),
        const SizedBox(height: 8),
        if (data.length < 2)
          Container(
            height: 155,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: const Color(0xFF0D1215),
              borderRadius: BorderRadius.circular(9),
            ),
            child: const Text(
              'Grafik için ikinci kayıt bekleniyor.',
              style: TextStyle(fontSize: 11),
            ),
          )
        else
          LayoutBuilder(
            builder: (context, constraints) {
              return GestureDetector(
                behavior: HitTestBehavior.opaque,
                onTapDown: (details) => selectNearest(
                  details.localPosition,
                  constraints.maxWidth,
                ),
                onHorizontalDragUpdate: (details) =>
                    selectNearest(
                  details.localPosition,
                  constraints.maxWidth,
                ),
                child: CustomPaint(
                  size: Size(
                    constraints.maxWidth,
                    185,
                  ),
                  painter: CombinedMarketPainter(
                    history: data,
                    series: widget.series,
                    selectedIndex: selectedIndex,
                  ),
                ),
              );
            },
          ),
        if (selected != null) ...[
          const SizedBox(height: 5),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(
              horizontal: 9,
              vertical: 7,
            ),
            decoration: BoxDecoration(
              color: const Color(0xFF18211D),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  stamp(selected['captured_at']),
                  style: const TextStyle(
                    fontSize: 9,
                    color: Color(0xFFAEB8B3),
                  ),
                ),
                const SizedBox(height: 5),
                Row(
                  children: [
                    for (final s in widget.series)
                      Expanded(
                        child: Row(
                          mainAxisAlignment:
                              MainAxisAlignment.center,
                          children: [
                            Container(
                              width: 7,
                              height: 7,
                              decoration: BoxDecoration(
                                color: s.color,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              s.label +
                                  ' ' +
                                  odd(selected[s.keyName]),
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
              ],
            ),
          ),
        ] else
          const Padding(
            padding: EdgeInsets.only(top: 4),
            child: Text(
              'Grafikte bir noktaya dokun: o dakikanın gerçek oranlarını göster.',
              style: TextStyle(
                fontSize: 9,
                color: Color(0xFF8F9994),
              ),
            ),
          ),
      ],
    );
  }
}

class CombinedHistoryTable extends StatelessWidget {
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;

  const CombinedHistoryTable({
    super.key,
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

  String odd(dynamic raw) {
    if (raw is num) return raw.toDouble().toStringAsFixed(2);
    return '-';
  }

  @override
  Widget build(BuildContext context) {
    if (history.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(10),
        child: Text(
          'Henüz geçmiş kayıt yok.',
          style: TextStyle(fontSize: 10),
        ),
      );
    }

    return Column(
      children: [
        Container(
          padding: const EdgeInsets.symmetric(vertical: 6),
          decoration: const BoxDecoration(
            border: Border(
              bottom: BorderSide(
                color: Color(0xFF39413E),
              ),
            ),
          ),
          child: Row(
            children: [
              const SizedBox(
                width: 88,
                child: Text(
                  'Tarih / Saat',
                  style: TextStyle(
                    fontSize: 9,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              for (final s in series)
                Expanded(
                  child: Text(
                    s.label,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
            ],
          ),
        ),
        for (int i = history.length - 1; i >= 0; i--)
          Container(
            padding: const EdgeInsets.symmetric(vertical: 7),
            decoration: const BoxDecoration(
              border: Border(
                bottom: BorderSide(
                  color: Color(0xFF29312E),
                ),
              ),
            ),
            child: Row(
              children: [
                SizedBox(
                  width: 88,
                  child: Text(
                    when(history[i]['captured_at']),
                    style: const TextStyle(
                      fontSize: 8.5,
                    ),
                  ),
                ),
                for (final s in series)
                  Expanded(
                    child: Builder(
                      builder: (context) {
                        final raw = history[i][s.keyName];
                        final current =
                            raw is num ? raw.toDouble() : null;

                        String arrow = '→';
                        Color arrowColor =
                            const Color(0xFF98A39D);

                        if (i > 0 && current != null) {
                          final prevRaw =
                              history[i - 1][s.keyName];

                          if (prevRaw is num) {
                            final previous =
                                prevRaw.toDouble();

                            if (current <
                                previous - 0.0001) {
                              arrow = '↓';
                              arrowColor =
                                  const Color(0xFFFF8495);
                            } else if (current >
                                previous + 0.0001) {
                              arrow = '↑';
                              arrowColor =
                                  const Color(0xFF6DE0AA);
                            }
                          }
                        }

                        return Row(
                          mainAxisAlignment:
                              MainAxisAlignment.center,
                          children: [
                            Text(
                              current == null
                                  ? '-'
                                  : current
                                      .toStringAsFixed(2),
                              style: const TextStyle(
                                fontSize: 10,
                                fontWeight:
                                    FontWeight.w700,
                              ),
                            ),
                            const SizedBox(width: 3),
                            Text(
                              arrow,
                              style: TextStyle(
                                fontSize: 10,
                                fontWeight:
                                    FontWeight.w900,
                                color: arrowColor,
                              ),
                            ),
                          ],
                        );
                      },
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class CombinedMarketPainter extends CustomPainter {
  final List<Map<String, dynamic>> history;
  final List<ChartSeries> series;
  final int? selectedIndex;

  CombinedMarketPainter({
    required this.history,
    required this.series,
    this.selectedIndex,
  });

  @override
  void paint(Canvas canvas, Size size) {
    const left = 18.0;
    const top = 10.0;
    const right = 8.0;
    const bottom = 28.0;

    final plot = Rect.fromLTRB(
      left,
      top,
      size.width - right,
      size.height - bottom,
    );

    final gridPaint = Paint()
      ..color = const Color(0xFF2B3338)
      ..strokeWidth = 1;

    for (int i = 0; i <= 4; i++) {
      final y = plot.top + plot.height * i / 4;
      canvas.drawLine(
        Offset(plot.left, y),
        Offset(plot.right, y),
        gridPaint,
      );
    }

    final n = history.length;

    double xFor(int i) {
      if (n <= 1) return plot.left;
      return plot.left +
          (plot.width * i / (n - 1));
    }

    for (final s in series) {
      final values = <double>[];
      for (final row in history) {
        final raw = row[s.keyName];
        if (raw is num) values.add(raw.toDouble());
      }

      if (values.isEmpty) continue;

      double minV = values.reduce(math.min);
      double maxV = values.reduce(math.max);
      final range = maxV - minV;

      if (range.abs() < 0.0001) {
        final pad =
            math.max(maxV.abs() * 0.01, 0.03);
        minV -= pad;
        maxV += pad;
      } else {
        final pad = math.max(range * 0.35, 0.01);
        minV -= pad;
        maxV += pad;
      }

      double yFor(double value) {
        return plot.bottom -
            ((value - minV) /
                    (maxV - minV)) *
                plot.height;
      }

      final path = Path();
      final linePaint = Paint()
        ..color = s.color
        ..strokeWidth = 2.7
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..style = PaintingStyle.stroke;

      final pointPaint = Paint()
        ..color = s.color
        ..style = PaintingStyle.fill;

      bool started = false;

      for (int i = 0; i < n; i++) {
        final raw = history[i][s.keyName];
        if (raw is! num) continue;

        final point = Offset(
          xFor(i),
          yFor(raw.toDouble()),
        );

        if (!started) {
          path.moveTo(point.dx, point.dy);
          started = true;
        } else {
          path.lineTo(point.dx, point.dy);
        }

        canvas.drawCircle(
          point,
          selectedIndex == i ? 5.2 : 3.4,
          pointPaint,
        );
      }

      if (started) {
        canvas.drawPath(path, linePaint);
      }
    }

    if (selectedIndex != null &&
        selectedIndex! >= 0 &&
        selectedIndex! < n) {
      final x = xFor(selectedIndex!);

      canvas.drawLine(
        Offset(x, plot.top),
        Offset(x, plot.bottom),
        Paint()
          ..color =
              const Color(0xFF8FA09A)
                  .withValues(alpha: 0.35)
          ..strokeWidth = 1,
      );
    }

    final labelIndexes = <int>{
      0,
      if (n > 2) n ~/ 2,
      if (n > 1) n - 1,
    };

    for (final i in labelIndexes) {
      if (i < 0 || i >= n) continue;

      String label = '--:--';
      try {
        final dt = DateTime.parse(
          history[i]['captured_at'].toString(),
        ).toLocal();
        label =
            dt.hour.toString().padLeft(2, '0') +
                ':' +
                dt.minute
                    .toString()
                    .padLeft(2, '0');
      } catch (_) {}

      _centerText(
        canvas,
        label,
        Offset(
          xFor(i),
          plot.bottom + 8,
        ),
        const TextStyle(
          color: Color(0xFFA0AAA5),
          fontSize: 8,
          fontWeight: FontWeight.w600,
        ),
      );
    }
  }

  void _centerText(
    Canvas canvas,
    String text,
    Offset center,
    TextStyle style,
  ) {
    final tp = TextPainter(
      text: TextSpan(
        text: text,
        style: style,
      ),
      textDirection: TextDirection.ltr,
    )..layout();

    tp.paint(
      canvas,
      Offset(
        center.dx - tp.width / 2,
        center.dy,
      ),
    );
  }

  @override
  bool shouldRepaint(
    covariant CombinedMarketPainter oldDelegate,
  ) {
    return oldDelegate.selectedIndex !=
            selectedIndex ||
        oldDelegate.history != history ||
        oldDelegate.series != series;
  }
}

class SystemPage extends StatefulWidget {
  const SystemPage({super.key});

  @override
  State<SystemPage> createState() => _SystemPageState();
}

class _SystemPageState extends State<SystemPage> {
  bool loading = true;
  bool savingInterval = false;
  String error = '';
  Map<String, dynamic> data = {};
  int refreshMinutes = 60;

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
      refreshMinutes =
          (data['refresh_minutes'] as num?)?.toInt() ?? 60;
    } catch (e) {
      error = e.toString();
    }

    if (mounted) setState(() => loading = false);
  }

  Future<void> saveInterval(int minutes) async {
    if (savingInterval || minutes == refreshMinutes) return;

    setState(() => savingInterval = true);

    try {
      final d = await api.post(
        '/api/settings/refresh-interval',
        {'minutes': minutes},
      );

      final saved =
          (d['refresh_minutes'] as num?)?.toInt() ?? minutes;

      if (mounted) {
        setState(() {
          refreshMinutes = saved;
          savingInterval = false;
        });

        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'Oran çekme aralığı ' +
                  saved.toString() +
                  ' dakika oldu.',
            ),
          ),
        );
      }

      await load();
    } catch (e) {
      if (mounted) {
        setState(() => savingInterval = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(e.toString())),
        );
      }
    }
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
    if (loading) {
      return const Center(child: CircularProgressIndicator());
    }
    if (error.isNotEmpty) {
      return ErrorPane(message: error, retry: load);
    }

    final run = data['last_run'] is Map
        ? Map<String, dynamic>.from(data['last_run'])
        : <String, dynamic>{};

    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        padding: const EdgeInsets.all(14),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          const Icon(Icons.cloud_done_rounded, size: 42),
          const SizedBox(height: 6),
          const Center(
            child: Text(
              'Sunucu bağlı',
              style: TextStyle(
                fontSize: 17,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(height: 14),
          Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 11, 12, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Oran çekme sıklığı',
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  const SizedBox(height: 3),
                  const Text(
                    'Bütün aktif takip maçları için geçerlidir. Manuel “Şimdi güncelle” her zaman ayrıca çalışır.',
                    style: TextStyle(
                      fontSize: 10,
                      color: Color(0xFFA7B0B8),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Wrap(
                    spacing: 7,
                    runSpacing: 7,
                    children: [
                      for (final minutes in const [15, 30, 45, 60])
                        ChoiceChip(
                          label: Text(
                            minutes.toString() + ' dk',
                            style: const TextStyle(fontSize: 11),
                          ),
                          selected: refreshMinutes == minutes,
                          onSelected: savingInterval
                              ? null
                              : (_) => saveInterval(minutes),
                        ),
                    ],
                  ),
                  if (savingInterval) ...[
                    const SizedBox(height: 8),
                    const LinearProgressIndicator(),
                  ],
                ],
              ),
            ),
          ),
          const SizedBox(height: 8),
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
