import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:workmanager/workmanager.dart';

const String baseUrl = 'http://80.225.82.228:3100';
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

Future<void> _initBackgroundServices() async {
  // UI'yi asla bildirim, WorkManager veya ağ isteği bekletmesin.
  try {
    await initLocalNotifications(requestPermission: true);
  } catch (_) {}

  try {
    await Workmanager().initialize(
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
  } catch (_) {}

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
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Önce ekranı aç; servisler arka planda başlasın.
  runApp(const MacRadarApp());

  Future.microtask(_initBackgroundServices);
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

    for (int attempt = 1; attempt <= 2; attempt++) {
      try {
        return await request();
      } catch (e) {
        last = e;
        if (attempt < 2) {
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
          .timeout(const Duration(seconds: 30)),
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
          .timeout(const Duration(seconds: 30)),
    );
    return decode(r);
  }

  Future<Map<String, dynamic>> postLong(
    String path,
    Map<String, dynamic> body,
  ) async {
    final r = await http
        .post(
          Uri.parse(baseUrl + path),
          headers: writeHeaders,
          body: jsonEncode(body),
        )
        .timeout(const Duration(minutes: 4));
    return decode(r);
  }

  Future<Map<String, dynamic>> delete(String path) async {
    final r = await _retry(
      () => http
          .delete(
            Uri.parse(baseUrl + path),
            headers: writeHeaders,
          )
          .timeout(const Duration(seconds: 30)),
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

const String performanceCachePrefix = 'macradar_performance_v2_';
final Map<String, Future<Map<String, dynamic>>> performanceInFlight = {};

Future<Map<String, dynamic>?> readLocalPerformance(String eventId) async {
  try {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(performanceCachePrefix + eventId);
    if (raw == null || raw.isEmpty) return null;
    final decoded = jsonDecode(raw);
    return decoded is Map
        ? Map<String, dynamic>.from(decoded)
        : null;
  } catch (_) {
    return null;
  }
}

Future<void> saveLocalPerformance(
  String eventId,
  Map<String, dynamic> data,
) async {
  try {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      performanceCachePrefix + eventId,
      jsonEncode(data),
    );
  } catch (_) {}
}

bool _hasPerformanceData(Map<String, dynamic> d) {
  return d['evTakimi'] is Map && d['deplasmanTakimi'] is Map;
}

String _friendlyPerformanceError(Object e) {
  final raw = e.toString().replaceFirst('Exception: ', '');
  final low = raw.toLowerCase();

  if (low.contains('connection abort') ||
      low.contains('connection reset') ||
      low.contains('timed out') ||
      low.contains('timeout')) {
    return 'Bağlantı kesildi. Hazırlama sunucuda devam ediyor olabilir.';
  }

  return raw;
}

Future<Map<String, dynamic>> _fetchPerformanceFromServer(
  String eventId, {
  bool force = false,
}) async {
  final path = '/api/matches/' + eventId + '/performance';

  final trigger = await api.post(
    path,
    {'force': force},
  );

  if (_hasPerformanceData(trigger)) {
    await saveLocalPerformance(eventId, trigger);
    return trigger;
  }

  Object? lastError;

  // Sunucu veriyi arka planda hazırlar. Uzun tek HTTP isteği yerine
  // kısa sorgularla sonucu beklediğimiz için Android bağlantıyı kesmez.
  for (int attempt = 0; attempt < 48; attempt++) {
    await Future.delayed(const Duration(seconds: 4));

    try {
      final d = await api.get(path);

      if (_hasPerformanceData(d)) {
        await saveLocalPerformance(eventId, d);
        return d;
      }

      if (d['status']?.toString() == 'failed') {
        throw Exception(
          d['error']?.toString() ?? 'Performans verisi hazırlanamadı.',
        );
      }
    } catch (e) {
      lastError = e;
      final msg = e.toString().toLowerCase();

      // Sunucu açıkça "failed" döndürdüyse boşuna bekleme.
      if (msg.contains('hazırlanamadı') ||
          msg.contains('takım sayfası bulunamadı')) {
        rethrow;
      }
    }
  }

  throw lastError ??
      Exception('Performans verisi hazırlanırken süre aşıldı.');
}

Future<Map<String, dynamic>> fetchPerformancePersistent(
  String eventId, {
  bool force = false,
}) {
  if (!force) {
    final current = performanceInFlight[eventId];
    if (current != null) return current;
  }

  final future = _fetchPerformanceFromServer(
    eventId,
    force: force,
  );

  performanceInFlight[eventId] = future;

  future.whenComplete(() {
    if (identical(performanceInFlight[eventId], future)) {
      performanceInFlight.remove(eventId);
    }
  }).catchError((_) {});

  return future;
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
        colorSchemeSeed: const Color(0xFF3B82F6),
        scaffoldBackgroundColor: const Color(0xFF0B1220),
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
            const Icon(Icons.sports_soccer_rounded, size: 22),
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

class _PinnedHeaderDelegate extends SliverPersistentHeaderDelegate {
  final double height;
  final Widget child;

  const _PinnedHeaderDelegate({
    required this.height,
    required this.child,
  });

  @override
  double get minExtent => height;

  @override
  double get maxExtent => height;

  @override
  Widget build(
    BuildContext context,
    double shrinkOffset,
    bool overlapsContent,
  ) {
    return child;
  }

  @override
  bool shouldRebuild(covariant _PinnedHeaderDelegate oldDelegate) {
    return oldDelegate.height != height || oldDelegate.child != child;
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

  String bulletinQuery = '';
  String bulletinTimeFilter = 'Tümü';
  final TextEditingController bulletinSearchController =
      TextEditingController();

  @override
  void initState() {
    super.initState();
    load();
  }

  @override
  void dispose() {
    bulletinSearchController.dispose();
    super.dispose();
  }

  DateTime? bulletinKickoff(Map<String, dynamic> m) {
    final dateText = m['date']?.toString() ?? iso(date);
    final timeText = m['time']?.toString().trim() ?? '';

    final dm =
        RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(dateText);
    final tm =
        RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(timeText);

    if (dm == null || tm == null) return null;

    return DateTime(
      int.parse(dm.group(1)!),
      int.parse(dm.group(2)!),
      int.parse(dm.group(3)!),
      int.parse(tm.group(1)!),
      int.parse(tm.group(2)!),
    );
  }

  bool bulletinVisible(Map<String, dynamic> m) {
    // Bülten sadece henüz başlamamış ve takibe alınabilir maçları gösterir.
    // Başlayan/biten maçların yeri Takip veya Arşiv ekranıdır.
    if (bulletinLocked(m)) return false;

    final query = bulletinQuery.trim().toLowerCase();

    if (query.isNotEmpty) {
      final searchable = [
        m['name'],
        m['league'],
      ].whereType<Object>().map((e) => e.toString().toLowerCase()).join(' ');

      if (!searchable.contains(query)) return false;
    }

    if (bulletinTimeFilter == 'Tümü') return true;

    if (bulletinTimeFilter == 'Takipte') {
      return m['followed'] == true;
    }

    final kickoff = bulletinKickoff(m);
    if (kickoff == null) return false;

    final minutes = kickoff.difference(DateTime.now()).inMinutes;
    if (minutes < 0) return false;

    switch (bulletinTimeFilter) {
      case '0-3s':
        return minutes <= 180;
      case '3-6s':
        return minutes > 180 && minutes <= 360;
      case '6+s':
        return minutes > 360;
      default:
        return true;
    }
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
    final match =
        RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(dateText);
    final tm = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(time);
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

    final visibleMatches =
        matches.where(bulletinVisible).toList();

    visibleMatches.sort((a, b) {
      final aTime = bulletinKickoff(a);
      final bTime = bulletinKickoff(b);

      if (aTime == null && bTime == null) return 0;
      if (aTime == null) return 1;
      if (bTime == null) return -1;

      return aTime.compareTo(bTime);
    });

    final groups = <String, List<Map<String, dynamic>>>{};

    for (final m in visibleMatches) {
      final league = m['league']?.toString().trim();
      final key = league == null || league.isEmpty ? 'Diğer' : league;

      groups.putIfAbsent(key, () => []).add(m);
    }

    String selectedSummary = '${selected.length} maç seçildi';

    if (selected.isNotEmpty) {
      final latestSelectedUrl = selected.last;
      Map<String, dynamic>? latestSelectedMatch;

      for (final m in matches) {
        if ((m['url']?.toString() ?? '') == latestSelectedUrl) {
          latestSelectedMatch = m;
          break;
        }
      }

      final latestSelectedName =
          latestSelectedMatch?['name']?.toString().trim() ?? '';

      if (latestSelectedName.isNotEmpty) {
        selectedSummary = selected.length == 1
            ? latestSelectedName
            : '$latestSelectedName  ·  +${selected.length - 1}';
      }
    }

    return RefreshIndicator(
      onRefresh: load,
      child: CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverPersistentHeader(
            pinned: true,
            delegate: _PinnedHeaderDelegate(
              height: selected.isEmpty ? 166 : 216,
              child: Material(
                color: const Color(0xFF111827),
                elevation: 3,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 7, 12, 7),
                  child: Column(
                    children: [
                      SizedBox(
                        height: 42,
                        child: Row(
                          children: [
                            IconButton(
                              visualDensity: VisualDensity.compact,
                              onPressed: isToday
                                  ? null
                                  : () {
                                      date = date.subtract(
                                        const Duration(days: 1),
                                      );
                                      load();
                                    },
                              icon: const Icon(
                                Icons.chevron_left_rounded,
                                size: 24,
                              ),
                            ),
                            Expanded(
                              child: Column(
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  const Text(
                                    'MAÇ BÜLTENİ',
                                    style: TextStyle(
                                      fontSize: 9,
                                      letterSpacing: 1.15,
                                      color: Color(0xFF94A3B8),
                                      fontWeight: FontWeight.w800,
                                    ),
                                  ),
                                  Text(
                                    iso(date),
                                    style: const TextStyle(
                                      fontSize: 17,
                                      color: Color(0xFFF1F5F9),
                                      fontWeight: FontWeight.w800,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            IconButton(
                              visualDensity: VisualDensity.compact,
                              onPressed: () {
                                date = date.add(const Duration(days: 1));
                                load();
                              },
                              icon: const Icon(
                                Icons.chevron_right_rounded,
                                size: 24,
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 5),
                      SizedBox(
                        height: 40,
                        child: TextField(
                          controller: bulletinSearchController,
                          onChanged: (value) {
                            setState(() {
                              bulletinQuery = value;
                            });
                          },
                          style: const TextStyle(
                            fontSize: 12.5,
                            color: Color(0xFFF1F5F9),
                          ),
                          decoration: InputDecoration(
                            hintText: 'Takım veya maç ara',
                            hintStyle: const TextStyle(
                              color: Color(0xFF7F8EA3),
                              fontSize: 12,
                            ),
                            prefixIcon: const Icon(
                              Icons.search_rounded,
                              size: 19,
                              color: Color(0xFF94A3B8),
                            ),
                            suffixIcon: bulletinQuery.isEmpty
                                ? null
                                : IconButton(
                                    onPressed: () {
                                      bulletinSearchController.clear();
                                      setState(() {
                                        bulletinQuery = '';
                                      });
                                    },
                                    icon: const Icon(
                                      Icons.close_rounded,
                                      size: 17,
                                    ),
                                  ),
                            filled: true,
                            fillColor: const Color(0xFF1E293B),
                            contentPadding: EdgeInsets.zero,
                            border: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(11),
                              borderSide: const BorderSide(
                                color: Color(0xFF334155),
                              ),
                            ),
                            enabledBorder: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(11),
                              borderSide: const BorderSide(
                                color: Color(0xFF334155),
                              ),
                            ),
                            focusedBorder: OutlineInputBorder(
                              borderRadius: BorderRadius.circular(11),
                              borderSide: const BorderSide(
                                color: Color(0xFF60A5FA),
                              ),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 6),
                      SizedBox(
                        height: 34,
                        child: ListView(
                          scrollDirection: Axis.horizontal,
                          children: [
                            for (final filter in const [
                              'Tümü',
                              '0-3s',
                              '3-6s',
                              '6+s',
                              'Takipte',
                            ])
                              Padding(
                                padding: const EdgeInsets.only(right: 6),
                                child: ChoiceChip(
                                  label: Text(
                                    filter == '0-3s'
                                        ? '0–3 saat'
                                        : filter == '3-6s'
                                            ? '3–6 saat'
                                            : filter == '6+s'
                                                ? '6+ saat'
                                                : filter,
                                  ),
                                  selected:
                                      bulletinTimeFilter == filter,
                                  onSelected: (_) {
                                    setState(() {
                                      bulletinTimeFilter = filter;
                                    });
                                  },
                                  visualDensity: VisualDensity.compact,
                                  labelStyle: TextStyle(
                                    fontSize: 10,
                                    fontWeight: FontWeight.w800,
                                    color: bulletinTimeFilter == filter
                                        ? const Color(0xFFF8FAFC)
                                        : const Color(0xFFCBD5E1),
                                  ),
                                  selectedColor:
                                      const Color(0xFF334155),
                                  backgroundColor:
                                      const Color(0xFF1E293B),
                                  side: BorderSide(
                                    color: bulletinTimeFilter == filter
                                        ? const Color(0xFF60A5FA)
                                        : const Color(0xFF334155),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                      if (selected.isNotEmpty) ...[
                        const SizedBox(height: 6),
                        SizedBox(
                          height: 44,
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  selectedSummary,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    color: Color(0xFFE2E8F0),
                                    fontSize: 11.5,
                                    fontWeight: FontWeight.w800,
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              FilledButton.icon(
                                style: FilledButton.styleFrom(
                                  backgroundColor:
                                      const Color(0xFF2563EB),
                                  foregroundColor: Colors.white,
                                  visualDensity: VisualDensity.compact,
                                ),
                                onPressed: saving ? null : follow,
                                icon: saving
                                    ? const SizedBox(
                                        width: 14,
                                        height: 14,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                          color: Colors.white,
                                        ),
                                      )
                                    : const Icon(
                                        Icons.add_task_rounded,
                                        size: 17,
                                      ),
                                label: Text(
                                  saving
                                      ? 'Kaydediliyor'
                                      : 'Takibe al',
                                  style: const TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.w900,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ],
                  ),
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
          else if (groups.isEmpty)
            const SliverFillRemaining(
              hasScrollBody: false,
              child: Center(
                child: Text(
                  'Arama veya filtreye uygun maç yok.',
                  style: TextStyle(
                    color: Color(0xFF94A3B8),
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            )
          else
            for (final g in groups.entries)
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(10, 8, 10, 2),
                  child: Container(
                    decoration: BoxDecoration(
                      color: const Color(0xFF151E2B),
                      borderRadius: BorderRadius.circular(13),
                      border: Border.all(
                        color: const Color(0xFF2A394B),
                      ),
                    ),
                    child: Column(
                      children: [
                        Padding(
                          padding: const EdgeInsets.fromLTRB(12, 9, 10, 8),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  g.key,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 11.5,
                                    fontWeight: FontWeight.w900,
                                    color: Color(0xFFDCE5F0),
                                  ),
                                ),
                              ),
                              const SizedBox(width: 8),
                              Text(
                                '${g.value.length} maç',
                                style: const TextStyle(
                                  fontSize: 9.5,
                                  fontWeight: FontWeight.w800,
                                  color: Color(0xFF8291A6),
                                ),
                              ),
                            ],
                          ),
                        ),
                        const Divider(
                          height: 1,
                          thickness: 1,
                          color: Color(0xFF263445),
                        ),
                        for (int i = 0; i < g.value.length; i++)
                          Builder(
                            builder: (context) {
                              final m = g.value[i];
                              final url = m['url']?.toString() ?? '';
                              final followed = m['followed'] == true;
                              final locked = bulletinLocked(m);
                              final checked =
                                  followed || selected.contains(url);

                              return Column(
                                children: [
                                  CheckboxListTile(
                                    dense: true,
                                    visualDensity: const VisualDensity(
                                      horizontal: -2,
                                      vertical: -2,
                                    ),
                                    contentPadding:
                                        const EdgeInsets.fromLTRB(
                                      11,
                                      1,
                                      7,
                                      1,
                                    ),
                                    value: checked,
                                    activeColor: const Color(0xFF2563EB),
                                    checkColor: Colors.white,
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
                                    controlAffinity:
                                        ListTileControlAffinity.trailing,
                                    title: Text(
                                      m['name']?.toString() ?? '-',
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        fontSize: 12.5,
                                        fontWeight: FontWeight.w800,
                                        color: Color(0xFFF1F5F9),
                                      ),
                                    ),
                                    subtitle: Padding(
                                      padding: const EdgeInsets.only(top: 2),
                                      child: Text(
                                        bulletinStatus(m) +
                                            (followed
                                                ? '  ·  Takipte'
                                                : '') +
                                            (m['archived'] == true
                                                ? '  ·  Arşivde'
                                                : ''),
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: TextStyle(
                                          fontSize: 10.5,
                                          fontWeight: FontWeight.w700,
                                          color: followed
                                              ? const Color(0xFF7DD3FC)
                                              : locked
                                                  ? const Color(0xFFF59E0B)
                                                  : const Color(0xFF94A3B8),
                                        ),
                                      ),
                                    ),
                                  ),
                                  if (i != g.value.length - 1)
                                    const Divider(
                                      height: 1,
                                      indent: 11,
                                      endIndent: 11,
                                      color: Color(0xFF263445),
                                    ),
                                ],
                              );
                            },
                          ),
                      ],
                    ),
                  ),
                ),
              ),
          const SliverToBoxAdapter(child: SizedBox(height: 20)),
        ],
      ),
    );
  }
}


String _trackNice(String s) {
  return s.split('-').map((x) {
    if (x.isEmpty) return x;
    return x[0].toUpperCase() + x.substring(1);
  }).join(' ');
}

String _trackTitle(Map<String, dynamic> m) {
  final display = m['display_name']?.toString().trim() ?? '';
  if (display.isNotEmpty) return display;
  final slug = m['match_slug']?.toString() ?? m['event_id'].toString();
  return _trackNice(slug);
}

String _trackShortStamp(dynamic raw) {
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

String _trackDateKey(Map<String, dynamic> m) {
  final raw = m['match_date']?.toString() ?? '';
  final mm = RegExp(r'(\d{4})-(\d{2})-(\d{2})').firstMatch(raw);
  if (mm == null) return 'Tarih yok';
  return mm.group(1)! + '-' + mm.group(2)! + '-' + mm.group(3)!;
}

String _trackDateLabel(String key) {
  final mm = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$').firstMatch(key);
  if (mm == null) return key;
  return mm.group(3)! + '.' + mm.group(2)! + '.' + mm.group(1)!.substring(2);
}

int _trackScheduleKey(Map<String, dynamic> m) {
  final d = m['match_date']?.toString();
  final t = m['kickoff_time']?.toString();
  if (d == null || t == null) return 0;

  final dm = RegExp(r'(\d{4})-(\d{2})-(\d{2})').firstMatch(d);
  final tm = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(t);
  if (dm == null || tm == null) return 0;

  return DateTime(
    int.parse(dm.group(1)!),
    int.parse(dm.group(2)!),
    int.parse(dm.group(3)!),
    int.parse(tm.group(1)!),
    int.parse(tm.group(2)!),
  ).millisecondsSinceEpoch;
}

DateTime? _trackKickoffDateTime(Map<String, dynamic> m) {
  final d = m['match_date']?.toString() ?? '';
  final t = m['kickoff_time']?.toString() ?? '';

  final dm = RegExp(r'(\d{4})-(\d{2})-(\d{2})').firstMatch(d);
  final tm = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(t);

  if (dm == null || tm == null) return null;

  return DateTime(
    int.parse(dm.group(1)!),
    int.parse(dm.group(2)!),
    int.parse(dm.group(3)!),
    int.parse(tm.group(1)!),
    int.parse(tm.group(2)!),
  );
}

int? _trackMinutesUntilKickoff(Map<String, dynamic> m) {
  final kickoff = _trackKickoffDateTime(m);
  if (kickoff == null) return null;

  return kickoff.difference(DateTime.now()).inMinutes;
}

String _trackCountdownLabel(Map<String, dynamic> m) {
  final minutes = _trackMinutesUntilKickoff(m);

  if (minutes == null) return '';
  if (minutes < 0) return 'Başladı';
  if (minutes == 0) return 'Şimdi';
  if (minutes < 60) return '$minutes dk kaldı';

  final hours = minutes ~/ 60;
  final rest = minutes % 60;

  if (rest == 0) return '${hours}s kaldı';
  return '${hours}s ${rest}dk kaldı';
}

String _trackResultText(Map<String, dynamic> m) {
  final h = m['home_score'];
  final a = m['away_score'];
  if (h is num && a is num) {
    return h.toInt().toString() + '-' + a.toInt().toString();
  }
  return '';
}

Map<String, List<Map<String, dynamic>>> _groupTrackedByDate(
  List<Map<String, dynamic>> items,
) {
  final out = <String, List<Map<String, dynamic>>>{};
  for (final m in items) {
    final key = _trackDateKey(m);
    out.putIfAbsent(key, () => <Map<String, dynamic>>[]).add(m);
  }
  for (final list in out.values) {
    list.sort((a, b) => _trackScheduleKey(a).compareTo(_trackScheduleKey(b)));
  }
  return out;
}

class _DateMatchGroups extends StatelessWidget {
  final List<Map<String, dynamic>> matches;
  final bool archived;
  final Future<void> Function(Map<String, dynamic>) onOpen;
  final Future<void> Function(Map<String, dynamic>) onRemove;

  const _DateMatchGroups({
    required this.matches,
    required this.archived,
    required this.onOpen,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    final groups = _groupTrackedByDate(matches);
    final keys = groups.keys.toList()
      ..sort((a, b) => archived ? b.compareTo(a) : a.compareTo(b));

    if (keys.isEmpty) {
      return Padding(
        padding: const EdgeInsets.only(top: 110),
        child: Column(
          children: [
            Icon(
              archived ? Icons.history_rounded : Icons.bookmark_border,
              size: 44,
              color: const Color(0xFF7F8C85),
            ),
            const SizedBox(height: 10),
            Text(
              archived ? 'Biten maç yok.' : 'Aktif takip maçı yok.',
              style: const TextStyle(
                color: Color(0xFFA8B3AC),
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      );
    }

    return Column(
      children: [
        for (final key in keys)
          Card(
            margin: const EdgeInsets.fromLTRB(10, 6, 10, 2),
            clipBehavior: Clip.antiAlias,
            color: const Color(0xFF111827),
            elevation: 0,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(12),
              side: const BorderSide(
                color: Color(0xFF263445),
              ),
            ),
            child: ExpansionTile(
              key: PageStorageKey<String>(
                (archived ? 'finished-' : 'active-') + key,
              ),
              initiallyExpanded: !archived,
              tilePadding: const EdgeInsets.symmetric(
                horizontal: 12,
                vertical: 0,
              ),
              childrenPadding: const EdgeInsets.fromLTRB(7, 0, 7, 7),
              title: Text(
                _trackDateLabel(key),
                style: const TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w900,
                  color: Color(0xFFDCE5F0),
                ),
              ),
              subtitle: Text(
                (groups[key]?.length ?? 0).toString() + ' maç',
                style: const TextStyle(
                  fontSize: 9.5,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFF8291A6),
                ),
              ),
              children: [
                for (final m in groups[key]!)
                  _TrackedMatchCard(
                    match: m,
                    archived: archived,
                    onOpen: () => onOpen(m),
                    onRemove: () => onRemove(m),
                  ),
              ],
            ),
          ),
      ],
    );
  }
}

class _TrackedMatchCard extends StatelessWidget {
  final Map<String, dynamic> match;
  final bool archived;
  final Future<void> Function() onOpen;
  final Future<void> Function() onRemove;

  const _TrackedMatchCard({
    required this.match,
    required this.archived,
    required this.onOpen,
    required this.onRemove,
  });

  @override
  Widget build(BuildContext context) {
    final score = _trackResultText(match);
    final lifecycle = match['lifecycle']?.toString() ?? '';

    final statusLine = archived
        ? (lifecycle == 'finished'
            ? 'Maç bitti'
            : 'Oran takibi kapandı')
        : 'Oran takibi aktif';

    final minutesLeft =
        archived ? null : _trackMinutesUntilKickoff(match);

    final lastHour = minutesLeft != null &&
        minutesLeft >= 0 &&
        minutesLeft <= 60;

    final countdown = archived
        ? ''
        : _trackCountdownLabel(match).replaceAll(' kaldı', '');

    return Card(
      margin: const EdgeInsets.fromLTRB(2, 3, 2, 3),
      color: lastHour
          ? const Color(0xFF211B18)
          : const Color(0xFF151E2B),
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(11),
        side: BorderSide(
          color: lastHour
              ? const Color(0xFFF59E0B)
              : const Color(0xFF2A394B),
          width: lastHour ? 1.2 : 1,
        ),
      ),
      child: ListTile(
        dense: true,
        visualDensity: const VisualDensity(vertical: -1),
        contentPadding: const EdgeInsets.fromLTRB(10, 4, 4, 4),
        minLeadingWidth: 8,
        leading: Container(
          width: 4,
          height: 42,
          decoration: BoxDecoration(
            color: archived
                ? const Color(0xFF64748B)
                : lastHour
                    ? const Color(0xFFF59E0B)
                    : const Color(0xFF3B82F6),
            borderRadius: BorderRadius.circular(8),
          ),
        ),
        title: Text(
          _trackTitle(match),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(
            fontSize: 13.2,
            fontWeight: FontWeight.w800,
            color: Color(0xFFF1F5F9),
          ),
        ),
        subtitle: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const SizedBox(height: 2),
            Text(
              (match['kickoff_time']?.toString().isNotEmpty == true
                      ? match['kickoff_time'].toString()
                      : '--:--') +
                  (match['league']?.toString().isNotEmpty == true
                      ? '  ·  ${match['league']}'
                      : ''),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 10.5,
                fontWeight: FontWeight.w700,
                color: Color(0xFFB5C1D1),
              ),
            ),
            const SizedBox(height: 2),
            Row(
              children: [
                Expanded(
                  child: Text(
                    statusLine +
                        '  ·  Son oran: ' +
                        _trackShortStamp(match['last_capture']),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 9.5,
                      fontWeight: FontWeight.w700,
                      color: archived
                          ? const Color(0xFF8794A8)
                          : const Color(0xFF7DD3FC),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                Text(
                  (match['capture_count']?.toString() ?? '0') + ' tur',
                  maxLines: 1,
                  style: TextStyle(
                    fontSize: 9.5,
                    fontWeight: FontWeight.w900,
                    color: archived
                        ? const Color(0xFF8794A8)
                        : const Color(0xFF7DD3FC),
                  ),
                ),
              ],
            ),
          ],
        ),
        onTap: onOpen,
        trailing: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (!archived && countdown.isNotEmpty)
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 7,
                  vertical: 5,
                ),
                decoration: BoxDecoration(
                  color: lastHour
                      ? const Color(0xFF7C2D12)
                      : const Color(0xFF1E293B),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: lastHour
                        ? const Color(0xFFFB923C)
                        : const Color(0xFF3B4B61),
                  ),
                ),
                child: Text(
                  countdown,
                  style: TextStyle(
                    fontSize: 9,
                    fontWeight: FontWeight.w900,
                    color: lastHour
                        ? const Color(0xFFFFEDD5)
                        : const Color(0xFFDCE5F0),
                  ),
                ),
              ),
            if (!archived &&
                countdown.isNotEmpty &&
                match['sharp_move_alert'] == true)
              const SizedBox(width: 5),
            if (!archived && match['sharp_move_alert'] == true)
              const Icon(
                Icons.warning_amber_rounded,
                color: Color(0xFFEF4444),
                size: 18,
              ),
            if (archived && score.isNotEmpty)
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 8,
                  vertical: 5,
                ),
                decoration: BoxDecoration(
                  color: const Color(0xFF1E293B),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(
                    color: const Color(0xFF475569),
                  ),
                ),
                child: Text(
                  'MS $score',
                  style: const TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w900,
                    color: Color(0xFFF1F5F9),
                  ),
                ),
              ),
            if (archived && score.isNotEmpty)
              const SizedBox(width: 4),
            PopupMenuButton<String>(
              padding: EdgeInsets.zero,
              onSelected: (x) {
                if (x == 'remove') onRemove();
              },
              itemBuilder: (_) => [
                PopupMenuItem(
                  value: 'remove',
                  child: Text(
                    archived ? 'Arşivden kaldır' : 'Takibi bırak',
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

class TrackedPage extends StatefulWidget {
  const TrackedPage({super.key});

  @override
  State<TrackedPage> createState() => _TrackedPageState();
}

class _TrackedPageState extends State<TrackedPage> {
  bool loading = true;
  String error = '';
  List<Map<String, dynamic>> matches = [];

  String trackedQuery = '';
  String trackedTimeFilter = 'Tümü';
  final TextEditingController trackedSearchController =
      TextEditingController();

  @override
  void initState() {
    super.initState();
    load();
  }

  @override
  void dispose() {
    trackedSearchController.dispose();
    super.dispose();
  }

  DateTime? trackedKickoff(Map<String, dynamic> m) {
    final rawDate = m['match_date']?.toString() ?? '';
    final rawTime = m['kickoff_time']?.toString() ?? '';

    final dm =
        RegExp(r'^(\d{4})-(\d{2})-(\d{2})').firstMatch(rawDate);
    final tm =
        RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(rawTime);

    if (dm == null || tm == null) return null;

    return DateTime(
      int.parse(dm.group(1)!),
      int.parse(dm.group(2)!),
      int.parse(dm.group(3)!),
      int.parse(tm.group(1)!),
      int.parse(tm.group(2)!),
    );
  }

  int? trackedMinutesLeft(Map<String, dynamic> m) {
    final kickoff = trackedKickoff(m);
    if (kickoff == null) return null;
    return kickoff.difference(DateTime.now()).inMinutes;
  }

  bool trackedVisible(Map<String, dynamic> m) {
    final query = trackedQuery.trim().toLowerCase();

    if (query.isNotEmpty) {
      final searchable = [
        _trackTitle(m),
        m['league'],
      ]
          .whereType<Object>()
          .map((e) => e.toString().toLowerCase())
          .join(' ');

      if (!searchable.contains(query)) return false;
    }

    if (trackedTimeFilter == 'Tümü') return true;

    final minutes = trackedMinutesLeft(m);
    if (minutes == null || minutes < 0) return false;

    switch (trackedTimeFilter) {
      case '1s':
        return minutes <= 60;
      case '3s':
        return minutes <= 180;
      case '6s':
        return minutes <= 360;
      default:
        return true;
    }
  }

  String trackedCountdown(Map<String, dynamic> m) {
    final minutes = trackedMinutesLeft(m);

    if (minutes == null) return '';
    if (minutes < 0) return 'Başladı';
    if (minutes < 60) return '$minutes dk';

    final hours = minutes ~/ 60;
    final rest = minutes % 60;

    if (rest == 0) return '${hours}s';
    return '${hours}s ${rest}dk';
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
              .where((e) => e['active'] == true || e['archived'] == true)
              .toList()
          : [];
    } catch (e) {
      error = e.toString();
    }

    if (mounted) setState(() => loading = false);
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

  Future<void> openMatch(Map<String, dynamic> m) async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => MatchDetail(
          eventId: m['event_id'].toString(),
          title: _trackTitle(m),
        ),
      ),
    );
    if (mounted) load();
  }

  Future<void> openFinished() async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => const FinishedMatchesPage(),
      ),
    );
    if (mounted) load();
  }

  @override
  Widget build(BuildContext context) {
    if (loading) return const Center(child: CircularProgressIndicator());
    if (error.isNotEmpty) return ErrorPane(message: error, retry: load);

    final active = matches
        .where((m) => m['active'] == true)
        .where(trackedVisible)
        .toList()
      ..sort((a, b) {
        final aTime = trackedKickoff(a);
        final bTime = trackedKickoff(b);

        if (aTime == null && bTime == null) return 0;
        if (aTime == null) return 1;
        if (bTime == null) return -1;

        return aTime.compareTo(bTime);
      });

    final finishedCount =
        matches.where((m) => m['archived'] == true).length;

    return RefreshIndicator(
      onRefresh: load,
      child: CustomScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        slivers: [
          SliverPersistentHeader(
            pinned: true,
            delegate: _PinnedHeaderDelegate(
              height: 142,
              child: Material(
                color: const Color(0xFF111827),
                elevation: 3,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 7),
                  child: Column(
                    children: [
                      SizedBox(
                        height: 38,
                        child: Row(
                          children: [
                            Expanded(
                              child: Container(
                                height: 38,
                                decoration: BoxDecoration(
                                  color: const Color(0xFF1E293B),
                                  borderRadius: BorderRadius.circular(10),
                                  border: Border.all(
                                    color: const Color(0xFF334155),
                                  ),
                                ),
                                child: TextField(
                                  controller: trackedSearchController,
                                  onChanged: (value) {
                                    setState(() {
                                      trackedQuery = value;
                                    });
                                  },
                                  style: const TextStyle(
                                    fontSize: 12.5,
                                    color: Color(0xFFF1F5F9),
                                  ),
                                  decoration: InputDecoration(
                                    hintText: 'Takım ara',
                                    hintStyle: const TextStyle(
                                      color: Color(0xFF7F8EA3),
                                      fontSize: 12,
                                    ),
                                    prefixIcon: const Icon(
                                      Icons.search_rounded,
                                      size: 18,
                                      color: Color(0xFF94A3B8),
                                    ),
                                    suffixIcon: trackedQuery.isEmpty
                                        ? null
                                        : IconButton(
                                            onPressed: () {
                                              trackedSearchController.clear();
                                              setState(() {
                                                trackedQuery = '';
                                              });
                                            },
                                            icon: const Icon(
                                              Icons.close_rounded,
                                              size: 17,
                                            ),
                                          ),
                                    contentPadding: EdgeInsets.zero,
                                    border: InputBorder.none,
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            OutlinedButton.icon(
                              onPressed: openFinished,
                              style: OutlinedButton.styleFrom(
                                minimumSize: const Size(0, 38),
                                padding:
                                    const EdgeInsets.symmetric(horizontal: 10),
                                foregroundColor: const Color(0xFFD7E1EC),
                                side: const BorderSide(
                                  color: Color(0xFF475569),
                                ),
                              ),
                              icon: const Icon(
                                Icons.archive_outlined,
                                size: 17,
                              ),
                              label: Text(
                                finishedCount > 0
                                    ? 'Arşiv $finishedCount'
                                    : 'Arşiv',
                                style: const TextStyle(
                                  fontSize: 10.5,
                                  fontWeight: FontWeight.w900,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 7),
                      SizedBox(
                        height: 34,
                        child: ListView(
                          scrollDirection: Axis.horizontal,
                          children: [
                            for (final filter in const [
                              'Tümü',
                              '1s',
                              '3s',
                              '6s',
                            ])
                              Padding(
                                padding: const EdgeInsets.only(right: 6),
                                child: ChoiceChip(
                                  label: Text(
                                    filter == '1s'
                                        ? 'Son 1 Saat'
                                        : filter == '3s'
                                            ? '3 Saat'
                                            : filter == '6s'
                                                ? '6 Saat'
                                                : 'Tümü',
                                  ),
                                  selected: trackedTimeFilter == filter,
                                  onSelected: (_) {
                                    setState(() {
                                      trackedTimeFilter = filter;
                                    });
                                  },
                                  visualDensity: VisualDensity.compact,
                                  selectedColor: filter == '1s'
                                      ? const Color(0xFF7C2D12)
                                      : const Color(0xFF334155),
                                  backgroundColor:
                                      const Color(0xFF1E293B),
                                  side: BorderSide(
                                    color: trackedTimeFilter == filter
                                        ? filter == '1s'
                                            ? const Color(0xFFFB923C)
                                            : const Color(0xFF60A5FA)
                                        : const Color(0xFF334155),
                                  ),
                                  labelStyle: TextStyle(
                                    fontSize: 10,
                                    fontWeight: FontWeight.w900,
                                    color: trackedTimeFilter == filter
                                        ? const Color(0xFFF8FAFC)
                                        : const Color(0xFFCBD5E1),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 6),
                      Row(
                        children: [
                          const Text(
                            'AKTİF TAKİP',
                            style: TextStyle(
                              fontSize: 10.5,
                              fontWeight: FontWeight.w900,
                              letterSpacing: .7,
                              color: Color(0xFF94A3B8),
                            ),
                          ),
                          const Spacer(),
                          Text(
                            '${active.length} maç',
                            style: const TextStyle(
                              fontSize: 10,
                              fontWeight: FontWeight.w800,
                              color: Color(0xFF7F8EA3),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          SliverToBoxAdapter(
            child: _DateMatchGroups(
              matches: active,
              archived: false,
              onOpen: openMatch,
              onRemove: remove,
            ),
          ),
          const SliverToBoxAdapter(
            child: SizedBox(height: 18),
          ),
        ],
      ),
    );
  }
}

class FinishedMatchesPage extends StatefulWidget {
  const FinishedMatchesPage({super.key});

  @override
  State<FinishedMatchesPage> createState() => _FinishedMatchesPageState();
}

class _FinishedMatchesPageState extends State<FinishedMatchesPage> {
  bool loading = true;
  String error = '';
  List<Map<String, dynamic>> matches = [];

  String archiveQuery = '';
  String archiveRange = '30g';
  String archiveLeague = 'Tümü';
  final TextEditingController archiveSearchController =
      TextEditingController();

  @override
  void initState() {
    super.initState();
    load();
  }

  @override
  void dispose() {
    archiveSearchController.dispose();
    super.dispose();
  }

  DateTime? archiveMatchDate(Map<String, dynamic> m) {
    final raw = m['match_date']?.toString() ?? '';
    final dm =
        RegExp(r'^(\d{4})-(\d{2})-(\d{2})').firstMatch(raw);

    if (dm == null) return null;

    return DateTime(
      int.parse(dm.group(1)!),
      int.parse(dm.group(2)!),
      int.parse(dm.group(3)!),
    );
  }

  bool archiveVisible(Map<String, dynamic> m) {
    final query = archiveQuery.trim().toLowerCase();

    if (query.isNotEmpty) {
      final searchable = [
        _trackTitle(m),
        m['league'],
      ]
          .whereType<Object>()
          .map((e) => e.toString().toLowerCase())
          .join(' ');

      if (!searchable.contains(query)) return false;
    }

    if (archiveLeague != 'Tümü' &&
        (m['league']?.toString().trim() ?? '') != archiveLeague) {
      return false;
    }

    if (archiveRange == 'Tümü') return true;

    final matchDate = archiveMatchDate(m);
    if (matchDate == null) return false;

    final today = DateTime.now();
    final start = DateTime(today.year, today.month, today.day);

    final days = archiveRange == '7g' ? 7 : 30;
    final oldest = start.subtract(Duration(days: days - 1));

    return !matchDate.isBefore(oldest);
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
              .where((e) => e['archived'] == true)
              .toList()
          : [];
    } catch (e) {
      error = e.toString();
    }

    if (mounted) setState(() => loading = false);
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

  Future<void> openMatch(Map<String, dynamic> m) async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => MatchDetail(
          eventId: m['event_id'].toString(),
          title: _trackTitle(m),
        ),
      ),
    );
    if (mounted) load();
  }

  @override
  Widget build(BuildContext context) {
    final leagueOptions = matches
        .map((m) => m['league']?.toString().trim() ?? '')
        .where((name) => name.isNotEmpty)
        .toSet()
        .toList()
      ..sort();

    final visibleMatches =
        matches.where(archiveVisible).toList()
          ..sort(
            (a, b) => _trackScheduleKey(b)
                .compareTo(_trackScheduleKey(a)),
          );

    final selectedLeagueValue =
        archiveLeague == 'Tümü' || leagueOptions.contains(archiveLeague)
            ? archiveLeague
            : 'Tümü';

    return Scaffold(
      appBar: AppBar(
        title: const Text(
          'Arşiv',
          style: TextStyle(
            fontWeight: FontWeight.w900,
          ),
        ),
      ),
      body: loading
          ? const Center(
              child: CircularProgressIndicator(),
            )
          : error.isNotEmpty
              ? ErrorPane(
                  message: error,
                  retry: load,
                )
              : RefreshIndicator(
                  onRefresh: load,
                  child: CustomScrollView(
                    physics:
                        const AlwaysScrollableScrollPhysics(),
                    slivers: [
                      SliverPersistentHeader(
                        pinned: true,
                        delegate: _PinnedHeaderDelegate(
                          height: 137,
                          child: Material(
                            color: const Color(0xFF111827),
                            elevation: 3,
                            child: Padding(
                              padding: const EdgeInsets.fromLTRB(
                                12,
                                8,
                                12,
                                7,
                              ),
                              child: Column(
                                children: [
                                  SizedBox(
                                    height: 39,
                                    child: TextField(
                                      controller:
                                          archiveSearchController,
                                      onChanged: (value) {
                                        setState(() {
                                          archiveQuery = value;
                                        });
                                      },
                                      style: const TextStyle(
                                        fontSize: 12.5,
                                        color: Color(0xFFF1F5F9),
                                      ),
                                      decoration: InputDecoration(
                                        hintText:
                                            'Takım veya eski maç ara',
                                        hintStyle: const TextStyle(
                                          color: Color(0xFF7F8EA3),
                                          fontSize: 12,
                                        ),
                                        prefixIcon: const Icon(
                                          Icons.search_rounded,
                                          size: 18,
                                          color: Color(0xFF94A3B8),
                                        ),
                                        suffixIcon:
                                            archiveQuery.isEmpty
                                                ? null
                                                : IconButton(
                                                    onPressed: () {
                                                      archiveSearchController
                                                          .clear();
                                                      setState(() {
                                                        archiveQuery = '';
                                                      });
                                                    },
                                                    icon: const Icon(
                                                      Icons.close_rounded,
                                                      size: 17,
                                                    ),
                                                  ),
                                        filled: true,
                                        fillColor:
                                            const Color(0xFF1E293B),
                                        contentPadding:
                                            EdgeInsets.zero,
                                        border: OutlineInputBorder(
                                          borderRadius:
                                              BorderRadius.circular(10),
                                          borderSide:
                                              const BorderSide(
                                            color: Color(0xFF334155),
                                          ),
                                        ),
                                        enabledBorder:
                                            OutlineInputBorder(
                                          borderRadius:
                                              BorderRadius.circular(10),
                                          borderSide:
                                              const BorderSide(
                                            color: Color(0xFF334155),
                                          ),
                                        ),
                                        focusedBorder:
                                            OutlineInputBorder(
                                          borderRadius:
                                              BorderRadius.circular(10),
                                          borderSide:
                                              const BorderSide(
                                            color: Color(0xFF60A5FA),
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                  const SizedBox(height: 6),
                                  SizedBox(
                                    height: 34,
                                    child: Row(
                                      children: [
                                        Expanded(
                                          child: ListView(
                                            scrollDirection:
                                                Axis.horizontal,
                                            children: [
                                              for (final range
                                                  in const [
                                                '7g',
                                                '30g',
                                                'Tümü',
                                              ])
                                                Padding(
                                                  padding:
                                                      const EdgeInsets.only(
                                                    right: 6,
                                                  ),
                                                  child: ChoiceChip(
                                                    label: Text(
                                                      range == '7g'
                                                          ? '7 Gün'
                                                          : range ==
                                                                  '30g'
                                                              ? '30 Gün'
                                                              : 'Tümü',
                                                    ),
                                                    selected:
                                                        archiveRange ==
                                                            range,
                                                    onSelected: (_) {
                                                      setState(() {
                                                        archiveRange =
                                                            range;
                                                      });
                                                    },
                                                    visualDensity:
                                                        VisualDensity
                                                            .compact,
                                                    selectedColor:
                                                        const Color(
                                                      0xFF334155,
                                                    ),
                                                    backgroundColor:
                                                        const Color(
                                                      0xFF1E293B,
                                                    ),
                                                    side: BorderSide(
                                                      color: archiveRange ==
                                                              range
                                                          ? const Color(
                                                              0xFF60A5FA,
                                                            )
                                                          : const Color(
                                                              0xFF334155,
                                                            ),
                                                    ),
                                                    labelStyle:
                                                        TextStyle(
                                                      fontSize: 10,
                                                      fontWeight:
                                                          FontWeight.w900,
                                                      color: archiveRange ==
                                                              range
                                                          ? const Color(
                                                              0xFFF8FAFC,
                                                            )
                                                          : const Color(
                                                              0xFFCBD5E1,
                                                            ),
                                                    ),
                                                  ),
                                                ),
                                            ],
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  const SizedBox(height: 6),
                                  Row(
                                    children: [
                                      Expanded(
                                        child: Container(
                                          height: 37,
                                          padding:
                                              const EdgeInsets.symmetric(
                                            horizontal: 10,
                                          ),
                                          decoration: BoxDecoration(
                                            color: const Color(
                                              0xFF1E293B,
                                            ),
                                            borderRadius:
                                                BorderRadius.circular(9),
                                            border: Border.all(
                                              color: const Color(
                                                0xFF334155,
                                              ),
                                            ),
                                          ),
                                          child:
                                              DropdownButtonHideUnderline(
                                            child: DropdownButton<String>(
                                              value:
                                                  selectedLeagueValue,
                                              isExpanded: true,
                                              dropdownColor:
                                                  const Color(
                                                0xFF1E293B,
                                              ),
                                              icon: const Icon(
                                                Icons
                                                    .keyboard_arrow_down_rounded,
                                                color: Color(
                                                  0xFF94A3B8,
                                                ),
                                              ),
                                              style: const TextStyle(
                                                fontSize: 10.5,
                                                fontWeight:
                                                    FontWeight.w800,
                                                color: Color(
                                                  0xFFDCE5F0,
                                                ),
                                              ),
                                              items: [
                                                const DropdownMenuItem(
                                                  value: 'Tümü',
                                                  child: Text(
                                                    'Tüm ligler',
                                                  ),
                                                ),
                                                for (final league
                                                    in leagueOptions)
                                                  DropdownMenuItem(
                                                    value: league,
                                                    child: Text(
                                                      league,
                                                      maxLines: 1,
                                                      overflow:
                                                          TextOverflow
                                                              .ellipsis,
                                                    ),
                                                  ),
                                              ],
                                              onChanged: (value) {
                                                if (value == null) return;
                                                setState(() {
                                                  archiveLeague =
                                                      value;
                                                });
                                              },
                                            ),
                                          ),
                                        ),
                                      ),
                                      const SizedBox(width: 10),
                                      Text(
                                        '${visibleMatches.length} maç',
                                        style: const TextStyle(
                                          fontSize: 10,
                                          fontWeight:
                                              FontWeight.w800,
                                          color: Color(0xFF8291A6),
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                      if (visibleMatches.isEmpty)
                        const SliverFillRemaining(
                          hasScrollBody: false,
                          child: Center(
                            child: Text(
                              'Filtreye uygun arşiv kaydı yok.',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w700,
                                color: Color(0xFF94A3B8),
                              ),
                            ),
                          ),
                        )
                      else
                        SliverToBoxAdapter(
                          child: _DateMatchGroups(
                            matches: visibleMatches,
                            archived: true,
                            onOpen: openMatch,
                            onRemove: remove,
                          ),
                        ),
                      const SliverToBoxAdapter(
                        child: SizedBox(height: 22),
                      ),
                    ],
                  ),
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
  bool savingMatchInterval = false;
  bool autoRequested = false;
  String error = '';
  String refreshMessage = '';
  String selectedMarket = 'MS';
  String oddsView = 'Özet';

  // Odds Chart - eski grafik state'inden tamamen bağımsız.

  bool showPerformance = false;
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

  bool get isLocked => data['active'] != true;

  String get lockedStatusText {
    final lifecycle = data['lifecycle']?.toString() ?? '';
    final h = data['home_score'];
    final a = data['away_score'];

    if (lifecycle == 'finished') {
      if (h is num && a is num) {
        return 'Maç bitti · Sonuç ' +
            h.toInt().toString() +
            '-' +
            a.toInt().toString() +
            ' · oran geçmişi kilitli';
      }
      return 'Maç bitti · oran geçmişi kilitli';
    }

    return 'Maç başladı · oran takibi durdu · geçmiş oranlar kilitli';
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

      if (error.isEmpty && !isLocked && !hasLatest && !autoRequested) {
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
    if (isLocked) {
      if (!auto && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(lockedStatusText)),
        );
      }
      return;
    }

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

  Future<void> saveMatchInterval(int? minutes) async {
    if (savingMatchInterval || isLocked) return;

    setState(() => savingMatchInterval = true);

    try {
      final d = await api.post(
        '/api/matches/' + widget.eventId + '/refresh-interval',
        {'minutes': minutes},
      );

      if (!mounted) return;

      setState(() {
        data['refresh_minutes'] = d['refresh_minutes'];
        savingMatchInterval = false;
      });

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            minutes == null
                ? 'Bu maç genel çekim aralığını kullanacak.'
                : 'Bu maç $minutes dakikada bir çekilecek.',
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;

      setState(() => savingMatchInterval = false);

      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_friendlyError(e))),
      );
    }
  }

  List<String> _marketKeys(String market) {
    if (market == 'MS') {
      return ['ms1', 'msx', 'ms2'];
    }
    if (market == '1.5') {
      return ['ou15_under', 'ou15_over'];
    }
    if (market == '2.5') {
      return ['ou25_under', 'ou25_over'];
    }
    return ['btts_no', 'btts_yes'];
  }

  List<String> _marketLabels(String market) {
    if (market == 'MS') {
      return ['1', 'X', '2'];
    }
    if (market == '1.5' || market == '2.5') {
      return ['Alt', 'Üst'];
    }
    return ['Yok', 'Var'];
  }

  List<double>? _devig(
    Map<String, dynamic> row,
    List<String> keys,
  ) {
    final raw = <double>[];

    for (final key in keys) {
      final value = row[key];

      if (value is! num || value.toDouble() <= 1.0) {
        return null;
      }

      raw.add(1.0 / value.toDouble());
    }

    final total = raw.fold<double>(
      0,
      (sum, x) => sum + x,
    );

    if (total <= 0) return null;

    return raw
        .map((x) => x / total)
        .toList();
  }

  DateTime? _summaryTime(
    Map<String, dynamic> row,
  ) {
    try {
      return DateTime.parse(
        row['captured_at'].toString(),
      );
    } catch (_) {
      return null;
    }
  }

  Map<String, dynamic> _marketSummary(
    String market,
    Map<String, List<Map<String, dynamic>>>
        histories,
  ) {
    final keys = _marketKeys(market);
    final labels = _marketLabels(market);

    final currentProbabilitySums =
        List<double>.filled(keys.length, 0);

    final probabilityChangeSums =
        List<double>.filled(keys.length, 0);

    final supportCounts =
        List<int>.filled(keys.length, 0);

    int currentBookmakers = 0;
    int comparableBookmakers = 0;

    final bookmakerData =
        <Map<String, dynamic>>[];

    for (final entry in histories.entries) {
      final usable = entry.value.where((row) {
        return _devig(row, keys) != null &&
            _summaryTime(row) != null;
      }).toList();

      usable.sort((a, b) {
        return _summaryTime(a)!
            .compareTo(_summaryTime(b)!);
      });

      if (usable.isEmpty) continue;

      final lastProb =
          _devig(usable.last, keys);

      if (lastProb == null) continue;

      currentBookmakers++;

      for (int i = 0; i < keys.length; i++) {
        currentProbabilitySums[i] +=
            lastProb[i];
      }

      List<double>? changes;

      if (usable.length >= 2) {
        final firstProb =
            _devig(usable.first, keys);

        if (firstProb != null) {
          comparableBookmakers++;

          changes = List<double>.generate(
            keys.length,
            (i) =>
                lastProb[i] - firstProb[i],
          );

          for (int i = 0;
              i < keys.length;
              i++) {
            probabilityChangeSums[i] +=
                changes[i];

            // 0.2 yüzde puandan fazla ise
            // gerçek yön desteği sayıyoruz.
            if (changes[i] > 0.002) {
              supportCounts[i]++;
            }
          }
        }
      }

      bookmakerData.add({
        'bookmaker': entry.key,
        'usable': usable,
        'changes': changes,
      });
    }

    if (currentBookmakers == 0) {
      return {
        'available': false,
      };
    }

    final current = List<double>.generate(
      keys.length,
      (i) =>
          currentProbabilitySums[i] /
          currentBookmakers,
    );

    final changes = List<double>.generate(
      keys.length,
      (i) => comparableBookmakers > 0
          ? probabilityChangeSums[i] /
              comparableBookmakers
          : 0,
    );

    // Önce kaç bookmaker destekliyor ona bak.
    // Eşitlik varsa ortalama değişimi daha
    // yüksek olan tarafı seç.
    int strongestIndex = 0;

    for (int i = 1;
        i < keys.length;
        i++) {
      if (supportCounts[i] >
              supportCounts[strongestIndex] ||
          (supportCounts[i] ==
                  supportCounts[strongestIndex] &&
              changes[i] >
                  changes[strongestIndex])) {
        strongestIndex = i;
      }
    }

    // Ters yönde giden bookmaker varsa ayır.
    final dissenters = <String>[];

    for (final item in bookmakerData) {
      final move = item['changes'];

      if (move is List<double> &&
          move.length > strongestIndex &&
          move[strongestIndex] < -0.002) {
        dissenters.add(
          item['bookmaker'].toString(),
        );
      }
    }

    // ==========================================
    // 15 / 30 / 60 DK HAREKET HIZI
    // ==========================================
    final speeds = <int, double?>{
      15: null,
      30: null,
      60: null,
    };

    for (final minutes in [15, 30, 60]) {
      final values = <double>[];

      for (final item in bookmakerData) {
        final usable =
            item['usable']
                as List<Map<String, dynamic>>;

        if (usable.length < 2) continue;

        final last = usable.last;
        final lastTime =
            _summaryTime(last);

        if (lastTime == null) continue;

        final target = lastTime.subtract(
          Duration(minutes: minutes),
        );

        Map<String, dynamic>? reference;

        for (final row in usable) {
          final t = _summaryTime(row);

          if (t == null) continue;

          if (!t.isAfter(target)) {
            reference = row;
          } else {
            break;
          }
        }

        if (reference == null) continue;

        final from =
            _devig(reference, keys);

        final to =
            _devig(last, keys);

        if (from == null || to == null) {
          continue;
        }

        values.add(
          to[strongestIndex] -
              from[strongestIndex],
        );
      }

      if (values.isNotEmpty) {
        speeds[minutes] =
            values.reduce(
                  (a, b) => a + b,
                ) /
                values.length;
      }
    }

    // ==========================================
    // SERT TEK-TUR HAREKETLER
    // Tum gecmiste tum secenekleri tara.
    // %8+ ve <=35 dk = sert hareket.
    // ==========================================
    final suddenSteps = <Map<String, dynamic>>[];
    final recentSuddenSteps = <Map<String, dynamic>>[];

    for (final item in bookmakerData) {
      final usable =
          item['usable'] as List<Map<String, dynamic>>;

      if (usable.length < 2) continue;

      final latestTime = _summaryTime(usable.last);
      if (latestTime == null) continue;

      final recentCutoff = latestTime.subtract(
        const Duration(minutes: 60),
      );

      for (int i = 1; i < usable.length; i++) {
        final beforeRow = usable[i - 1];
        final afterRow = usable[i];

        final beforeTime = _summaryTime(beforeRow);
        final afterTime = _summaryTime(afterRow);

        if (beforeTime == null || afterTime == null) {
          continue;
        }

        final gapMinutes =
            afterTime.difference(beforeTime).inMinutes.abs();

        if (gapMinutes > 35) continue;

        for (int k = 0; k < keys.length; k++) {
          final beforeRaw = beforeRow[keys[k]];
          final afterRaw = afterRow[keys[k]];

          if (beforeRaw is! num || afterRaw is! num) {
            continue;
          }

          final before = beforeRaw.toDouble();
          final after = afterRaw.toDouble();

          if (before <= 1 || after <= 1) continue;

          final pct =
              ((after - before) / before) * 100;

          if (pct.abs() < 8.0) continue;

          final move = <String, dynamic>{
            'bookmaker': item['bookmaker'].toString(),
            'label': labels[k],
            'before': before,
            'after': after,
            'pct': pct,
            'at': afterTime.toIso8601String(),
            'minutes': gapMinutes,
          };

          suddenSteps.add(move);

          if (!afterTime.isBefore(recentCutoff)) {
            recentSuddenSteps.add(
              Map<String, dynamic>.from(move),
            );
          }
        }
      }
    }

    suddenSteps.sort((a, b) {
      final aa = (a['pct'] as num).toDouble().abs();
      final bb = (b['pct'] as num).toDouble().abs();
      return bb.compareTo(aa);
    });

    recentSuddenSteps.sort((a, b) {
      final aa = (a['pct'] as num).toDouble().abs();
      final bb = (b['pct'] as num).toDouble().abs();
      return bb.compareTo(aa);
    });

    final topSuddenSteps =
        suddenSteps.take(50).toList();

    final topRecentSuddenSteps =
        recentSuddenSteps.take(50).toList();

    return {
      'available': true,
      'labels': labels,
      'current': current,
      'changes': changes,
      'support': supportCounts,
      'current_bookmakers':
          currentBookmakers,
      'comparable_bookmakers':
          comparableBookmakers,
      'strongest_index':
          strongestIndex,
      'dissenters': dissenters,
      'speeds': speeds,
      'sudden_steps':
          topSuddenSteps,
      'recent_sudden_steps':
          topRecentSuddenSteps,
    };
  }


  List<Map<String, dynamic>> _bigMarketMoves(
    String market,
    Map<String, List<Map<String, dynamic>>> histories,
  ) {
    final keys = _marketKeys(market);
    final labels = _marketLabels(market);

    final best = <String, Map<String, dynamic>>{};

    for (final entry in histories.entries) {
      final rows = entry.value.where((row) {
        return _summaryTime(row) != null;
      }).toList();

      rows.sort((a, b) {
        return _summaryTime(a)!
            .compareTo(_summaryTime(b)!);
      });

      for (int i = 0; i < rows.length - 1; i++) {
        final t1 = _summaryTime(rows[i]);
        if (t1 == null) continue;

        for (int j = i + 1; j < rows.length; j++) {
          final t2 = _summaryTime(rows[j]);
          if (t2 == null) continue;

          final minutes =
              t2.difference(t1).inMinutes.abs();

          if (minutes > 120) break;

          for (int k = 0; k < keys.length; k++) {
            final a = rows[i][keys[k]];
            final b = rows[j][keys[k]];

            if (a is! num || b is! num) continue;

            final from = a.toDouble();
            final to = b.toDouble();

            if (from <= 1 || to <= 1) continue;

            final pct =
                ((to - from) / from) * 100;

            if (pct.abs() < 8) continue;

            final direction =
                pct >= 0 ? 'up' : 'down';

            final id =
                entry.key +
                '|' +
                labels[k] +
                '|' +
                direction;

            final move = <String, dynamic>{
              'bookmaker': entry.key,
              'market': market,
              'label': labels[k],
              'before': from,
              'after': to,
              'pct': pct,
              'minutes': minutes,
              'at': t2.toIso8601String(),
            };

            final old = best[id];

            if (old == null ||
                pct.abs() >
                    (old['pct'] as num)
                        .toDouble()
                        .abs()) {
              best[id] = move;
            }
          }
        }
      }
    }

    final result = best.values.toList();

    result.sort((a, b) {
      final aa =
          (a['pct'] as num).toDouble().abs();
      final bb =
          (b['pct'] as num).toDouble().abs();

      return bb.compareTo(aa);
    });

    return result;
  }


  List<Map<String, dynamic>> _allMarketReportMoves(
    Map<String, List<Map<String, dynamic>>> bigMoves,
    Map<String, Map<String, dynamic>> summaries,
  ) {
    final merged = <Map<String, dynamic>>[];
    final seen = <String>{};

    for (final market in ['MS', '1.5', '2.5', 'KG']) {
      final items = <Map<String, dynamic>>[];

      items.addAll(bigMoves[market] ?? const []);

      final summary = summaries[market];

      if (summary != null) {
        final sudden =
            summary['sudden_steps'];

        if (sudden is List) {
          for (final raw in sudden.whereType<Map>()) {
            items.add(
              Map<String, dynamic>.from(raw),
            );
          }
        }
      }

      for (final raw in items) {
        final move =
            Map<String, dynamic>.from(raw);

        move['market'] = market;

        final id =
            market +
            '|' +
            move['bookmaker'].toString() +
            '|' +
            move['label'].toString() +
            '|' +
            move['before'].toString() +
            '|' +
            move['after'].toString() +
            '|' +
            move['at'].toString();

        if (seen.add(id)) {
          merged.add(move);
        }
      }
    }

    merged.sort((a, b) {
      final aa =
          (a['pct'] as num).toDouble().abs();

      final bb =
          (b['pct'] as num).toDouble().abs();

      return bb.compareTo(aa);
    });

    return merged;
  }

  String marketReport(
    List<Map<String, dynamic>> history,
    String market,
    List<ChartSeries> series,
  ) {
    final usable = history.where((row) {
      return series.any(
        (item) => row[item.keyName] is num,
      );
    }).toList();

    if (usable.length < 2) {
      return 'Hareket yorumu için en az iki gerçek oran kaydı gerekiyor.';
    }

    final first = usable.first;
    final last = usable.last;
    final parts = <String>[];
    double strongestDrop = 0;
    String strongestLabel = '';

    for (final item in series) {
      final a = first[item.keyName];
      final b = last[item.keyName];

      if (a is! num || b is! num) continue;

      final opening = a.toDouble();
      final current = b.toDouble();
      final diff = current - opening;

      String move;

      if (diff.abs() < 0.005) {
        move = 'değişmedi';
      } else if (diff < 0) {
        move = opening.toStringAsFixed(2) +
            '→' +
            current.toStringAsFixed(2) +
            ' düştü';
      } else {
        move = opening.toStringAsFixed(2) +
            '→' +
            current.toStringAsFixed(2) +
            ' yükseldi';
      }

      parts.add(item.label + ' ' + move);

      if (diff < strongestDrop) {
        strongestDrop = diff;
        strongestLabel = item.label;
      }
    }

    if (parts.isEmpty) {
      return 'Bu market için yeterli karşılaştırılabilir oran yok.';
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
            ' En belirgin oran düşüşü ' +
            label +
            ' tarafında.';
      } else {
        note +=
            ' En belirgin sıkışma ' +
            strongestLabel +
            ' tarafında.';
      }
    }

    return note;
  }

  Widget _globalOddsReportCard(
    List<Map<String, dynamic>> moves,
    Map<String, Map<String, dynamic>> summaries,
  ) {
    const markets = ['MS', '1.5', '2.5', 'KG'];

    String marketTitle(String market) {
      if (market == 'MS') return 'MS 1 / X / 2';
      if (market == '1.5') return '1.5 ALT / ÜST';
      if (market == '2.5') return '2.5 ALT / ÜST';
      return 'KG YOK / VAR';
    }

    String odd(dynamic value) {
      if (value is! num) return '-';
      return value.toDouble().toStringAsFixed(2);
    }

    String percent(dynamic value) {
      if (value is! num) return '-';

      final v = value.toDouble();

      return (v >= 0 ? '+' : '') +
          v.toStringAsFixed(1) +
          '%';
    }

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF131B17),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: const Color(0xFF314138),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'ORAN RAPORU',
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w900,
              letterSpacing: .8,
            ),
          ),
          const SizedBox(height: 3),
          const Text(
            'Bütün marketler birlikte taranır. Her tarafın sert yükseliş ve düşüşü ayrı gösterilir.',
            style: TextStyle(
              fontSize: 9,
              height: 1.35,
              color: Color(0xFF8E9B94),
            ),
          ),
          const SizedBox(height: 10),

          for (final market in markets)
            Builder(
              builder: (context) {
                final summary = summaries[market];

                if (summary == null ||
                    summary['available'] != true) {
                  return const SizedBox.shrink();
                }

                final labels =
                    (summary['labels'] as List)
                        .cast<String>();

                final marketMoves = moves
                    .where(
                      (m) =>
                          m['market']?.toString() ==
                          market,
                    )
                    .toList();

                final rows = <Widget>[];

                for (final label in labels) {
                  Map<String, dynamic>? strongestUp;
                  Map<String, dynamic>? strongestDown;

                  for (final move in marketMoves) {
                    if (move['label']?.toString() !=
                        label) {
                      continue;
                    }

                    final raw = move['pct'];
                    if (raw is! num) continue;

                    final pct = raw.toDouble();

                    if (pct >= 0) {
                      if (strongestUp == null ||
                          pct.abs() >
                              (strongestUp['pct']
                                      as num)
                                  .toDouble()
                                  .abs()) {
                        strongestUp = move;
                      }
                    } else {
                      if (strongestDown == null ||
                          pct.abs() >
                              (strongestDown['pct']
                                      as num)
                                  .toDouble()
                                  .abs()) {
                        strongestDown = move;
                      }
                    }
                  }

                  final selected =
                      <Map<String, dynamic>>[];

                  if (strongestUp != null) {
                    selected.add(strongestUp);
                  }

                  if (strongestDown != null) {
                    selected.add(strongestDown);
                  }

                  selected.sort((a, b) {
                    final aa =
                        (a['pct'] as num)
                            .toDouble()
                            .abs();

                    final bb =
                        (b['pct'] as num)
                            .toDouble()
                            .abs();

                    return bb.compareTo(aa);
                  });

                  if (selected.isEmpty) {
                    rows.add(
                      Padding(
                        padding:
                            const EdgeInsets.only(
                          bottom: 4,
                        ),
                        child: Row(
                          children: [
                            SizedBox(
                              width: 35,
                              child: Text(
                                label,
                                style:
                                    const TextStyle(
                                  fontSize: 10,
                                  fontWeight:
                                      FontWeight.w900,
                                  color: Color(
                                    0xFF60A5FA,
                                  ),
                                ),
                              ),
                            ),
                            const Expanded(
                              child: Text(
                                'Belirgin sert hareket yok',
                                style: TextStyle(
                                  fontSize: 9,
                                  color: Color(
                                    0xFF94A3B8,
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    );

                    continue;
                  }

                  for (final move in selected) {
                    rows.add(
                      Padding(
                        padding:
                            const EdgeInsets.only(
                          bottom: 5,
                        ),
                        child: Row(
                          crossAxisAlignment:
                              CrossAxisAlignment.start,
                          children: [
                            SizedBox(
                              width: 35,
                              child: Text(
                                label,
                                style:
                                    const TextStyle(
                                  fontSize: 10,
                                  fontWeight:
                                      FontWeight.w900,
                                  color: Color(
                                    0xFF60A5FA,
                                  ),
                                ),
                              ),
                            ),
                            Expanded(
                              child: Text(
                                move['bookmaker']
                                        .toString() +
                                    ' · ' +
                                    odd(
                                      move['before'],
                                    ) +
                                    ' → ' +
                                    odd(
                                      move['after'],
                                    ) +
                                    ' · ' +
                                    percent(
                                      move['pct'],
                                    ) +
                                    ' · ' +
                                    move['minutes']
                                        .toString() +
                                    ' dk · ' +
                                    stamp(
                                      move['at'],
                                    ),
                                style:
                                    const TextStyle(
                                  fontSize: 9.5,
                                  height: 1.3,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    );
                  }
                }

                return Container(
                  width: double.infinity,
                  margin: const EdgeInsets.only(
                    bottom: 9,
                  ),
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: const Color(
                      0xFF151E2B,
                    ),
                    borderRadius:
                        BorderRadius.circular(10),
                  ),
                  child: Column(
                    crossAxisAlignment:
                        CrossAxisAlignment.start,
                    children: [
                      Text(
                        marketTitle(market),
                        style: const TextStyle(
                          fontSize: 11,
                          fontWeight:
                              FontWeight.w900,
                        ),
                      ),
                      const SizedBox(height: 7),
                      ...rows,
                    ],
                  ),
                );
              },
            ),

          const Text(
            'Bu rapor tahmin değildir; oran geçmişindeki sert hareketleri gösterir.',
            style: TextStyle(
              fontSize: 8.5,
              color: Color(0xFF68746E),
            ),
          ),
        ],
      ),
    );
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

    final historyGroups = data['history_groups'] is List
        ? (data['history_groups'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList()
        : <Map<String, dynamic>>[];

    // Odds Chart - tum bookmaker verisi.
    final allLatest = data['all_latest_rows'] is List
        ? (data['all_latest_rows'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList()
        : <Map<String, dynamic>>[];

    final allHistoryGroups = data['all_history_groups'] is List
        ? (data['all_history_groups'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList()
        : <Map<String, dynamic>>[];

    final marketStateEvents = data['market_state_events'] is List
        ? (data['market_state_events'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList()
        : <Map<String, dynamic>>[];

    final openingOdds = data['opening_odds'] is List
        ? (data['opening_odds'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList()
        : <Map<String, dynamic>>[];

    String bookmakerKey(dynamic raw) => raw
        .toString()
        .toLowerCase()
        .replaceAll(RegExp(r'\s+'), '');

    final bookmakerNames = <String>[];
    final seenBookmakers = <String>{};

    for (final row in latest) {
      final name = row['bookmaker']?.toString().trim() ?? '';
      final key = bookmakerKey(name);

      if (name.isEmpty || seenBookmakers.contains(key)) continue;

      seenBookmakers.add(key);
      bookmakerNames.add(name);
    }

    final historiesByBookmaker =
        <String, List<Map<String, dynamic>>>{};

    for (final bookmaker in bookmakerNames.take(3)) {
      final wanted = bookmakerKey(bookmaker);
      final bookmakerHistory =
          <Map<String, dynamic>>[];

      for (final group in historyGroups) {
        final capturedAt = group['captured_at'];
        final rows = group['rows'];

        Map<String, dynamic>? matched;

        if (rows is List) {
          for (final raw in rows.whereType<Map>()) {
            final row =
                Map<String, dynamic>.from(raw);

            if (bookmakerKey(row['bookmaker']) ==
                wanted) {
              matched = row;
              break;
            }
          }
        }

        if (matched != null) {
          bookmakerHistory.add({
            ...matched,
            'captured_at':
                capturedAt ?? matched['captured_at'],
          });
        } else {
          bookmakerHistory.add({
            'bookmaker': bookmaker,
            'captured_at': capturedAt,
            '_missing': true,
          });
        }
      }

      bookmakerHistory.sort((a, b) {
        DateTime? da;
        DateTime? db;

        try {
          da = DateTime.parse(
            a['captured_at']?.toString() ?? '',
          );
        } catch (_) {}

        try {
          db = DateTime.parse(
            b['captured_at']?.toString() ?? '',
          );
        } catch (_) {}

        if (da == null && db == null) return 0;
        if (da == null) return 1;
        if (db == null) return -1;

        return da.compareTo(db);
      });

      historiesByBookmaker[bookmaker] =
          bookmakerHistory;
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.title,
          overflow: TextOverflow.ellipsis,
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(48),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Container(
              height: 40,
              padding: const EdgeInsets.all(3),
              decoration: BoxDecoration(
                color: const Color(0xFF121914),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: const Color(0xFF29352E)),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: _DetailTabButton(
                      icon: Icons.show_chart_rounded,
                      label: 'Oranlar',
                      selected: !showPerformance,
                      onTap: () => setState(() => showPerformance = false),
                    ),
                  ),
                  Expanded(
                    child: _DetailTabButton(
                      icon: Icons.insights_rounded,
                      label: 'Performans',
                      selected: showPerformance,
                      onTap: () => setState(() => showPerformance = true),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
      body: showPerformance
          ? PerformancePanel(
              eventId: widget.eventId,
              title: widget.title,
            )
          : (loading
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
                                (refreshing || isLocked) ? null : () => refreshNow(),
                            icon: isLocked
                                ? const Icon(Icons.lock_outline, size: 17)
                                : refreshing
                                    ? const SizedBox(
                                        width: 14,
                                        height: 14,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                        ),
                                      )
                                    : const Icon(Icons.refresh, size: 17),
                            label: Text(
                              isLocked
                                  ? 'Kilitli'
                                  : refreshing
                                      ? 'Çekiliyor…'
                                      : 'Şimdi güncelle',
                              style: const TextStyle(fontSize: 11),
                            ),
                          ),
                        ],
                      ),
                      if (isLocked) ...[
                        const SizedBox(height: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 11,
                            vertical: 10,
                          ),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(10),
                            color: const Color(0xFF151E2B),
                            border: Border.all(
                              color: const Color(0xFF334155),
                            ),
                          ),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Icon(Icons.lock_outline, size: 17),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  lockedStatusText,
                                  style: const TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                      if (refreshMessage.isNotEmpty) ...[
                        const SizedBox(height: 7),
                        Container(
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 8,
                          ),
                          decoration: BoxDecoration(
                            borderRadius: BorderRadius.circular(9),
                            color: const Color(0xFF151E2B),
                          ),
                          child: Text(
                            refreshMessage,
                            style: const TextStyle(fontSize: 11),
                          ),
                        ),
                      ],

                      const SizedBox(height: 10),

                        const Text("Bu maçın çekim sıklığı", style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800)),
                        const SizedBox(height: 6),
                        Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [
                            for (final int? x in const <int?>[null, 120, 60, 45, 30, 15, 10, 5])
                              ChoiceChip(
                                label: Text(x == null ? "Genel" : "$x dk", style: const TextStyle(fontSize: 10)),
                                selected: x == null ? data["refresh_minutes"] == null : (data["refresh_minutes"] as num?)?.toInt() == x,
                                onSelected: savingMatchInterval || isLocked ? null : (_) => saveMatchInterval(x),
                              ),
                          ],
                        ),
                        const SizedBox(height: 10),
                      Container(
                        height: 42,
                        padding: const EdgeInsets.all(3),
                        decoration: BoxDecoration(
                          color: const Color(0xFF111827),
                          borderRadius:
                              BorderRadius.circular(11),
                          border: Border.all(
                            color:
                                const Color(0xFF334155),
                          ),
                        ),
                        child: Row(
                          children: [
                            for (final view in const [
                                'Özet',
                                'Grafik',
                                'Geçmiş',
                              ])
                              Expanded(
                                child: Material(
                                  color: oddsView == view
                                      ? const Color(
                                          0xFF1E3A5F,
                                        )
                                      : Colors.transparent,
                                  borderRadius:
                                      BorderRadius.circular(
                                    8,
                                  ),
                                  child: InkWell(
                                    borderRadius:
                                        BorderRadius.circular(
                                      8,
                                    ),
                                    onTap: () {
                                      setState(() {
                                        oddsView = view;
                                      });
                                    },
                                    child: Center(
                                      child: Text(
                                        view,
                                        style: TextStyle(
                                          fontSize: 11,
                                          fontWeight:
                                              FontWeight.w800,
                                          color:
                                              oddsView == view
                                                  ? const Color(
                                                      0xFFF1F5F9,
                                                    )
                                                  : const Color(
                                                      0xFF94A3B8,
                                                    ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),

                      const SizedBox(height: 10),

                        OddsChart(
                          latestRows: allLatest,
                          historyGroups: allHistoryGroups,
                          marketStateEvents: marketStateEvents,
                          openingOdds: openingOdds,
                          view: oddsView,
                        ),


                    ],
                  ),
                )),
    );
  }
}

class _DetailTabButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _DetailTabButton({
    required this.icon,
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: selected ? const Color(0xFF1E3A5F) : Colors.transparent,
      borderRadius: BorderRadius.circular(9),
      child: InkWell(
        borderRadius: BorderRadius.circular(9),
        onTap: onTap,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              icon,
              size: 17,
              color: selected
                  ? const Color(0xFF60A5FA)
                  : const Color(0xFF94A3B8),
            ),
            const SizedBox(width: 7),
            Text(
              label,
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w800,
                color: selected
                    ? const Color(0xFFF1F5F9)
                    : const Color(0xFF94A3B8),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class PerformancePanel extends StatefulWidget {
  final String eventId;
  final String title;

  const PerformancePanel({
    super.key,
    required this.eventId,
    required this.title,
  });

  @override
  State<PerformancePanel> createState() => _PerformancePanelState();
}

class _PerformancePanelState extends State<PerformancePanel>
    with AutomaticKeepAliveClientMixin {
  bool loading = true;
  bool refreshing = false;
  bool loadedFromCache = false;
  String error = '';
  String refreshError = '';
  Map<String, dynamic> data = {};

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    load();
  }

  Map<String, dynamic> _map(dynamic v) {
    return v is Map ? Map<String, dynamic>.from(v) : <String, dynamic>{};
  }

  List<Map<String, dynamic>> _maps(dynamic v) {
    return v is List
        ? v.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
        : <Map<String, dynamic>>[];
  }

  String _value(dynamic v, {int decimals = 2}) {
    if (v == null) return '—';
    if (v is num) {
      if (v.toDouble() == v.toInt().toDouble()) return v.toInt().toString();
      return v.toDouble().toStringAsFixed(decimals);
    }
    final n = double.tryParse(v.toString());
    if (n != null) return n.toStringAsFixed(decimals);
    return v.toString();
  }

  String _record(Map<String, dynamic> team, String period) {
    final p = _map(team[period]);
    final r = _map(p['sonuc']);
    if (r.isEmpty) return '—';
    return _value(r['galibiyet'], decimals: 0) +
        'G  ' +
        _value(r['beraberlik'], decimals: 0) +
        'B  ' +
        _value(r['maglubiyet'], decimals: 0) +
        'M';
  }

  Future<void> load({bool force = false}) async {
    if (!force) {
      final cached = await readLocalPerformance(widget.eventId);

      if (cached != null && _hasPerformanceData(cached)) {
        data = cached;
        loadedFromCache = true;

        if (mounted) {
          setState(() {
            loading = false;
            refreshing = false;
            error = '';
            refreshError = '';
          });
        }
        return;
      }
    }

    if (mounted) {
      setState(() {
        if (data.isEmpty) {
          loading = true;
        } else {
          refreshing = true;
        }
        error = '';
        refreshError = '';
      });
    }

    try {
      final fresh = await fetchPerformancePersistent(
        widget.eventId,
        force: force,
      );

      data = fresh;
      loadedFromCache = false;

      if (mounted) {
        setState(() {
          loading = false;
          refreshing = false;
          error = '';
          refreshError = '';
        });
      }
    } catch (e) {
      final message = _friendlyPerformanceError(e);

      if (mounted) {
        setState(() {
          loading = false;
          refreshing = false;

          if (data.isEmpty) {
            error = message;
          } else {
            refreshError = message;
          }
        });
      }
    }
  }

  Future<void> refresh() async {
    await load(force: true);
  }

  Widget _sectionTitle(String text, {String? trailing}) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(3, 14, 3, 7),
      child: Row(
        children: [
          Text(
            text.toUpperCase(),
            style: const TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w900,
              letterSpacing: .9,
              color: Color(0xFF9AA8A0),
            ),
          ),
          const Spacer(),
          if (trailing != null)
            Text(
              trailing,
              style: const TextStyle(
                fontSize: 10,
                color: Color(0xFF748078),
              ),
            ),
        ],
      ),
    );
  }

  Widget _metricRow(
    String label,
    String left,
    String right, {
    String? hint,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: const BoxDecoration(
        border: Border(
          bottom: BorderSide(color: Color(0xFF263029), width: .8),
        ),
      ),
      child: Row(
        children: [
          SizedBox(
            width: 84,
            child: Text(
              left,
              textAlign: TextAlign.left,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w900,
                color: Color(0xFFE7ECE9),
              ),
            ),
          ),
          Expanded(
            child: Column(
              children: [
                Text(
                  label,
                  textAlign: TextAlign.center,
                  style: const TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF98A39D),
                  ),
                ),
                if (hint != null)
                  Text(
                    hint,
                    style: const TextStyle(
                      fontSize: 9,
                      color: Color(0xFF66736B),
                    ),
                  ),
              ],
            ),
          ),
          SizedBox(
            width: 84,
            child: Text(
              right,
              textAlign: TextAlign.right,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w900,
                color: Color(0xFFE7ECE9),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _teamHeader(String left, String right) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 10),
      decoration: const BoxDecoration(
        color: Color(0xFF151E2B),
        borderRadius: BorderRadius.vertical(top: Radius.circular(14)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              left,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 8),
            child: Text(
              'VS',
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w900,
                color: Color(0xFF60A5FA),
                letterSpacing: 1.1,
              ),
            ),
          ),
          Expanded(
            child: Text(
              right,
              maxLines: 2,
              textAlign: TextAlign.right,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w900,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _summaryCard(
    Map<String, dynamic> home,
    Map<String, dynamic> away,
  ) {
    final h5 = _map(home['son5']);
    final a5 = _map(away['son5']);
    final h10 = _map(home['son10']);
    final a10 = _map(away['son10']);
    final hl = _map(home['ligDurumu']);
    final al = _map(away['ligDurumu']);

    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF111712),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFF26322B)),
      ),
      child: Column(
        children: [
          _teamHeader(
            home['takim']?.toString() ?? 'Ev',
            away['takim']?.toString() ?? 'Dep.',
          ),
          _metricRow('Son 5', _record(home, 'son5'), _record(away, 'son5')),
          _metricRow('Son 10', _record(home, 'son10'), _record(away, 'son10')),
          _metricRow(
            'xG',
            _value(h10['xG']),
            _value(a10['xG']),
            hint: 'Son 10 ort.',
          ),
          _metricRow(
            'xGA',
            _value(h10['xGA']),
            _value(a10['xGA']),
            hint: 'Son 10 ort.',
          ),
          _metricRow(
            'xG veri',
            _value(h10['xGVerisi'], decimals: 0) + '/10',
            _value(a10['xGVerisi'], decimals: 0) + '/10',
          ),
          _metricRow(
            'Lig sıra',
            hl['sira'] == null ? '—' : '#' + _value(hl['sira'], decimals: 0),
            al['sira'] == null ? '—' : '#' + _value(al['sira'], decimals: 0),
          ),
          _metricRow(
            'Puan',
            _value(hl['puan'], decimals: 0),
            _value(al['puan'], decimals: 0),
          ),
          _metricRow(
            'Gol',
            _value(hl['attigiGol'], decimals: 0) +
                ' / ' +
                _value(hl['yedigiGol'], decimals: 0),
            _value(al['attigiGol'], decimals: 0) +
                ' / ' +
                _value(al['yedigiGol'], decimals: 0),
            hint: 'Attı / yedi',
          ),
        ],
      ),
    );
  }

  Widget _availabilityCard(
    Map<String, dynamic> home,
    Map<String, dynamic> away,
  ) {
    final h = _maps(home['eksikler']);
    final a = _maps(away['eksikler']);
    final hAvailable = home['eksikVerisi'] == true;
    final aAvailable = away['eksikVerisi'] == true;

    Widget mini(
      String team,
      List<Map<String, dynamic>> rows,
      bool available,
    ) {
      final rated = rows
          .where((x) => x['rating'] is num)
          .map((x) => (x['rating'] as num).toDouble())
          .toList();
      rated.sort((a, b) => b.compareTo(a));
      final top = rated.isEmpty ? null : rated.first;

      return Expanded(
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: const Color(0xFF151C17),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: const Color(0xFF26322B)),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                team,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 11,
                  color: Color(0xFFA5B0AA),
                ),
              ),
              const SizedBox(height: 5),
              Text(
                available ? rows.length.toString() + ' eksik' : 'veri yok',
                style: const TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w900,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                !available
                    ? 'FotMob eksik listesi gelmedi'
                    : top == null
                        ? 'rating yok'
                        : 'en yüksek rating ' + top.toStringAsFixed(2),
                style: const TextStyle(
                  fontSize: 9,
                  color: Color(0xFF7E8A83),
                ),
              ),
            ],
          ),
        ),
      );
    }

    return Row(
      children: [
        mini(home['takim']?.toString() ?? 'Ev', h, hAvailable),
        const SizedBox(width: 8),
        mini(away['takim']?.toString() ?? 'Dep.', a, aAvailable),
      ],
    );
  }

  Widget _missingExpansion(
    Map<String, dynamic> home,
    Map<String, dynamic> away,
  ) {
    final h = _maps(home['eksikler']);
    final a = _maps(away['eksikler']);
    final hAvailable = home['eksikVerisi'] == true;
    final aAvailable = away['eksikVerisi'] == true;

    Widget list(
      String team,
      List<Map<String, dynamic>> rows,
      bool available,
    ) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 8, 4, 5),
            child: Text(
              team,
              style: const TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w900,
                color: Color(0xFF60A5FA),
              ),
            ),
          ),
          if (!available)
            const Padding(
              padding: EdgeInsets.all(6),
              child: Text(
                'Eksik oyuncu verisi alınamadı.',
                style: TextStyle(
                  fontSize: 11,
                  color: Color(0xFF94A3B8),
                ),
              ),
            )
          else if (rows.isEmpty)
            const Padding(
              padding: EdgeInsets.all(6),
              child: Text(
                'Kayıtlı eksik oyuncu yok.',
                style: TextStyle(
                  fontSize: 11,
                  color: Color(0xFF94A3B8),
                ),
              ),
            ),
          if (available)
            for (final p in rows)
              Container(
                margin: const EdgeInsets.only(bottom: 5),
                padding: const EdgeInsets.symmetric(
                  horizontal: 9,
                  vertical: 7,
                ),
                decoration: BoxDecoration(
                  color: const Color(0xFF111827),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        p['ad']?.toString() ?? '-',
                        style: const TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                    Text(
                      p['durum']?.toString() ?? '-',
                      style: const TextStyle(
                        fontSize: 9,
                        fontWeight: FontWeight.w900,
                        color: Color(0xFFFFB66E),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      p['rating'] is num
                          ? (p['rating'] as num).toStringAsFixed(2)
                          : '—',
                      style: const TextStyle(
                        fontSize: 10,
                        color: Color(0xFFAAB3AE),
                      ),
                    ),
                  ],
                ),
              ),
        ],
      );
    }

    final knownCount =
        (hAvailable ? h.length : 0) + (aAvailable ? a.length : 0);
    final bothKnown = hAvailable && aAvailable;

    return Card(
      margin: EdgeInsets.zero,
      child: ExpansionTile(
        title: const Text(
          'Eksik oyuncu detayları',
          style: TextStyle(
            fontSize: 13,
            fontWeight: FontWeight.w800,
          ),
        ),
        subtitle: Text(
          bothKnown
              ? knownCount.toString() + ' oyuncu'
              : 'veri kapsamı kısmi',
          style: const TextStyle(fontSize: 10),
        ),
        childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
        children: [
          list(
            home['takim']?.toString() ?? 'Ev',
            h,
            hAvailable,
          ),
          list(
            away['takim']?.toString() ?? 'Dep.',
            a,
            aAvailable,
          ),
        ],
      ),
    );
  }

  Widget _fixtureExpansion(
    Map<String, dynamic> home,
    Map<String, dynamic> away,
  ) {
    Widget team(String name, Map<String, dynamic> t) {
      final rows = _maps(t['sonrakiMaclar']);
      final dense = _map(t['fiksturYogunlugu']);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 8, 4, 4),
            child: Text(
              name +
                  ' · 7g ' +
                  _value(dense['sonraki7Gun'], decimals: 0) +
                  ' / 14g ' +
                  _value(dense['sonraki14Gun'], decimals: 0),
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w800,
                color: Color(0xFF60A5FA),
              ),
            ),
          ),
          for (final m in rows.take(3))
            Padding(
              padding: const EdgeInsets.fromLTRB(6, 4, 6, 4),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      (m['ev']?.toString() ?? '-') +
                          ' - ' +
                          (m['deplasman']?.toString() ?? '-'),
                      style: const TextStyle(fontSize: 11),
                    ),
                  ),
                  Text(
                    _shortDate(m['tarih']),
                    style: const TextStyle(
                      fontSize: 9,
                      color: Color(0xFF8A968F),
                    ),
                  ),
                ],
              ),
            ),
        ],
      );
    }

    return Card(
      margin: EdgeInsets.zero,
      child: ExpansionTile(
        title: const Text(
          'Fikstür yoğunluğu',
          style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800),
        ),
        subtitle: const Text(
          'Sonraki maçlar ve 7/14 günlük yük',
          style: TextStyle(fontSize: 10),
        ),
        childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
        children: [
          team(home['takim']?.toString() ?? 'Ev', home),
          team(away['takim']?.toString() ?? 'Dep.', away),
        ],
      ),
    );
  }

  String _shortDate(dynamic raw) {
    if (raw == null) return '—';
    try {
      final d = DateTime.parse(raw.toString()).toLocal();
      return d.day.toString().padLeft(2, '0') +
          '.' +
          d.month.toString().padLeft(2, '0') +
          ' ' +
          d.hour.toString().padLeft(2, '0') +
          ':' +
          d.minute.toString().padLeft(2, '0');
    } catch (_) {
      return raw.toString();
    }
  }

  Widget _h2h(Map<String, dynamic> raw) {
    final rows = _maps(raw['maclar']);
    return Card(
      margin: EdgeInsets.zero,
      child: ExpansionTile(
        initiallyExpanded: rows.isNotEmpty,
        title: const Text(
          'İkili rekabet (H2H)',
          style: TextStyle(fontSize: 13, fontWeight: FontWeight.w800),
        ),
        subtitle: Text(
          rows.length.toString() + '/4 maç bulundu',
          style: const TextStyle(fontSize: 10),
        ),
        childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
        children: [
          if (rows.isEmpty)
            const Padding(
              padding: EdgeInsets.all(8),
              child: Text(
                'Geçmiş karşılaşma bulunamadı.',
                style: TextStyle(fontSize: 11, color: Color(0xFF94A3B8)),
              ),
            ),
          for (final m in rows)
            Container(
              margin: const EdgeInsets.only(bottom: 5),
              padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 8),
              decoration: BoxDecoration(
                color: const Color(0xFF111827),
                borderRadius: BorderRadius.circular(9),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      (m['ev']?.toString() ?? '-') +
                          ' ' +
                          _value(m['evGol'], decimals: 0) +
                          '-' +
                          _value(m['deplasmanGol'], decimals: 0) +
                          ' ' +
                          (m['deplasman']?.toString() ?? '-'),
                      style: const TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  Text(
                    _shortDate(m['tarih']).split(' ').first,
                    style: const TextStyle(
                      fontSize: 9,
                      color: Color(0xFF8A968F),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);

    if (loading) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: 12),
            Text(
              'Performans verileri hazırlanıyor…',
              style: TextStyle(fontSize: 11, color: Color(0xFF97A39C)),
            ),
          ],
        ),
      );
    }

    if (error.isNotEmpty) {
      return ErrorPane(message: error, retry: load);
    }

    final home = _map(data['evTakimi']);
    final away = _map(data['deplasmanTakimi']);
    final h2h = _map(data['h2h']);

    if (home.isEmpty || away.isEmpty) {
      return ErrorPane(
        message: 'Performans verisi eksik geldi.',
        retry: load,
      );
    }

    return RefreshIndicator(
      onRefresh: refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 24),
        children: [
          _sectionTitle('Genel karşılaştırma', trailing: 'FotMob'),
          _summaryCard(home, away),
          Padding(
            padding: const EdgeInsets.fromLTRB(3, 8, 3, 0),
            child: Row(
              children: [
                Icon(
                  loadedFromCache
                      ? Icons.offline_pin_outlined
                      : Icons.cloud_done_outlined,
                  size: 13,
                  color: const Color(0xFF6F7C74),
                ),
                const SizedBox(width: 5),
                Expanded(
                  child: Text(
                    loadedFromCache
                        ? 'Telefona kaydedilmiş performans verisi'
                        : 'Performans verisi telefona kaydedildi',
                    style: const TextStyle(
                      fontSize: 9,
                      color: Color(0xFF6F7C74),
                    ),
                  ),
                ),
                if (refreshing)
                  const SizedBox(
                    width: 12,
                    height: 12,
                    child: CircularProgressIndicator(strokeWidth: 1.5),
                  )
                else
                  InkWell(
                    onTap: refresh,
                    borderRadius: BorderRadius.circular(20),
                    child: const Padding(
                      padding: EdgeInsets.symmetric(
                        horizontal: 7,
                        vertical: 4,
                      ),
                      child: Row(
                        children: [
                          Icon(
                            Icons.refresh_rounded,
                            size: 13,
                            color: Color(0xFF60A5FA),
                          ),
                          SizedBox(width: 3),
                          Text(
                            'Yenile',
                            style: TextStyle(
                              fontSize: 9,
                              fontWeight: FontWeight.w800,
                              color: Color(0xFF60A5FA),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (refreshError.isNotEmpty)
            Container(
              margin: const EdgeInsets.only(top: 7),
              padding: const EdgeInsets.symmetric(
                horizontal: 9,
                vertical: 7,
              ),
              decoration: BoxDecoration(
                color: const Color(0xFF2B2117),
                borderRadius: BorderRadius.circular(9),
              ),
              child: Text(
                refreshError + ' · Kayıtlı veri gösteriliyor.',
                style: const TextStyle(
                  fontSize: 9,
                  color: Color(0xFFFFC88A),
                ),
              ),
            ),
          _sectionTitle('Kadro durumu'),
          _availabilityCard(home, away),
          const SizedBox(height: 8),
          _missingExpansion(home, away),
          _sectionTitle('Fikstür'),
          _fixtureExpansion(home, away),
          _sectionTitle('Geçmiş karşılaşmalar'),
          _h2h(h2h),
          const SizedBox(height: 10),
          const Center(
            child: Text(
              'Veriler analiz amaçlıdır · xG olmayan maçlar ortalamaya katılmaz',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 9,
                color: Color(0xFF68736D),
              ),
            ),
          ),
        ],
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

class OddsChart extends StatefulWidget {
  final List<Map<String, dynamic>> latestRows;
  final List<Map<String, dynamic>> historyGroups;
  final List<Map<String, dynamic>> marketStateEvents;
  final List<Map<String, dynamic>> openingOdds;
  final String view;

  const OddsChart({
    super.key,
    required this.latestRows,
    required this.historyGroups,
    required this.marketStateEvents,
    required this.openingOdds,
    this.view = 'Grafik',
  });

  @override
  State<OddsChart> createState() => _OddsChartState();
}

class _OddsChartState extends State<OddsChart> {
  String market = 'MS';
  String selection = 'Tümü';
  String range = 'Tümü';
  final Set<String> selectedBookmakers = <String>{};
  String? historyBookmaker;
  int historyPageSize = 50;
  int historyPage = 0;

  // Parmakla grafikte seçilen an.
  DateTime? selectedTime;

  @override
  void initState() {
    super.initState();
    _seedBookmakers();
  }

  @override
  void didUpdateWidget(covariant OddsChart oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (selectedBookmakers.isEmpty &&
        oldWidget.latestRows.isEmpty &&
        widget.latestRows.isNotEmpty) {
      _seedBookmakers();
    }

    final names = _bookmakerNames();
    if (names.isNotEmpty &&
        (historyBookmaker == null ||
            !names.any(
              (name) =>
                  _bookmakerKey(name) ==
                  _bookmakerKey(historyBookmaker),
            ))) {
      historyBookmaker = names.first;
    }
  }

  void _seedBookmakers() {
    final names = _bookmakerNames();

    for (final name in names.take(5)) {
      selectedBookmakers.add(name);
    }

    if (historyBookmaker == null && names.isNotEmpty) {
      historyBookmaker = names.first;
    }
  }

  bool _isBookmakerSelected(String name) {
    if (widget.view == 'Geçmiş') {
      return historyBookmaker != null &&
          _bookmakerKey(historyBookmaker) ==
              _bookmakerKey(name);
    }

    return selectedBookmakers.contains(name);
  }

  Future<void> _openFullscreenChart(
    List<_OddsSeries> chartSeries,
  ) async {
    if (chartSeries.isEmpty) return;

    final picked = await Navigator.of(context).push<DateTime?>(
      MaterialPageRoute(
        builder: (_) => _FullscreenOddsChartPage(
          initialSelectedTime: selectedTime,
          initialMarket: market,
          initialSelection: selection,
          bookmakerNames: _bookmakerNames(),
          initialBookmakers: chartSeries
              .map((item) => item.bookmaker)
              .toSet(),
          seriesBuilder: (
            marketValue,
            selectionValue,
            bookmakerValues,
          ) =>
              _series(
            marketOverride: marketValue,
            selectionOverride: selectionValue,
            bookmakersOverride: bookmakerValues,
          ),
        ),
      ),
    );

    if (!mounted || picked == null) return;

    setState(() {
      selectedTime = picked;
    });
  }

  String _bookmakerKey(dynamic raw) {
    return raw
        .toString()
        .trim()
        .toLowerCase()
        .replaceAll(RegExp(r'\s+'), '');
  }

  List<String> _bookmakerNames() {
    final out = <String>[];
    final seen = <String>{};

    for (final row in widget.latestRows) {
      final name = row['bookmaker']?.toString().trim() ?? '';
      final key = _bookmakerKey(name);

      if (name.isEmpty || seen.contains(key)) continue;

      seen.add(key);
      out.add(name);
    }


    for (final group in widget.historyGroups) {
      final rows = group['rows'];
      if (rows is! List) continue;

      for (final raw in rows.whereType<Map>()) {
        final row = Map<String, dynamic>.from(raw);
        final name = row['bookmaker']?.toString().trim() ?? '';
        final key = _bookmakerKey(name);

        if (name.isEmpty || seen.contains(key)) continue;

        seen.add(key);
        out.add(name);
      }
    }

    return out;
  }

  List<MapEntry<String, String>> _marketOutcomesFor(String value) {
    if (value == 'MS') {
      return const [
        MapEntry('1', 'ms1'),
        MapEntry('X', 'msx'),
        MapEntry('2', 'ms2'),
      ];
    }

    if (value == '1.5') {
      return const [
        MapEntry('Alt', 'ou15_under'),
        MapEntry('Üst', 'ou15_over'),
      ];
    }

    if (value == '2.5') {
      return const [
        MapEntry('Alt', 'ou25_under'),
        MapEntry('Üst', 'ou25_over'),
      ];
    }

    return const [
      MapEntry('Var', 'btts_yes'),
      MapEntry('Yok', 'btts_no'),
    ];
  }

  List<MapEntry<String, String>> get marketOutcomes =>
      _marketOutcomesFor(market);

  List<MapEntry<String, String>> get activeOutcomes {
    if (selection == 'Tümü') return marketOutcomes;

    return marketOutcomes
        .where((item) => item.key == selection)
        .toList();
  }

  List<String> get selections {
    return [
      'Tümü',
      ...marketOutcomes.map((item) => item.key),
    ];
  }

  void _changeMarket(String value) {
    setState(() {
      market = value;
      selection = 'Tümü';
      selectedTime = null;
    });
  }

  String? _latestOutcomeStatus(String bookmaker, String key) {
    final wanted = _bookmakerKey(bookmaker);

    for (final row in widget.latestRows) {
      if (_bookmakerKey(row['bookmaker']) != wanted) continue;

      final statusMapRaw = row['status_map'];
      if (statusMapRaw is! Map) return null;

      final statusMap = Map<String, dynamic>.from(statusMapRaw);
      return statusMap[key]?.toString().toLowerCase();
    }

    return null;
  }

  bool _latestMarketSuspended(String bookmaker) {
    if (activeOutcomes.isEmpty) return false;

    return activeOutcomes.every(
      (outcome) =>
          _latestOutcomeStatus(bookmaker, outcome.value) == 'suspended',
    );
  }

  double? _latestOdd(String bookmaker) {
    if (selection == 'Tümü' || activeOutcomes.isEmpty) {
      return null;
    }

    final wanted = _bookmakerKey(bookmaker);
    final key = activeOutcomes.first.value;

    for (final row in widget.latestRows) {
      if (_bookmakerKey(row['bookmaker']) != wanted) continue;

      if (_latestOutcomeStatus(bookmaker, key) == 'suspended') {
        return null;
      }

      final raw = row[key];
      if (raw is num) return raw.toDouble();

      return null;
    }

    return null;
  }

  List<_OddsSeries> _series({
    bool applyRange = true,
    String? marketOverride,
    String? selectionOverride,
    Set<String>? bookmakersOverride,
  }) {
    final groups = <Map<String, dynamic>>[
      ...widget.historyGroups,
    ];

    groups.sort((a, b) {
      DateTime? da;
      DateTime? db;

      try {
        da = DateTime.parse(a['captured_at'].toString());
      } catch (_) {}

      try {
        db = DateTime.parse(b['captured_at'].toString());
      } catch (_) {}

      if (da == null && db == null) return 0;
      if (da == null) return 1;
      if (db == null) return -1;

      return da.compareTo(db);
    });

    DateTime? newest;

    for (final group in groups.reversed) {
      try {
        newest = DateTime.parse(group['captured_at'].toString());
        break;
      } catch (_) {}
    }

    Duration? window;

    if (range == '120') {
      window = const Duration(minutes: 120);
    } else if (range == '60') {
      window = const Duration(minutes: 60);
    } else if (range == '30') {
      window = const Duration(minutes: 30);
    } else if (range == '15') {
      window = const Duration(minutes: 15);
    }

    final names = _bookmakerNames();
    final effectiveMarket = marketOverride ?? market;
    final effectiveSelection = selectionOverride ?? selection;
    final allOutcomes = _marketOutcomesFor(effectiveMarket);
    final outcomes = effectiveSelection == 'Tümü'
        ? allOutcomes
        : allOutcomes
            .where((item) => item.key == effectiveSelection)
            .toList();
    final result = <_OddsSeries>[];

    for (final bookmaker in names) {
      final selected = bookmakersOverride == null
          ? _isBookmakerSelected(bookmaker)
          : bookmakersOverride.any(
              (name) =>
                  _bookmakerKey(name) ==
                  _bookmakerKey(bookmaker),
            );

      if (!selected) continue;

      final wanted = _bookmakerKey(bookmaker);
      final bookmakerIndex = names.indexOf(bookmaker);

      for (int outcomeIndex = 0;
          outcomeIndex < outcomes.length;
          outcomeIndex++) {
        final outcome = outcomes[outcomeIndex];
        final points = <_OddsPoint>[];
        var breakBeforeNextActive = false;

        for (final group in groups) {
          DateTime? capturedAt;

          try {
            capturedAt =
                DateTime.parse(group['captured_at'].toString()).toLocal();
          } catch (_) {}

          if (capturedAt == null) continue;

          if (applyRange && window != null && newest != null) {
            final cutoff = newest.toLocal().subtract(window);

            if (capturedAt.isBefore(cutoff)) {
              continue;
            }
          }

          final rows = group['rows'];
          if (rows is! List) continue;

          Map<String, dynamic>? matched;

          for (final raw in rows.whereType<Map>()) {
            final row = Map<String, dynamic>.from(raw);

            if (_bookmakerKey(row['bookmaker']) == wanted) {
              matched = row;
              break;
            }
          }

          if (matched == null) continue;

          final raw = matched[outcome.value];

          final statusMapRaw = matched["status_map"];
          final statusMap = statusMapRaw is Map
              ? Map<String, dynamic>.from(statusMapRaw)
              : <String, dynamic>{};

          final status =
              statusMap[outcome.value]?.toString().toLowerCase();

          if (status == "suspended") {
            breakBeforeNextActive = true;
            continue;
          }

          if (breakBeforeNextActive && status != "active") {
            continue;
          }

          if (raw is num &&
              raw.toDouble().isFinite &&
              raw.toDouble() > 1.0) {
            points.add(
              _OddsPoint(
                time: capturedAt,
                value: raw.toDouble(),
                segmentStart: breakBeforeNextActive,
              ),
            );

            if (status == "active") {
              breakBeforeNextActive = false;
            }
          }
        }

        if (points.isEmpty) continue;

        final colorIndex =
            bookmakerIndex * allOutcomes.length + outcomeIndex;
        final hue = ((colorIndex * 47) % 360).toDouble();

        result.add(
          _OddsSeries(
            bookmaker: bookmaker,
            outcome: outcome.key,
            color: HSVColor.fromAHSV(
              1,
              hue,
              0.68,
              0.95,
            ).toColor(),
            points: points,
          ),
        );
      }
    }

    return result;
  }


  void _selectTimeAt(
    Offset position,
    double width,
    List<_OddsSeries> chartSeries,
  ) {
    final points = <_OddsPoint>[
      for (final item in chartSeries) ...item.points,
    ];

    if (points.isEmpty) return;

    const left = 38.0;
    const right = 42.0;

    final plotWidth = math.max(1.0, width - left - right);

    final times = points
        .map((e) => e.time.millisecondsSinceEpoch)
        .toSet()
        .toList()
      ..sort();

    final minTime = times.first;
    final maxTime = times.last;

    if (maxTime == minTime) {
      setState(() {
        selectedTime =
            DateTime.fromMillisecondsSinceEpoch(minTime);
      });
      return;
    }

    final clampedX =
        (position.dx - left).clamp(0.0, plotWidth);

    final ratio = clampedX / plotWidth;

    final target =
        minTime + ((maxTime - minTime) * ratio).round();

    int nearest = times.first;
    int nearestDistance = (nearest - target).abs();

    for (final time in times.skip(1)) {
      final distance = (time - target).abs();

      if (distance < nearestDistance) {
        nearest = time;
        nearestDistance = distance;
      }
    }

    setState(() {
      selectedTime =
          DateTime.fromMillisecondsSinceEpoch(nearest);
    });
  }


  DateTime? _displayTime(List<_OddsSeries> chartSeries) {
    if (selectedTime != null) return selectedTime;

    DateTime? latest;

    for (final item in chartSeries) {
      for (final point in item.points) {
        if (latest == null || point.time.isAfter(latest)) {
          latest = point.time;
        }
      }
    }

    return latest;
  }

  List<Map<String, dynamic>> _selectedMoves(
    List<_OddsSeries> chartSeries,
  ) {
    final target = _displayTime(chartSeries);

    if (target == null) return <Map<String, dynamic>>[];

    final out = <Map<String, dynamic>>[];

    for (final item in chartSeries) {
      final points = <_OddsPoint>[
        ...item.points,
      ]..sort((a, b) => a.time.compareTo(b.time));

      if (points.isEmpty) continue;

      int chosenIndex = -1;

      for (int i = 0; i < points.length; i++) {
        if (!points[i].time.isAfter(target)) {
          chosenIndex = i;
        } else {
          break;
        }
      }

      if (chosenIndex < 0) continue;

      final current = points[chosenIndex];
      final previous =
          chosenIndex > 0 && !current.segmentStart
              ? points[chosenIndex - 1]
              : null;

      double? pct;

      if (previous != null && previous.value != 0) {
        pct =
            ((current.value - previous.value) / previous.value) *
                100.0;
      }

      out.add({
        'bookmaker': item.bookmaker,
        'outcome': item.outcome,
        'color': item.color,
        'time': current.time,
        'before': previous?.value,
        'after': current.value,
        'pct': pct,
        'changed': previous != null &&
            (current.value - previous.value).abs() > 0.0001,
      });
    }

    return out;
  }


  List<Map<String, dynamic>> _openingRecords(
    List<_OddsSeries> chartSeries,
  ) {
    final out = <Map<String, dynamic>>[];

    for (final raw in widget.openingOdds) {
      final bookmaker = raw['bookmaker']?.toString() ?? '';

      if (!_isBookmakerSelected(bookmaker)) {
        continue;
      }

      if (raw['market']?.toString() != market) continue;

      final outcomeKey = raw['outcome_key']?.toString() ?? '';

      MapEntry<String, String>? outcome;

      for (final item in marketOutcomes) {
        if (item.value == outcomeKey) {
          outcome = item;
          break;
        }
      }

      if (outcome == null) continue;

      if (selection != 'Tümü' && outcome.key != selection) {
        continue;
      }

      final oddRaw = raw['opening_odd'];
      final odd = oddRaw is num
          ? oddRaw.toDouble()
          : double.tryParse(oddRaw?.toString() ?? '');

      if (odd == null || !odd.isFinite || odd <= 1) continue;

      final time = DateTime.tryParse(
        raw['opening_at']?.toString() ?? '',
      )?.toLocal();

      if (time == null) continue;

      Color color = const Color(0xFF94A3B8);

      for (final series in chartSeries) {
        if (_bookmakerKey(series.bookmaker) ==
                _bookmakerKey(bookmaker) &&
            series.outcome == outcome.key) {
          color = series.color;
          break;
        }
      }

      out.add({
        'bookmaker': bookmaker,
        'outcome': outcome.key,
        'color': color,
        'time': time,
        'before': null,
        'after': odd,
        'pct': null,
        'changed': false,
        'opening': true,
      });
    }

    out.sort((a, b) {
      final at = a['time'] as DateTime;
      final bt = b['time'] as DateTime;
      return bt.compareTo(at);
    });

    return out;
  }

  List<Map<String, dynamic>> _movementRecords(
    List<_OddsSeries> chartSeries,
  ) {
    final out = <Map<String, dynamic>>[];

    for (final item in chartSeries) {
      final points = <_OddsPoint>[
        ...item.points,
      ]..sort((a, b) => a.time.compareTo(b.time));

      for (int i = 0; i < points.length; i++) {
        final current = points[i];
        final previous =
            i > 0 && !current.segmentStart
                ? points[i - 1]
                : null;

        double? pct;

        if (previous != null && previous.value != 0) {
          pct =
              ((current.value - previous.value) / previous.value) *
                  100.0;
        }

        out.add({
          'bookmaker': item.bookmaker,
          'outcome': item.outcome,
          'color': item.color,
          'time': current.time,
          'before': previous?.value,
          'after': current.value,
          'pct': pct,
          'changed': previous != null &&
              (current.value - previous.value).abs() > 0.0001,
        });
      }
    }

    out.sort((a, b) {
      final at = a['time'] as DateTime;
      final bt = b['time'] as DateTime;
      return bt.compareTo(at);
    });

    return out;
  }

  List<Map<String, dynamic>> _stateEventRecords() {
    final out = <Map<String, dynamic>>[];

    for (final raw in widget.marketStateEvents) {
      final bookmaker = raw["bookmaker"]?.toString() ?? "";
      if (!_isBookmakerSelected(bookmaker)) {
        continue;
      }

      if (raw["market"]?.toString() != market) continue;

      final eventSelection = raw["selection"]?.toString() ?? "";
      if (selection != "Tümü" && eventSelection != selection) continue;

      final capturedAt = DateTime.tryParse(
        raw["captured_at"]?.toString() ?? "",
      )?.toLocal();

      if (capturedAt == null) continue;

      out.add({
        ...raw,
        "time": capturedAt,
      });
    }

    out.sort(
      (a, b) => (b["time"] as DateTime).compareTo(a["time"] as DateTime),
    );

    return out;
  }

  Widget _stateEventHistory(List<Map<String, dynamic>> events) {
    if (events.isEmpty) return const SizedBox.shrink();

    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 10),
      decoration: BoxDecoration(
        color: const Color(0xFF151E2B),
        borderRadius: BorderRadius.circular(9),
        border: Border.all(color: const Color(0xFF334155)),
      ),
      child: Column(
        children: [
          for (final event in events)
            Builder(
              builder: (_) {
                final type =
                    event["event_type"]?.toString().toUpperCase() ?? "";
                final bookmaker =
                    event["bookmaker"]?.toString() ?? "";
                final eventSelection =
                    event["selection"]?.toString() ?? "";
                final time = event["time"] as DateTime?;

                final current =
                    (event["current_odd"] as num?)?.toDouble();
                final lastActive =
                    (event["last_active_odd"] as num?)?.toDouble();
                final gap =
                    (event["reopen_gap_pct"] as num?)?.toDouble();

                final isSuspend = type == "SUSPEND";

                String valueText;
                if (isSuspend) {
                  valueText = current == null
                      ? "Askıya alındı"
                      : current.toStringAsFixed(2);
                } else {
                  final beforeText = lastActive?.toStringAsFixed(2) ?? "—";
                  final afterText = current?.toStringAsFixed(2) ?? "—";
                  final gapText = gap == null
                      ? ""
                      : "  ${gap >= 0 ? '+' : ''}${gap.toStringAsFixed(2)}%";
                  valueText = "$beforeText → $afterText$gapText";
                }

                return Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 9,
                    vertical: 8,
                  ),
                  decoration: const BoxDecoration(
                    border: Border(
                      bottom: BorderSide(color: Color(0xFF263445)),
                    ),
                  ),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 70,
                        child: Text(
                          _oddsStamp(time),
                          style: const TextStyle(
                            fontSize: 8.2,
                            color: Color(0xFF94A3B8),
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                      Expanded(
                        child: Text(
                          "$bookmaker • $eventSelection",
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 9,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(
                            isSuspend
                                ? "ASKIYA ALINDI"
                                : "YENİDEN AÇILDI",
                            style: TextStyle(
                              fontSize: 7.5,
                              fontWeight: FontWeight.w900,
                              color: isSuspend
                                  ? const Color(0xFFFFB45E)
                                  : const Color(0xFF62D98B),
                            ),
                          ),
                          Text(
                            valueText,
                            style: TextStyle(
                              fontSize: 9.2,
                              fontWeight: FontWeight.w900,
                              color: isSuspend
                                  ? const Color(0xFF94A3B8)
                                  : const Color(0xFFF1F5F9),
                              decoration: isSuspend && current != null
                                  ? TextDecoration.lineThrough
                                  : TextDecoration.none,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                );
              },
            ),
        ],
      ),
    );
  }

  Color _historyMoveColor(double? before, double after) {
    if (before == null || (after - before).abs() < 0.0001) {
      return const Color(0xFF94A3B8);
    }

    // Oran düşüşü yeşil, yükseliş kırmızı.
    return after < before
        ? const Color(0xFF62D98B)
        : const Color(0xFFFF6262);
  }

  Widget _groupedMovementHistory(
    List<Map<String, dynamic>> records,
  ) {
    final grouped = <String, Map<String, dynamic>>{};

    final outcomeOrder = {
      for (int i = 0; i < marketOutcomes.length; i++)
        marketOutcomes[i].key: i,
    };

    for (final record in records) {
      final rawTime = record['time'];
      if (rawTime is! DateTime) continue;

      final bookmaker = record['bookmaker']?.toString() ?? '';
      final recordType = record['opening'] == true ? 'opening' : 'tracked';
      final key =
          '${_bookmakerKey(bookmaker)}|$recordType|${rawTime.millisecondsSinceEpoch}';

      final group = grouped.putIfAbsent(
        key,
        () => {
          'bookmaker': bookmaker,
          'time': rawTime,
          'items': <Map<String, dynamic>>[],
        },
      );

      (group['items'] as List<Map<String, dynamic>>).add(record);
    }

    final rows = grouped.values.toList()
      ..sort((a, b) {
        final aItems = a['items'] as List<Map<String, dynamic>>;
        final bItems = b['items'] as List<Map<String, dynamic>>;

        final aOpening =
            aItems.any((item) => item['opening'] == true);
        final bOpening =
            bItems.any((item) => item['opening'] == true);

        if (aOpening != bOpening) {
          return aOpening ? 1 : -1;
        }

        return (b['time'] as DateTime)
            .compareTo(a['time'] as DateTime);
      });

    for (final row in rows) {
      final items = row['items'] as List<Map<String, dynamic>>;

      items.sort(
        (a, b) =>
            (outcomeOrder[a['outcome']] ?? 99)
                .compareTo(outcomeOrder[b['outcome']] ?? 99),
      );
    }

    if (rows.isEmpty) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 10),
        child: Text(
          'Bu seçim için kayıt yok.',
          style: TextStyle(
            fontSize: 10,
            color: Color(0xFF94A3B8),
          ),
        ),
      );
    }

    final trackedRows = rows.where((row) {
      final items =
          row['items'] as List<Map<String, dynamic>>;
      return !items.any(
        (item) => item['opening'] == true,
      );
    }).toList();

    final openingRows = rows.where((row) {
      final items =
          row['items'] as List<Map<String, dynamic>>;
      return items.any(
        (item) => item['opening'] == true,
      );
    }).toList();

    final totalRows = trackedRows.length;

    final availablePageSizes = <int>[
      50,
      if (totalRows > 50) 100,
      if (totalRows > 100) 200,
      if (totalRows > 200) 300,
      if (totalRows > 300) 500,
    ];

    if (historyPageSize > 0 &&
        !availablePageSizes.contains(historyPageSize)) {
      availablePageSizes.add(historyPageSize);
      availablePageSizes.sort();
    }

    final effectivePageSize =
        historyPageSize <= 0 ? totalRows : historyPageSize;

    final pageCount = historyPageSize <= 0
        ? 1
        : math.max(
            1,
            (totalRows + effectivePageSize - 1) ~/
                effectivePageSize,
          ).toInt();

    final safePage = historyPage.clamp(0, pageCount - 1).toInt();

    final startIndex = historyPageSize <= 0
        ? 0
        : safePage * effectivePageSize;

    final endIndex = historyPageSize <= 0
        ? totalRows
        : math.min(
            startIndex + effectivePageSize,
            totalRows,
          ).toInt();

    final visibleRows = <Map<String, dynamic>>[
      ...trackedRows.sublist(startIndex, endIndex),
      if (historyPageSize <= 0 ||
          safePage == pageCount - 1)
        ...openingRows,
    ];

    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: const Color(0xFF151E2B),
        borderRadius: BorderRadius.circular(9),
        border: Border.all(
          color: const Color(0xFF334155),
        ),
      ),
      child: Column(
        children: [
          if (totalRows > 50)
            Container(
              padding: const EdgeInsets.fromLTRB(
                8,
                5,
                6,
                5,
              ),
              decoration: const BoxDecoration(
                border: Border(
                  bottom: BorderSide(
                    color: Color(0xFF334155),
                  ),
                ),
              ),
              child: Row(
                children: [
                  Text(
                    '${startIndex + 1}–$endIndex / $totalRows',
                    style: const TextStyle(
                      fontSize: 8.5,
                      color: Color(0xFF94A3B8),
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  const Spacer(),
                  DropdownButtonHideUnderline(
                    child: DropdownButton<int>(
                      value: historyPageSize,
                      isDense: true,
                      dropdownColor:
                          const Color(0xFF151E2B),
                      style: const TextStyle(
                        fontSize: 9,
                        fontWeight: FontWeight.w800,
                        color: Color(0xFFE2E8F0),
                      ),
                      items: [
                        for (final size
                            in availablePageSizes)
                          DropdownMenuItem<int>(
                            value: size,
                            child: Text('$size'),
                          ),
                        const DropdownMenuItem<int>(
                          value: -1,
                          child: Text('Tümü'),
                        ),
                      ],
                      onChanged: (value) {
                        if (value == null) return;
                        setState(() {
                          historyPageSize = value;
                          historyPage = 0;
                        });
                      },
                    ),
                  ),
                  if (historyPageSize > 0 &&
                      pageCount > 1) ...[
                    const SizedBox(width: 4),
                    InkWell(
                      onTap: safePage <= 0
                          ? null
                          : () {
                              setState(() {
                                historyPage =
                                    safePage - 1;
                              });
                            },
                      borderRadius:
                          BorderRadius.circular(6),
                      child: Padding(
                        padding:
                            const EdgeInsets.all(4),
                        child: Icon(
                          Icons.chevron_left_rounded,
                          size: 18,
                          color: safePage <= 0
                              ? const Color(0xFF475569)
                              : const Color(0xFFE2E8F0),
                        ),
                      ),
                    ),
                    Padding(
                      padding:
                          const EdgeInsets.symmetric(
                        horizontal: 3,
                      ),
                      child: Text(
                        '${safePage + 1}/$pageCount',
                        style: const TextStyle(
                          fontSize: 8.5,
                          fontWeight: FontWeight.w900,
                          color: Color(0xFFCBD5E1),
                        ),
                      ),
                    ),
                    InkWell(
                      onTap: safePage >= pageCount - 1
                          ? null
                          : () {
                              setState(() {
                                historyPage =
                                    safePage + 1;
                              });
                            },
                      borderRadius:
                          BorderRadius.circular(6),
                      child: Padding(
                        padding:
                            const EdgeInsets.all(4),
                        child: Icon(
                          Icons.chevron_right_rounded,
                          size: 18,
                          color:
                              safePage >= pageCount - 1
                                  ? const Color(
                                      0xFF475569,
                                    )
                                  : const Color(
                                      0xFFE2E8F0,
                                    ),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),

          // 1 / X / 2 - Alt / Üst - Var / Yok
          // sadece burada bir kez başlık olarak görünür.
          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: 8,
              vertical: 7,
            ),
            decoration: const BoxDecoration(
              border: Border(
                bottom: BorderSide(
                  color: Color(0xFF334155),
                ),
              ),
            ),
            child: Row(
              children: [
                const SizedBox(width: 70),
                const Expanded(
                  flex: 2,
                  child: SizedBox(),
                ),
                const SizedBox(width: 5),
                Expanded(
                  flex: 5,
                  child: Row(
                    children: [
                      for (final outcome in marketOutcomes)
                        Expanded(
                          child: Text(
                            outcome.key,
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                              fontSize: 9,
                              color: Color(0xFF94A3B8),
                              fontWeight: FontWeight.w900,
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),

          for (final row in visibleRows)
            Builder(
              builder: (context) {
                final items =
                    row['items'] as List<Map<String, dynamic>>;
                final isOpening =
                    items.any((item) => item['opening'] == true);

                return Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 9,
                  ),
                  decoration: const BoxDecoration(
                    border: Border(
                      bottom: BorderSide(
                        color: Color(0xFF263445),
                      ),
                    ),
                  ),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 70,
                        child: Text(
                          isOpening
                              ? 'AÇILIŞ\n${_oddsStamp(row['time'] as DateTime?)}'
                              : _oddsStamp(row['time'] as DateTime?),
                          style: const TextStyle(
                            fontSize: 8.2,
                            color: Color(0xFF94A3B8),
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),

                      Expanded(
                        flex: 2,
                        child: Text(
                          row['bookmaker'].toString(),
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 9,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                      ),

                      const SizedBox(width: 5),

                      Expanded(
                        flex: 5,
                        child: Row(
                          children: [
                            for (final outcome in marketOutcomes)
                              Expanded(
                                child: Builder(
                                  builder: (_) {
                                    Map<String, dynamic>? item;

                                    for (final candidate in items) {
                                      if (candidate['outcome'] ==
                                          outcome.key) {
                                        item = candidate;
                                        break;
                                      }
                                    }

                                    if (item == null) {
                                      return const Text(
                                        '—',
                                        textAlign: TextAlign.center,
                                        style: TextStyle(
                                          fontSize: 9,
                                          color: Color(0xFF7F8EA3),
                                        ),
                                      );
                                    }

                                    final before =
                                        item['before'] as double?;
                                    final after =
                                        item['after'] as double;
                                    final pct =
                                        item['pct'] as double?;

                                    final changed =
                                        before != null &&
                                        (after - before).abs() >
                                            0.0001;

                                    final arrow = !changed
                                        ? '—'
                                        : after < before
                                            ? '↓'
                                            : '↑';

                                    final color =
                                        _historyMoveColor(
                                      before,
                                      after,
                                    );

                                    final pctText =
                                        pct == null || !changed
                                            ? ''
                                            : '${pct >= 0 ? '+' : ''}${pct.toStringAsFixed(1)}%';

                                    return Column(
                                      mainAxisSize:
                                          MainAxisSize.min,
                                      children: [
                                        Text(
                                          '${after.toStringAsFixed(2)} $arrow',
                                          textAlign: TextAlign.center,
                                          maxLines: 1,
                                          style: TextStyle(
                                            fontSize: 9.2,
                                            fontWeight:
                                                FontWeight.w900,
                                            color: color,
                                          ),
                                        ),
                                        if (pctText.isNotEmpty)
                                          Text(
                                            pctText,
                                            textAlign:
                                                TextAlign.center,
                                            maxLines: 1,
                                            style: TextStyle(
                                              fontSize: 7.5,
                                              fontWeight:
                                                  FontWeight.w800,
                                              color: color,
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
                  ),
                );
              },
            ),
        ],
      ),
    );
  }

  List<Map<String, dynamic>> _summaryRecords(List<_OddsSeries> series) {
    String? outcomeKey(String label) {
      for (final outcome in marketOutcomes) {
        if (outcome.key == label) return outcome.value;
      }
      return null;
    }

    if (selection != 'Tümü') {
      final out = <Map<String, dynamic>>[];

      for (final item in series) {
        if (item.points.isEmpty) continue;

        final key = outcomeKey(item.outcome);
        if (key != null &&
            _latestOutcomeStatus(item.bookmaker, key) == 'suspended') {
          continue;
        }

        final points = <_OddsPoint>[...item.points]
          ..sort((a, b) => a.time.compareTo(b.time));

        final current = points.last;
        final previous =
            points.length > 1 && !current.segmentStart
                ? points[points.length - 2]
                : null;

        out.add({
          "bookmaker": item.bookmaker,
          "time": current.time,
          "before": previous?.value,
          "after": current.value,
        });
      }

      out.sort((a, b) =>
          (b["time"] as DateTime).compareTo(a["time"] as DateTime));

      return out;
    }

    final grouped = <String, Map<String, dynamic>>{};

    for (final item in series) {
      if (item.points.isEmpty) continue;

      final outcomeValueKey = outcomeKey(item.outcome);
      if (outcomeValueKey != null &&
          _latestOutcomeStatus(item.bookmaker, outcomeValueKey) ==
              'suspended') {
        continue;
      }

      final points = <_OddsPoint>[...item.points]
        ..sort((a, b) => a.time.compareTo(b.time));

      final current = points.last;
      final previous =
          points.length > 1 && !current.segmentStart
              ? points[points.length - 2]
              : null;

      final key = _bookmakerKey(item.bookmaker);

      final record = grouped.putIfAbsent(
        key,
        () => {
          "bookmaker": item.bookmaker,
          "time": current.time,
          "outcomes": <Map<String, dynamic>>[],
        },
      );

      if (current.time.isAfter(record["time"] as DateTime)) {
        record["time"] = current.time;
      }

      (record["outcomes"] as List<Map<String, dynamic>>).add({
        "outcome": item.outcome,
        "before": previous?.value,
        "after": current.value,
      });
    }

    final order = {
      for (int i = 0; i < marketOutcomes.length; i++)
        marketOutcomes[i].key: i,
    };

    final out = grouped.values.toList();

    for (final record in out) {
      final outcomes =
          record["outcomes"] as List<Map<String, dynamic>>;

      outcomes.sort((a, b) =>
          (order[a["outcome"]] ?? 99)
              .compareTo(order[b["outcome"]] ?? 99));
    }

    out.sort((a, b) =>
        (b["time"] as DateTime).compareTo(a["time"] as DateTime));

    return out;
  }

  String _summaryOddsText(Map<String, dynamic> record) {
    if (selection != 'Tümü') {
      final before = record["before"] as double?;
      final after = record["after"] as double;

      final arrow = before == null
          ? ""
          : after > before
              ? "↑"
              : after < before
                  ? "↓"
                  : "—";

      return "${after.toStringAsFixed(2)} $arrow";
    }

    final outcomes =
        record["outcomes"] as List<Map<String, dynamic>>? ?? const [];

    return outcomes.map((item) {
      final before = item["before"] as double?;
      final after = item["after"] as double;
      final label = item["outcome"].toString();

      final arrow = before == null
          ? ""
          : after > before
              ? "↑"
              : after < before
                  ? "↓"
                  : "—";

      return "$label ${after.toStringAsFixed(2)} $arrow";
    }).join("   ");
  }

  String _oddsStamp(DateTime? dt) {
    if (dt == null) return '--/-- --:--';

    return '${dt.day.toString().padLeft(2, '0')}/'
        '${dt.month.toString().padLeft(2, '0')} '
        '${dt.hour.toString().padLeft(2, '0')}:'
        '${dt.minute.toString().padLeft(2, '0')}';
  }

  Widget _smallChip({
    required String label,
    required bool selected,
    required VoidCallback onTap,
  }) {
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: ChoiceChip(
        label: Text(
          label,
          style: const TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w700,
          ),
        ),
        selected: selected,
        visualDensity: VisualDensity.compact,
        onSelected: (_) => onTap(),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final names = _bookmakerNames();
    final chartSeries = _series();
    final historySeries = _series(applyRange: false);
    final selectedMoves = _selectedMoves(chartSeries);
    final displayTime = _displayTime(chartSeries);
    final movementRecords = _movementRecords(historySeries);
    final openingRecords = _openingRecords(historySeries);
    final historyRecords = <Map<String, dynamic>>[
      ...movementRecords,
      ...openingRecords,
    ];

    final historyRowCount = <String>{
      for (final record in historyRecords)
        if (record['time'] is DateTime &&
            record['opening'] != true)
          '${_bookmakerKey(record['bookmaker'])}|'
          '${(record['time'] as DateTime).millisecondsSinceEpoch}',
    }.length;

    final stateEventRecords = _stateEventRecords();
    final summaryRecords = _summaryRecords(historySeries);

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: const Color(0xFF111827),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(
          color: const Color(0xFF334155),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                    widget.view == 'Özet'
                        ? 'Oran Özeti'
                        : widget.view == 'Geçmiş'
                            ? 'Geçmiş Oranlar'
                            : 'Oran Grafiği',
                  style: TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w900,
                  ),
                ),
              ),
              Text(
                '${widget.view == 'Geçmiş' ? (historyBookmaker == null ? 0 : 1) : selectedBookmakers.length}/${names.length} bookmaker',
                style: const TextStyle(
                  fontSize: 9,
                  color: Color(0xFF94A3B8),
                ),
              ),
            ],
          ),

          const SizedBox(height: 9),

          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final item in const ['MS', '1.5', '2.5', 'KG'])
                  _smallChip(
                    label: item,
                    selected: market == item,
                    onTap: () => _changeMarket(item),
                  ),
              ],
            ),
          ),

          const SizedBox(height: 5),

          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final item in selections)
                  _smallChip(
                    label: item,
                    selected: selection == item,
                    onTap: () {
                      setState(() {
                        selection = item;
                      });
                    },
                  ),
              ],
            ),
          ),

          const SizedBox(height: 10),

          if (widget.view != 'Geçmiş')
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: names.isEmpty
                        ? null
                        : () {
                            setState(() {
                              selectedBookmakers
                                ..clear()
                                ..addAll(names);
                            });
                          },
                    child: const Text('Tümünü seç'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: OutlinedButton(
                    onPressed: selectedBookmakers.isEmpty
                        ? null
                        : () {
                            setState(() {
                              selectedBookmakers.clear();
                            });
                          },
                    child: const Text('Tümünü bırak'),
                  ),
                ),
              ],
            ),

          const SizedBox(height: 7),

          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final name in names)
                  Padding(
                    padding: const EdgeInsets.only(right: 6),
                    child: FilterChip(
                      selected: _isBookmakerSelected(name),
                      onSelected: (selected) {
                        setState(() {
                          if (widget.view == 'Geçmiş') {
                            historyBookmaker = name;
                          } else if (selected) {
                            selectedBookmakers.add(name);
                          } else {
                            selectedBookmakers.remove(name);
                          }
                        });
                      },
                      visualDensity: VisualDensity.compact,
                      label: Text(
                        _latestMarketSuspended(name)
                            ? '$name  •  ASKIYA ALINDI'
                            : _latestOdd(name) == null
                                ? name
                                : '$name  ${_latestOdd(name)!.toStringAsFixed(2)}',
                        style: const TextStyle(
                          fontSize: 9,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),

            if (widget.view == "Özet") ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  const Expanded(
                    child: Text(
                      "Son Kayıt Özeti",
                      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w900),
                    ),
                  ),
                  Text(
                    "${summaryRecords.length} bookmaker",
                    style: const TextStyle(fontSize: 9, color: Color(0xFF94A3B8)),
                  ),
                ],
              ),
              const SizedBox(height: 7),
              if (summaryRecords.isEmpty)
                const Text(
                  "Bu seçim için henüz kayıt yok.",
                  style: TextStyle(fontSize: 10, color: Color(0xFF94A3B8)),
                )
              else
                Container(
                  width: double.infinity,
                  decoration: BoxDecoration(
                    color: const Color(0xFF151E2B),
                    borderRadius: BorderRadius.circular(9),
                    border: Border.all(color: const Color(0xFF334155)),
                  ),
                  child: Column(
                    children: [
                      for (final record in summaryRecords)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 8),
                          decoration: const BoxDecoration(
                            border: Border(bottom: BorderSide(color: Color(0xFF263445))),
                          ),
                          child: Row(
                            children: [
                              Expanded(
                                child: Text(
                                  record["bookmaker"].toString(),
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800),
                                ),
                              ),
                              Text(
                                _oddsStamp(record["time"] as DateTime?),
                                style: const TextStyle(fontSize: 8.5, color: Color(0xFF94A3B8)),
                              ),
                              const SizedBox(width: 8),
                              Flexible(
                                flex: 2,
                                child: Text(
                                  _summaryOddsText(record),
                                  textAlign: TextAlign.right,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    fontSize: 10,
                                    fontWeight: FontWeight.w900,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
            ],
            if (widget.view == 'Grafik') ...[
          const SizedBox(height: 8),

          Container(
            height: 270,
            width: double.infinity,
            decoration: BoxDecoration(
              color: const Color(0xFF151E2B),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(
                color: const Color(0xFF334155),
              ),
            ),
            child: chartSeries.isEmpty
                ? const Center(
                    child: Text(
                      'Bu seçim için çizilecek oran geçmişi yok.',
                      style: TextStyle(
                        fontSize: 10,
                        color: Color(0xFF94A3B8),
                      ),
                    ),
                  )
                : LayoutBuilder(
                    builder: (context, constraints) {
                      return GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onTapDown: (details) => _selectTimeAt(
                          details.localPosition,
                          constraints.maxWidth,
                          chartSeries,
                        ),
                        onHorizontalDragUpdate: (details) =>
                            _selectTimeAt(
                          details.localPosition,
                          constraints.maxWidth,
                          chartSeries,
                        ),
                        child: CustomPaint(
                          size: Size(
                            constraints.maxWidth,
                            270,
                          ),
                          painter: OddsChartPainter(
                            series: chartSeries,
                            selectedTime: selectedTime,
                          ),
                        ),
                      );
                    },
                  ),
          ),

          const SizedBox(height: 4),

          Align(
            alignment: Alignment.centerRight,
            child: TextButton.icon(
              onPressed: chartSeries.isEmpty
                  ? null
                  : () => _openFullscreenChart(chartSeries),
              icon: const Icon(
                Icons.fullscreen_rounded,
                size: 19,
              ),
              label: const Text(
                'Tam ekran',
                style: TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ),
          ),

          const SizedBox(height: 2),

            if (selectedMoves.isNotEmpty) ...[
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: const Color(0xFF151E2B),
                  borderRadius: BorderRadius.circular(9),
                  border: Border.all(
                    color: const Color(0xFF334155),
                  ),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      _oddsStamp(displayTime),
                      style: const TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w900,
                      ),
                    ),
                    const SizedBox(height: 7),
                    for (final move in selectedMoves)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: Row(
                          children: [
                            Container(
                              width: 8,
                              height: 8,
                              decoration: BoxDecoration(
                                color: move['color'] as Color,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 7),
                            Expanded(
                              flex: 3,
                              child: Text(
                                selection == 'Tümü'
                                      ? '${move["bookmaker"]} • ${move["outcome"]}'
                                      : move['bookmaker'].toString(),
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                            ),
                            Expanded(
                              flex: 5,
                              child: Builder(
                                builder: (_) {
                                  final before =
                                      move['before'] as double?;
                                  final after =
                                      move['after'] as double;
                                  final pct =
                                      move['pct'] as double?;
                                  final changed =
                                      move['changed'] == true;

                                  String arrow = '—';
                                  if (before != null && changed) {
                                    arrow = after > before ? '↑' : '↓';
                                  }

                                  final beforeText = before == null
                                      ? 'İlk'
                                      : before.toStringAsFixed(2);

                                  final pctText =
                                      pct == null || !changed
                                          ? ''
                                          : '  ${pct >= 0 ? '+' : ''}${pct.toStringAsFixed(2)}%';

                                  return Text(
                                    '$beforeText → ${after.toStringAsFixed(2)}  $arrow$pctText',
                                    textAlign: TextAlign.right,
                                    style: const TextStyle(
                                      fontSize: 10,
                                      fontWeight: FontWeight.w800,
                                    ),
                                  );
                                },
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
            ],

          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                for (final item in const [
                  'Tümü',
                  '120',
                  '60',
                  '30',
                  '15',
                ])
                  _smallChip(
                    label: item == 'Tümü' ? item : '$item dk',
                    selected: range == item,
                    onTap: () {
                      setState(() {
                        range = item;
                      });
                    },
                  ),
              ],
            ),
          ),
            ],
            if (widget.view == 'Geçmiş') ...[
            const SizedBox(height: 14),

            Row(
              children: [
                const Expanded(
                  child: Text(
                    'Geçmiş Kayıtlar',
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                ),
                Text(
                    '$historyRowCount kayıt',
                  style: const TextStyle(
                    fontSize: 9,
                    color: Color(0xFF94A3B8),
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),

            const SizedBox(height: 7),

              _stateEventHistory(stateEventRecords),

              if (selection == 'Tümü')
              _groupedMovementHistory(historyRecords)
            else if (historyRecords.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 10),
                child: Text(
                  'Bu seçim için kayıt yok.',
                  style: TextStyle(
                    fontSize: 10,
                    color: Color(0xFF94A3B8),
                  ),
                ),
              )
            else
              Container(
                width: double.infinity,
                decoration: BoxDecoration(
                  color: const Color(0xFF151E2B),
                  borderRadius: BorderRadius.circular(9),
                  border: Border.all(
                    color: const Color(0xFF334155),
                  ),
                ),
                child: Column(
                  children: [
                      for (final record in historyRecords)
                      Container(
                        padding: const EdgeInsets.symmetric(
                          horizontal: 9,
                          vertical: 8,
                        ),
                        decoration: const BoxDecoration(
                          border: Border(
                            bottom: BorderSide(
                              color: Color(0xFF263445),
                            ),
                          ),
                        ),
                        child: Row(
                          children: [
                            SizedBox(
                              width: 78,
                              child: Text(
                                _oddsStamp(
                                  record['time'] as DateTime?,
                                ),
                                style: const TextStyle(
                                  fontSize: 8.5,
                                  color: Color(0xFF94A3B8),
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                            ),
                            Container(
                              width: 7,
                              height: 7,
                              decoration: BoxDecoration(
                                color: record['color'] as Color,
                                shape: BoxShape.circle,
                              ),
                            ),
                            const SizedBox(width: 6),
                            Expanded(
                              flex: 3,
                              child: Text(
                                selection == 'Tümü'
                                      ? '${record["bookmaker"]} • ${record["outcome"]}'
                                      : record['bookmaker'].toString(),
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 9.5,
                                  fontWeight: FontWeight.w800,
                                ),
                              ),
                            ),
                            Expanded(
                              flex: 4,
                              child: Builder(
                                builder: (_) {
                                  final before =
                                      record['before'] as double?;
                                  final after =
                                      record['after'] as double;
                                  final pct =
                                      record['pct'] as double?;

                                  if (record['opening'] == true) {
                                    return Text(
                                      'AÇILIŞ  ${after.toStringAsFixed(2)}',
                                      textAlign: TextAlign.right,
                                      style: const TextStyle(
                                        fontSize: 10,
                                        fontWeight: FontWeight.w900,
                                      ),
                                    );
                                  }

                                  if (before == null) {
                                    return Text(
                                      'İlk  ${after.toStringAsFixed(2)}',
                                      textAlign: TextAlign.right,
                                      style: const TextStyle(
                                        fontSize: 10,
                                        fontWeight: FontWeight.w900,
                                      ),
                                    );
                                  }

                                  final changed = (after - before).abs() > 0.0001;
                                  final arrow = !changed
                                      ? '—'
                                      : after > before
                                          ? '↑'
                                          : '↓';
                                  final pctText = pct == null || !changed
                                      ? ''
                                      : '  ${pct >= 0 ? '+' : ''}${pct.toStringAsFixed(2)}%';

                                  final moveColor =
                                      _historyMoveColor(before, after);

                                  return Text(
                                    '${before.toStringAsFixed(2)} → ${after.toStringAsFixed(2)} $arrow$pctText',
                                    textAlign: TextAlign.right,
                                    style: TextStyle(
                                      fontSize: 10,
                                      fontWeight: FontWeight.w900,
                                      color: moveColor,
                                    ),
                                  );
                                },
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ],

        ],
      ),
    );
  }
}

class _OddsPoint {
  final DateTime time;
  final double value;
  final bool segmentStart;

  const _OddsPoint({
    required this.time,
    required this.value,
    this.segmentStart = false,
  });
}

class _OddsSeries {
  final String bookmaker;
  final String outcome;
  final Color color;
  final List<_OddsPoint> points;

  const _OddsSeries({
    required this.bookmaker,
    required this.outcome,
    required this.color,
    required this.points,
  });
}

class _FullscreenOddsChartPage extends StatefulWidget {
  final DateTime? initialSelectedTime;
  final String initialMarket;
  final String initialSelection;
  final List<String> bookmakerNames;
  final Set<String> initialBookmakers;
  final List<_OddsSeries> Function(
    String market,
    String selection,
    Set<String> bookmakers,
  ) seriesBuilder;

  const _FullscreenOddsChartPage({
    required this.initialSelectedTime,
    required this.initialMarket,
    required this.initialSelection,
    required this.bookmakerNames,
    required this.initialBookmakers,
    required this.seriesBuilder,
  });

  @override
  State<_FullscreenOddsChartPage> createState() =>
      _FullscreenOddsChartPageState();
}

class _FullscreenOddsChartPageState
    extends State<_FullscreenOddsChartPage> {
  DateTime? selectedTime;
  late String market;
  late String selection;
  late Set<String> selectedBookmakers;
  List<_OddsSeries>? _seriesCache;
  String? _seriesCacheKey;
  List<int> _seriesTimesCache = const [];

  @override
  void initState() {
    super.initState();

    selectedTime = widget.initialSelectedTime;
    market = widget.initialMarket;
    selection = widget.initialSelection;
    selectedBookmakers =
        Set<String>.from(widget.initialBookmakers);

    SystemChrome.setPreferredOrientations(const [
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);

    SystemChrome.setEnabledSystemUIMode(
      SystemUiMode.immersiveSticky,
    );
  }

  @override
  void dispose() {
    SystemChrome.setEnabledSystemUIMode(
      SystemUiMode.edgeToEdge,
    );

    SystemChrome.setPreferredOrientations(const [
      DeviceOrientation.portraitUp,
    ]);

    super.dispose();
  }

  List<MapEntry<String, String>> _outcomes() {
    if (market == 'MS') {
      return const [
        MapEntry('1', 'ms1'),
        MapEntry('X', 'msx'),
        MapEntry('2', 'ms2'),
      ];
    }

    if (market == '1.5') {
      return const [
        MapEntry('Alt', 'ou15_under'),
        MapEntry('Üst', 'ou15_over'),
      ];
    }

    if (market == '2.5') {
      return const [
        MapEntry('Alt', 'ou25_under'),
        MapEntry('Üst', 'ou25_over'),
      ];
    }

    return const [
      MapEntry('Var', 'btts_yes'),
      MapEntry('Yok', 'btts_no'),
    ];
  }

  List<_OddsSeries> _currentSeries() {
    final bookmakerKey = selectedBookmakers.toList()..sort();
    final cacheKey =
        '$market|$selection|${bookmakerKey.join('|')}';

    if (_seriesCacheKey == cacheKey &&
        _seriesCache != null) {
      return _seriesCache!;
    }

    final built = widget.seriesBuilder(
      market,
      selection,
      selectedBookmakers,
    );

    final times = <int>{
      for (final item in built)
        for (final point in item.points)
          point.time.millisecondsSinceEpoch,
    }.toList()
      ..sort();

    _seriesCacheKey = cacheKey;
    _seriesCache = built;
    _seriesTimesCache = times;
    return built;
  }

  DateTime? _displayTime(
    List<_OddsSeries> series,
  ) {
    if (selectedTime != null) return selectedTime;

    DateTime? latest;

    for (final item in series) {
      for (final point in item.points) {
        if (latest == null ||
            point.time.isAfter(latest)) {
          latest = point.time;
        }
      }
    }

    return latest;
  }

  void _selectTimeAt(
    Offset position,
    double width,
  ) {
    final times = _seriesTimesCache;

    if (times.isEmpty) return;

    const left = 38.0;
    const right = 42.0;

    final plotWidth = math.max(
      1.0,
      width - left - right,
    );

    final minTime = times.first;
    final maxTime = times.last;

    if (minTime == maxTime) {
      if (selectedTime?.millisecondsSinceEpoch ==
          minTime) {
        return;
      }

      setState(() {
        selectedTime =
            DateTime.fromMillisecondsSinceEpoch(
          minTime,
        );
      });
      return;
    }

    final clampedX =
        (position.dx - left).clamp(
      0.0,
      plotWidth,
    );

    final ratio = clampedX / plotWidth;

    final target =
        minTime +
        ((maxTime - minTime) * ratio).round();

    int low = 0;
    int high = times.length - 1;

    while (low < high) {
      final mid = (low + high) >> 1;

      if (times[mid] < target) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    int nearest = times[low];

    if (low > 0) {
      final previous = times[low - 1];

      if ((previous - target).abs() <=
          (nearest - target).abs()) {
        nearest = previous;
      }
    }

    if (selectedTime?.millisecondsSinceEpoch ==
        nearest) {
      return;
    }

    setState(() {
      selectedTime =
          DateTime.fromMillisecondsSinceEpoch(
        nearest,
      );
    });
  }

  List<Map<String, dynamic>> _selectedValues(
    List<_OddsSeries> series,
  ) {
    final target = _displayTime(series);

    if (target == null) return [];

    final out = <Map<String, dynamic>>[];

    for (final item in series) {
      final points = item.points;

      if (points.isEmpty) continue;

      int low = 0;
      int high = points.length - 1;
      _OddsPoint? chosen;

      while (low <= high) {
        final mid = (low + high) >> 1;
        final point = points[mid];

        if (!point.time.isAfter(target)) {
          chosen = point;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }

      if (chosen == null) continue;

      out.add({
        'bookmaker': item.bookmaker,
        'outcome': item.outcome,
        'value': chosen.value,
        'color': item.color,
      });
    }

    return out;
  }

  String _stamp(DateTime? dt) {
    if (dt == null) return '--/-- --:--';

    return '${dt.day.toString().padLeft(2, '0')}/'
        '${dt.month.toString().padLeft(2, '0')} '
        '${dt.hour.toString().padLeft(2, '0')}:'
        '${dt.minute.toString().padLeft(2, '0')}';
  }

  void _changeMarket(String value) {
    setState(() {
      market = value;
      selection = 'Tümü';
      selectedTime = null;
    });
  }

  Future<void> _showBookmakers() async {
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor:
          const Color(0xFF101827),
      builder: (sheetContext) {
        return StatefulBuilder(
          builder: (
            context,
            sheetSetState,
          ) {
            return SafeArea(
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight:
                      MediaQuery.of(context)
                              .size
                              .height *
                          0.62,
                ),
                child: Padding(
                  padding:
                      const EdgeInsets.fromLTRB(
                    14,
                    10,
                    14,
                    12,
                  ),
                  child: Column(
                    mainAxisSize:
                        MainAxisSize.min,
                    crossAxisAlignment:
                        CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(
                            'Bookmaker  '
                            '${selectedBookmakers.length}/'
                            '${widget.bookmakerNames.length}',
                            style:
                                const TextStyle(
                              fontSize: 13,
                              fontWeight:
                                  FontWeight.w900,
                            ),
                          ),
                          const Spacer(),
                          TextButton(
                            onPressed: () {
                              setState(() {
                                selectedBookmakers =
                                    widget
                                        .bookmakerNames
                                        .toSet();
                                selectedTime =
                                    null;
                              });

                              sheetSetState(() {});
                            },
                            child: const Text(
                              'Hepsini seç',
                            ),
                          ),
                          TextButton(
                            onPressed: () {
                              setState(() {
                                selectedBookmakers
                                    .clear();
                                selectedTime =
                                    null;
                              });

                              sheetSetState(() {});
                            },
                            child: const Text(
                              'Tümünü bırak',
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),
                      Flexible(
                        child:
                            SingleChildScrollView(
                          child: Wrap(
                            spacing: 7,
                            runSpacing: 5,
                            children: [
                              for (final name
                                  in widget
                                      .bookmakerNames)
                                FilterChip(
                                  selected:
                                      selectedBookmakers
                                          .contains(
                                    name,
                                  ),
                                  label: Text(
                                    name,
                                    style:
                                        const TextStyle(
                                      fontSize: 9,
                                      fontWeight:
                                          FontWeight
                                              .w800,
                                    ),
                                  ),
                                  visualDensity:
                                      VisualDensity
                                          .compact,
                                  onSelected:
                                      (enabled) {
                                    setState(() {
                                      if (enabled) {
                                        selectedBookmakers
                                            .add(
                                          name,
                                        );
                                      } else {
                                        selectedBookmakers
                                            .remove(
                                          name,
                                        );
                                      }

                                      selectedTime =
                                          null;
                                    });

                                    sheetSetState(
                                      () {},
                                    );
                                  },
                                ),
                            ],
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }

  void _close() {
    Navigator.of(context).pop(selectedTime);
  }

  @override
  Widget build(BuildContext context) {
    final series = _currentSeries();
    final values =
        _selectedValues(series);
    final displayTime =
        _displayTime(series);

    final selections = <String>[
      'Tümü',
      ..._outcomes().map(
        (item) => item.key,
      ),
    ];

    return Scaffold(
      backgroundColor:
          const Color(0xFF0B1220),
      body: SafeArea(
        child: Stack(
          children: [
            Positioned.fill(
              top: 88,
              bottom: 50,
              child: Padding(
                padding:
                    const EdgeInsets.fromLTRB(
                  8,
                  2,
                  8,
                  2,
                ),
                child: series.isEmpty
                    ? const Center(
                        child: Text(
                          'Bu seçim için çizilecek oran geçmişi yok.',
                          style: TextStyle(
                            fontSize: 11,
                            color:
                                Color(0xFF94A3B8),
                          ),
                        ),
                      )
                    : LayoutBuilder(
                        builder: (
                          context,
                          constraints,
                        ) {
                          return GestureDetector(
                            behavior:
                                HitTestBehavior
                                    .opaque,
                            onTapDown: (details) =>
                                _selectTimeAt(
                              details
                                  .localPosition,
                              constraints
                                  .maxWidth,
                            ),
                            onHorizontalDragUpdate:
                                (details) =>
                                    _selectTimeAt(
                              details
                                  .localPosition,
                              constraints
                                  .maxWidth,
                            ),
                            child: SizedBox(
                              width: constraints
                                  .maxWidth,
                              height: constraints
                                  .maxHeight,
                              child: Stack(
                                fit: StackFit.expand,
                                children: [
                                  RepaintBoundary(
                                    child: CustomPaint(
                                      painter:
                                          OddsChartPainter(
                                        series: series,
                                        selectedTime:
                                            null,
                                      ),
                                    ),
                                  ),
                                  CustomPaint(
                                    painter:
                                        _OddsSelectionPainter(
                                      minTime:
                                          _seriesTimesCache.isEmpty
                                              ? null
                                              : _seriesTimesCache.first,
                                      maxTime:
                                          _seriesTimesCache.isEmpty
                                              ? null
                                              : _seriesTimesCache.last,
                                      selectedTime:
                                          selectedTime,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
              ),
            ),

            Positioned(
              left: 5,
              right: 8,
              top: 0,
              height: 40,
              child: Row(
                children: [
                  IconButton(
                    onPressed: _close,
                    icon: const Icon(
                      Icons
                          .fullscreen_exit_rounded,
                    ),
                    tooltip:
                        'Tam ekrandan çık',
                  ),
                  const SizedBox(width: 2),
                  Text(
                    'Oran Grafiği',
                    style: const TextStyle(
                      fontSize: 13,
                      fontWeight:
                          FontWeight.w900,
                    ),
                  ),
                  const SizedBox(width: 10),
                  Container(
                    padding:
                        const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 4,
                    ),
                    decoration: BoxDecoration(
                      color:
                          const Color(0xFF151E2B),
                      borderRadius:
                          BorderRadius.circular(
                        7,
                      ),
                      border: Border.all(
                        color: const Color(
                          0xFF334155,
                        ),
                      ),
                    ),
                    child: Text(
                      _stamp(displayTime),
                      style: const TextStyle(
                        fontSize: 10,
                        fontWeight:
                            FontWeight.w900,
                        color:
                            Color(0xFFE2E8F0),
                      ),
                    ),
                  ),
                  const Spacer(),
                  OutlinedButton.icon(
                    onPressed:
                        _showBookmakers,
                    icon: const Icon(
                      Icons.tune_rounded,
                      size: 15,
                    ),
                    label: Text(
                      'Siteler '
                      '${selectedBookmakers.length}/'
                      '${widget.bookmakerNames.length}',
                      style: const TextStyle(
                        fontSize: 9,
                        fontWeight:
                            FontWeight.w900,
                      ),
                    ),
                    style:
                        OutlinedButton.styleFrom(
                      visualDensity:
                          VisualDensity.compact,
                      padding:
                          const EdgeInsets
                              .symmetric(
                        horizontal: 8,
                        vertical: 5,
                      ),
                    ),
                  ),
                ],
              ),
            ),

            Positioned(
              left: 8,
              right: 8,
              top: 42,
              height: 42,
              child: Row(
                children: [
                  for (final value in const [
                    'MS',
                    '1.5',
                    '2.5',
                    'KG',
                  ])
                    Padding(
                      padding:
                          const EdgeInsets.only(
                        right: 5,
                      ),
                      child: ChoiceChip(
                        label: Text(
                          value,
                          style:
                              const TextStyle(
                            fontSize: 9,
                            fontWeight:
                                FontWeight.w900,
                          ),
                        ),
                        selected:
                            market == value,
                        visualDensity:
                            VisualDensity
                                .compact,
                        onSelected: (_) =>
                            _changeMarket(
                          value,
                        ),
                      ),
                    ),
                  Container(
                    width: 1,
                    height: 24,
                    margin:
                        const EdgeInsets.symmetric(
                      horizontal: 4,
                    ),
                    color:
                        const Color(0xFF334155),
                  ),
                  Expanded(
                    child:
                        SingleChildScrollView(
                      scrollDirection:
                          Axis.horizontal,
                      child: Row(
                        children: [
                          for (final item
                              in selections)
                            Padding(
                              padding:
                                  const EdgeInsets
                                      .only(
                                right: 5,
                              ),
                              child:
                                  ChoiceChip(
                                label: Text(
                                  item,
                                  style:
                                      const TextStyle(
                                    fontSize: 9,
                                    fontWeight:
                                        FontWeight
                                            .w800,
                                  ),
                                ),
                                selected:
                                    selection ==
                                        item,
                                visualDensity:
                                    VisualDensity
                                        .compact,
                                onSelected: (_) {
                                  setState(() {
                                    selection =
                                        item;
                                    selectedTime =
                                        null;
                                  });
                                },
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),

            Positioned(
              left: 10,
              right: 10,
              bottom: 5,
              height: 40,
              child:
                  SingleChildScrollView(
                scrollDirection:
                    Axis.horizontal,
                child: Row(
                  children: [
                    Container(
                      margin:
                          const EdgeInsets.only(
                        right: 7,
                      ),
                      padding:
                          const EdgeInsets
                              .symmetric(
                        horizontal: 9,
                        vertical: 5,
                      ),
                      decoration:
                          BoxDecoration(
                        color: const Color(
                          0xFF1E293B,
                        ),
                        borderRadius:
                            BorderRadius
                                .circular(8),
                        border: Border.all(
                          color: const Color(
                            0xFF475569,
                          ),
                        ),
                      ),
                      child: Text(
                        _stamp(displayTime),
                        style:
                            const TextStyle(
                          fontSize: 9.5,
                          fontWeight:
                              FontWeight.w900,
                          color: Color(
                            0xFFF8FAFC,
                          ),
                        ),
                      ),
                    ),
                    for (final item in values)
                      Container(
                        margin:
                            const EdgeInsets.only(
                          right: 7,
                        ),
                        padding:
                            const EdgeInsets
                                .symmetric(
                          horizontal: 8,
                          vertical: 5,
                        ),
                        decoration:
                            BoxDecoration(
                          color: const Color(
                            0xFF151E2B,
                          ),
                          borderRadius:
                              BorderRadius
                                  .circular(8),
                          border: Border.all(
                            color: const Color(
                              0xFF334155,
                            ),
                          ),
                        ),
                        child: Row(
                          mainAxisSize:
                              MainAxisSize.min,
                          children: [
                            Container(
                              width: 7,
                              height: 7,
                              decoration:
                                  BoxDecoration(
                                color:
                                    item['color']
                                        as Color,
                                shape: BoxShape
                                    .circle,
                              ),
                            ),
                            const SizedBox(
                              width: 6,
                            ),
                            Text(
                              '${item['bookmaker']} · '
                              '${item['outcome']}  '
                              '${(item['value'] as double).toStringAsFixed(2)}',
                              style:
                                  const TextStyle(
                                fontSize: 9.5,
                                fontWeight:
                                    FontWeight
                                        .w800,
                                color: Color(
                                  0xFFE2E8F0,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class OddsChartPainter extends CustomPainter {
  final List<_OddsSeries> series;
  final DateTime? selectedTime;

  OddsChartPainter({
    required this.series,
    this.selectedTime,
  });

  @override
  void paint(Canvas canvas, Size size) {
    const left = 38.0;
    const top = 14.0;
    const right = 42.0;
    const bottom = 28.0;

    final plot = Rect.fromLTRB(
      left,
      top,
      size.width - right,
      size.height - bottom,
    );

    final allPoints = <_OddsPoint>[
      for (final item in series) ...item.points,
    ];

    if (allPoints.isEmpty || plot.width <= 0 || plot.height <= 0) {
      return;
    }

    final minTime = allPoints
        .map((e) => e.time.millisecondsSinceEpoch.toDouble())
        .reduce(math.min);

    final maxTime = allPoints
        .map((e) => e.time.millisecondsSinceEpoch.toDouble())
        .reduce(math.max);

    double minValue =
        allPoints.map((e) => e.value).reduce(math.min);

    double maxValue =
        allPoints.map((e) => e.value).reduce(math.max);

    // "Tümü" modunda 1 / X / 2 (veya Alt / Üst, Var / Yok)
    // farklı fiyat seviyelerinde olduğu için tek mutlak Y ekseni küçük
    // hareketleri eziyordu. Birden fazla outcome varsa hareketleri
    // her serinin ilk değerine göre yüzde değişim olarak çiziyoruz.
    final compareMode =
        series.map((e) => e.outcome).toSet().length > 1;

    double compareMin = 0.0;
    double compareMax = 0.0;

    if (compareMode) {
      bool seeded = false;

      for (final item in series) {
        if (item.points.isEmpty) continue;

        final base = item.points.first.value;
        if (base == 0) continue;

        for (final point in item.points) {
          final pct = ((point.value - base) / base) * 100.0;

          if (!seeded) {
            compareMin = pct;
            compareMax = pct;
            seeded = true;
          } else {
            compareMin = math.min(compareMin, pct);
            compareMax = math.max(compareMax, pct);
          }
        }
      }

      final compareRange = compareMax - compareMin;

      if (compareRange.abs() < 0.0001) {
        compareMin -= 0.50;
        compareMax += 0.50;
      } else {
        final pad = math.max(0.15, compareRange * 0.15);
        compareMin -= pad;
        compareMax += pad;
      }
    }

    final rawRange = maxValue - minValue;

    if (rawRange.abs() < 0.0001) {
      final pad = math.max(0.03, maxValue * 0.015);
      minValue -= pad;
      maxValue += pad;
    } else {
      final pad = math.max(0.02, rawRange * 0.12);
      minValue -= pad;
      maxValue += pad;
    }

    double xFor(DateTime time) {
      if ((maxTime - minTime).abs() < 1) {
        return plot.center.dx;
      }

      return plot.left +
          ((time.millisecondsSinceEpoch - minTime) /
                  (maxTime - minTime)) *
              plot.width;
    }

    double yFor(double value) {
      return plot.bottom -
          ((value - minValue) / (maxValue - minValue)) *
              plot.height;
    }

    double yForSeries(_OddsSeries item, double value) {
      if (!compareMode || item.points.isEmpty) {
        return yFor(value);
      }

      final base = item.points.first.value;
      if (base == 0) return yFor(value);

      final pct = ((value - base) / base) * 100.0;

      return plot.bottom -
          ((pct - compareMin) / (compareMax - compareMin)) *
              plot.height;
    }

    final gridPaint = Paint()
      ..color = const Color(0xFF334155)
      ..strokeWidth = 1;

    for (int i = 0; i <= 4; i++) {
      final y = plot.top + plot.height * i / 4;

      canvas.drawLine(
        Offset(plot.left, y),
        Offset(plot.right, y),
        gridPaint,
      );

      final value = compareMode
          ? compareMax - (compareMax - compareMin) * i / 4
          : maxValue - (maxValue - minValue) * i / 4;

      _paintText(
        canvas,
        compareMode
            ? '${value.toStringAsFixed(1)}%'
            : value.toStringAsFixed(2),
        Offset(2, y - 6),
        const TextStyle(
          fontSize: 8,
          color: Color(0xFF94A3B8),
        ),
      );
    }

    if (selectedTime != null) {
      final selectedMillis =
          selectedTime!.millisecondsSinceEpoch.toDouble();

      final clampedMillis =
          selectedMillis.clamp(minTime, maxTime);

      final x = (maxTime - minTime).abs() < 1
          ? plot.center.dx
          : plot.left +
              ((clampedMillis - minTime) /
                      (maxTime - minTime)) *
                  plot.width;

      canvas.drawLine(
        Offset(x, plot.top),
        Offset(x, plot.bottom),
        Paint()
          ..color = const Color(0xFFF1F5F9)
              .withValues(alpha: 0.65)
          ..strokeWidth = 1.4,
      );
    }

    for (final item in series) {
      if (item.points.isEmpty) continue;

      final points = <_OddsPoint>[
        ...item.points,
      ]..sort((a, b) => a.time.compareTo(b.time));

      final path = Path();

      final first = points.first;

      path.moveTo(
        xFor(first.time),
        yForSeries(item, first.value),
      );

      for (int i = 1; i < points.length; i++) {
        final previous = points[i - 1];
        final current = points[i];

        final x = xFor(current.time);
        final previousY = yForSeries(item, previous.value);
        final currentY = yForSeries(item, current.value);

        if (current.segmentStart) {
          path.moveTo(x, currentY);
          continue;
        }

        path.lineTo(x, previousY);
        path.lineTo(x, currentY);
      }

      canvas.drawPath(
        path,
        Paint()
          ..color = item.color
          ..strokeWidth = 1.8
          ..style = PaintingStyle.stroke
          ..strokeCap = StrokeCap.square
          ..strokeJoin = StrokeJoin.miter,
      );

      final last = points.last;

      canvas.drawCircle(
        Offset(
          xFor(last.time),
          yForSeries(item, last.value),
        ),
        2.8,
        Paint()
          ..color = item.color
          ..style = PaintingStyle.fill,
      );

      _paintText(
        canvas,
        last.value.toStringAsFixed(2),
        Offset(
          plot.right + 5,
          yForSeries(item, last.value) - 5,
        ),
        TextStyle(
          fontSize: 8,
          fontWeight: FontWeight.w800,
          color: item.color,
        ),
      );
    }

    final labels = <double>[
      minTime,
      minTime + (maxTime - minTime) / 2,
      maxTime,
    ];

    for (final millis in labels) {
      final dt = DateTime.fromMillisecondsSinceEpoch(
        millis.round(),
      );

      final text =
          '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';

      final x = (maxTime - minTime).abs() < 1
          ? plot.center.dx
          : plot.left +
              ((millis - minTime) /
                      (maxTime - minTime)) *
                  plot.width;

      _paintCenteredText(
        canvas,
        text,
        Offset(x, plot.bottom + 8),
        const TextStyle(
          fontSize: 8,
          color: Color(0xFF94A3B8),
        ),
      );
    }
  }

  void _paintText(
    Canvas canvas,
    String text,
    Offset offset,
    TextStyle style,
  ) {
    final painter = TextPainter(
      text: TextSpan(
        text: text,
        style: style,
      ),
      textDirection: TextDirection.ltr,
    )..layout();

    painter.paint(canvas, offset);
  }

  void _paintCenteredText(
    Canvas canvas,
    String text,
    Offset center,
    TextStyle style,
  ) {
    final painter = TextPainter(
      text: TextSpan(
        text: text,
        style: style,
      ),
      textDirection: TextDirection.ltr,
    )..layout();

    painter.paint(
      canvas,
      Offset(
        center.dx - painter.width / 2,
        center.dy,
      ),
    );
  }

  @override
  bool shouldRepaint(
    covariant OddsChartPainter oldDelegate,
  ) {
    return oldDelegate.series != series ||
        oldDelegate.selectedTime != selectedTime;
  }
}

class _OddsSelectionPainter extends CustomPainter {
  final int? minTime;
  final int? maxTime;
  final DateTime? selectedTime;

  const _OddsSelectionPainter({
    required this.minTime,
    required this.maxTime,
    required this.selectedTime,
  });

  @override
  void paint(Canvas canvas, Size size) {
    if (selectedTime == null ||
        minTime == null ||
        maxTime == null) {
      return;
    }

    const left = 38.0;
    const top = 14.0;
    const right = 42.0;
    const bottom = 28.0;

    final plot = Rect.fromLTRB(
      left,
      top,
      size.width - right,
      size.height - bottom,
    );

    if (plot.width <= 0 || plot.height <= 0) return;

    final minMillis = minTime!.toDouble();
    final maxMillis = maxTime!.toDouble();

    final selectedMillis =
        selectedTime!.millisecondsSinceEpoch.toDouble();

    final clampedMillis =
        selectedMillis.clamp(minMillis, maxMillis);

    final x = (maxMillis - minMillis).abs() < 1
        ? plot.center.dx
        : plot.left +
            ((clampedMillis - minMillis) /
                    (maxMillis - minMillis)) *
                plot.width;

    canvas.drawLine(
      Offset(x, plot.top),
      Offset(x, plot.bottom),
      Paint()
        ..color = const Color(0xFFF1F5F9)
            .withValues(alpha: 0.65)
        ..strokeWidth = 1.4,
    );
  }

  @override
  bool shouldRepaint(
    covariant _OddsSelectionPainter oldDelegate,
  ) {
    return oldDelegate.minTime != minTime ||
        oldDelegate.maxTime != maxTime ||
        oldDelegate.selectedTime != selectedTime;
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
                    'Genel varsayılandır. Maç içinde özel aralık seçilmişse o maç kendi ayarını kullanır. Manuel “Şimdi güncelle” ayrıca çalışır.',
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
                      for (final minutes in const [120, 60, 30, 15])
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
