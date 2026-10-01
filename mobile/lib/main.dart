import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';

const String baseUrl = 'http://80.225.82.228:3100';
const String mobileKey = '68427531';
final Api api = Api();
final FlutterLocalNotificationsPlugin localNotifications =
    FlutterLocalNotificationsPlugin();

const AndroidNotificationChannel droppingFcmChannel = AndroidNotificationChannel(
  'macradar_dropping_live_v3',
  'Oran Düşüşleri Canlı',
  description: 'BetExplorer oran düşüşleri için yüksek öncelikli bildirimler.',
  importance: Importance.max,
  playSound: true,
  sound: RawResourceAndroidNotificationSound('dropping_alert'),
  enableVibration: true,
  showBadge: true,
);

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

  final androidPlugin = localNotifications
      .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin>();

  await androidPlugin?.createNotificationChannel(droppingFcmChannel);

  if (requestPermission) {
    await androidPlugin?.requestNotificationsPermission();
  }
}

@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  try {
    await Firebase.initializeApp();
  } catch (_) {}
}

Future<String> _getOrCreateDroppingDeviceId() async {
  final prefs = await SharedPreferences.getInstance();
  final existing = (prefs.getString('dropping_device_id') ?? '').trim();
  if (existing.isNotEmpty) return existing;

  final random = math.Random.secure();
  final bytes = List<int>.generate(16, (_) => random.nextInt(256));
  final id = 'android-' +
      bytes.map((value) => value.toRadixString(16).padLeft(2, '0')).join();
  await prefs.setString('dropping_device_id', id);
  return id;
}

Future<void> _registerFcmToken(String token) async {
  final clean = token.trim();
  if (clean.isEmpty) return;

  final deviceId = await _getOrCreateDroppingDeviceId();

  final response = await http
      .post(
        Uri.parse(baseUrl + '/api/dropping/device-token'),
        headers: const {
          'content-type': 'application/json',
          'x-api-key': mobileKey,
        },
        body: jsonEncode({
          'token': clean,
          'platform': 'android',
          'device_id': deviceId,
        }),
      )
      .timeout(const Duration(seconds: 20));

  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw Exception('FCM token kaydı ' + response.statusCode.toString());
  }
}

Future<void> _showDroppingForegroundMessage(RemoteMessage message) async {
  await initLocalNotifications();

  final data = message.data;
  final title = message.notification?.title ??
      ('Oran düştü • ' + (data['selection'] ?? '?'));
  final body = message.notification?.body ??
      ((data['match'] ?? 'Maç') +
          ' • ' +
          (data['previous_odd'] ?? '?') +
          ' → ' +
          (data['current_odd'] ?? '?') +
          ' • -%' +
          (data['drop_pct'] ?? '?'));

  const details = AndroidNotificationDetails(
    'macradar_dropping_live_v3',
    'Oran Düşüşleri Canlı',
    channelDescription:
        'BetExplorer oran düşüşleri için yüksek öncelikli bildirimler.',
    importance: Importance.max,
    priority: Priority.max,
    playSound: true,
    sound: RawResourceAndroidNotificationSound('dropping_alert'),
    enableVibration: true,
    onlyAlertOnce: true,
    visibility: NotificationVisibility.public,
  );

  const notificationId = 47001;

  await localNotifications.show(
    id: notificationId,
    title: title,
    body: body,
    notificationDetails: const NotificationDetails(android: details),
  );
}

Future<void> _initFirebaseMessaging() async {
  try {
    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);

    await FirebaseMessaging.instance.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );

    final token = await FirebaseMessaging.instance.getToken();
    if (token != null && token.isNotEmpty) {
      await _registerFcmToken(token);
    }

    FirebaseMessaging.instance.onTokenRefresh.listen((token) {
      _registerFcmToken(token).catchError((_) {});
    });

    FirebaseMessaging.onMessage.listen((message) {
      _showDroppingForegroundMessage(message).catchError((_) {});
    });
  } catch (_) {
    // Firebase yapılandırması yoksa mevcut uygulama normal çalışır.
  }
}

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Önce ekranı aç; servisler arka planda başlasın.
  runApp(const MacRadarApp());

  Future.microtask(_initFirebaseMessaging);
}

class Api {
  Map<String, String> get readHeaders => {
        'x-api-key': mobileKey,
      };

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
          .get(
            Uri.parse(baseUrl + path),
            headers: readHeaders,
          )
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

const int performanceEngineVersion = 84;
const Duration performanceCacheMaxAge = Duration(minutes: 20);
const String performanceCachePrefix = 'macradar_performance_v3_';
const String performanceCacheSavedAtPrefix = 'macradar_performance_saved_at_v1_';
final Map<String, Future<Map<String, dynamic>>> performanceInFlight = {};

Future<Map<String, dynamic>?> readLocalPerformance(String eventId) async {
  try {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(performanceCachePrefix + eventId);
    if (raw == null || raw.isEmpty) return null;
    final savedAtMs = prefs.getInt(performanceCacheSavedAtPrefix + eventId);
    if (savedAtMs == null) return null;
    final age = DateTime.now().millisecondsSinceEpoch - savedAtMs;
    if (age < 0 || age >= performanceCacheMaxAge.inMilliseconds) return null;
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
    final cacheMeta = data['performance_cache'];
    final updatedAtRaw = cacheMeta is Map ? cacheMeta['updated_at']?.toString() : null;
    final updatedAt = updatedAtRaw == null ? null : DateTime.tryParse(updatedAtRaw);
    final savedAtMs = updatedAt?.millisecondsSinceEpoch;
    await prefs.remove(performanceCacheSavedAtPrefix + eventId);
    if (savedAtMs == null) return;
    await prefs.setString(
      performanceCachePrefix + eventId,
      jsonEncode(data),
    );
    await prefs.setInt(
      performanceCacheSavedAtPrefix + eventId,
      savedAtMs,
    );
  } catch (_) {}
}

bool _hasPerformanceData(Map<String, dynamic> d) {
  final meta = d['meta'];
  final engineVersion = meta is Map
      ? int.tryParse(meta['engineVersion']?.toString() ?? '')
      : null;

  return engineVersion != null &&
      engineVersion == performanceEngineVersion &&
      d['evTakimi'] is Map &&
      d['deplasmanTakimi'] is Map;
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

  unawaited(
    future.then<void>(
      (_) {},
      onError: (Object _, StackTrace __) {},
    ).whenComplete(() {
      if (identical(performanceInFlight[eventId], future)) {
        performanceInFlight.remove(eventId);
      }
    }),
  );

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
    const names = ['Bülten', 'Performans', 'Düşüş'];
    const pages = [
      BulletinPage(),
      TrackedPage(),
      DroppingPage(),
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
            label: 'Performans',
          ),
          NavigationDestination(
            icon: Icon(Icons.trending_down_outlined),
            selectedIcon: Icon(Icons.trending_down_rounded),
            label: 'Düşüş',
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

    if (bulletinLocked(m)) return 'Maç başladı · takibe kapalı';
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
                  ? ok.toString() + ' maç takibe alındı. Düşüş takibi sunucuda başladı.'
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
            : 'Arşivde')
        : 'Performansı aç';

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
                    statusLine,
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
          league: m['league']?.toString() ?? '',
          matchDate: m['match_date']?.toString() ?? '',
          kickoffTime: m['kickoff_time']?.toString() ?? '',
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
          league: m['league']?.toString() ?? '',
          matchDate: m['match_date']?.toString() ?? '',
          kickoffTime: m['kickoff_time']?.toString() ?? '',
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
  final String league;
  final String matchDate;
  final String kickoffTime;

  const MatchDetail({
    super.key,
    required this.eventId,
    required this.title,
    required this.league,
    required this.matchDate,
    required this.kickoffTime,
  });

  @override
  State<MatchDetail> createState() => _MatchDetailState();
}

class _MatchDetailState extends State<MatchDetail> {
  bool _showOdds = true;
  bool _oddsLoading = true;
  bool _oddsRequestRunning = false;
  bool _trackingSaving = false;
  bool _trackingEnabled = false;
  bool _trackingSettingsLoaded = false;
  int _trackingMinutes = 60;
  List<int> _allowedTrackingMinutes = const [5, 15, 30, 60, 120];
  String _oddsError = '';
  String _lastCheckedAtText = '';
  List<Map<String, dynamic>> _oddsRows = const [];
  Timer? _oddsRefreshTimer;

  @override
  void initState() {
    super.initState();
    _loadOdds1x2();
    _oddsRefreshTimer = Timer.periodic(
      const Duration(seconds: 15),
      (_) {
        if (mounted && _showOdds) {
          _loadOdds1x2(silent: true);
        }
      },
    );
  }

  @override
  void dispose() {
    _oddsRefreshTimer?.cancel();
    super.dispose();
  }

  Future<void> _loadOdds1x2({bool silent = false}) async {
    if (_oddsRequestRunning) return;
    _oddsRequestRunning = true;

    if (mounted && !silent) {
      setState(() {
        _oddsLoading = true;
        _oddsError = '';
      });
    }

    try {
      final payload = await api.get(
        '/api/matches/' +
            Uri.encodeComponent(widget.eventId) +
            '/odds/1x2',
      );
      final current = payload['current'];
      final trackingEnabled = payload['tracking_enabled'] == true;
      final lastCheckedAtText = _formatLastCheckedAt(payload['last_checked_at']);
      final trackingMinutes =
          (payload['refresh_minutes'] as num?)?.toInt() ?? _trackingMinutes;
      final allowedRaw = payload['allowed_refresh_minutes'];
      final allowedTrackingMinutes = allowedRaw is List
          ? allowedRaw
              .whereType<num>()
              .map((value) => value.toInt())
              .where((value) => value > 0)
              .toList()
          : _allowedTrackingMinutes;
      final rawRows = current is Map ? current['rows'] : null;
      final currentSequence =
          current is Map ? current['capture_sequence']?.toString() : null;
      final rows = rawRows is List
          ? rawRows
              .whereType<Map>()
              .map((row) => Map<String, dynamic>.from(row))
              .toList()
          : <Map<String, dynamic>>[];

      final historyPayload = await api.get(
        '/api/matches/' +
            Uri.encodeComponent(widget.eventId) +
            '/odds/1x2/history?page=1',
      );
      final historyRaw = historyPayload['rows'];
      final historyRows = historyRaw is List
          ? historyRaw
              .whereType<Map>()
              .map((row) => Map<String, dynamic>.from(row))
              .toList()
          : <Map<String, dynamic>>[];

      for (final row in rows) {
        final bookmakerId = row['bookmaker_id']?.toString().trim() ?? '';
        final bookmakerName =
            row['bookmaker_name']?.toString().trim().toLowerCase() ?? '';

        Map<String, dynamic>? previous;
        for (final candidate in historyRows) {
          if (candidate['capture_sequence']?.toString() == currentSequence) {
            continue;
          }

          final candidateType = candidate['capture_type']?.toString();
          if (candidateType != 'current' && candidateType != 'periodic') {
            continue;
          }

          final candidateId =
              candidate['bookmaker_id']?.toString().trim() ?? '';
          final candidateName =
              candidate['bookmaker_name']?.toString().trim().toLowerCase() ??
                  '';
          final sameBookmaker = bookmakerId.isNotEmpty && candidateId.isNotEmpty
              ? bookmakerId == candidateId
              : bookmakerName.isNotEmpty && bookmakerName == candidateName;

          if (sameBookmaker) {
            previous = candidate;
            break;
          }
        }

        row['_home_trend'] =
            _oddTrend(row['home_odd'], previous?['home_odd']);
        row['_draw_trend'] =
            _oddTrend(row['draw_odd'], previous?['draw_odd']);
        row['_away_trend'] =
            _oddTrend(row['away_odd'], previous?['away_odd']);
      }

      if (!mounted) return;
      setState(() {
        _oddsRows = rows;
        _trackingEnabled = trackingEnabled;
        _trackingMinutes = trackingMinutes;
        _trackingSettingsLoaded = true;
        _lastCheckedAtText = lastCheckedAtText;
        if (allowedTrackingMinutes.isNotEmpty) {
          _allowedTrackingMinutes = allowedTrackingMinutes;
        }
        _oddsLoading = false;
        _oddsError = '';
      });
    } catch (e) {
      if (!mounted) return;
      if (!silent || _oddsRows.isEmpty) {
        setState(() {
          _oddsLoading = false;
          _oddsError = e.toString().replaceFirst('Exception: ', '');
        });
      }
    } finally {
      _oddsRequestRunning = false;
    }
  }

  String _formatLastCheckedAt(dynamic value) {
    final raw = value?.toString().trim() ?? '';
    if (raw.isEmpty) return '';
    final parsed = DateTime.tryParse(raw);
    if (parsed == null) return '';
    final local = parsed.toLocal();
    return local.hour.toString().padLeft(2, '0') +
        ':' +
        local.minute.toString().padLeft(2, '0');
  }

  Future<void> _saveTracking({
    required bool enabled,
    required int minutes,
  }) async {
    if (_trackingSaving) return;
    if (!_allowedTrackingMinutes.contains(minutes)) return;
    if (_trackingSettingsLoaded &&
        _trackingEnabled == enabled &&
        _trackingMinutes == minutes) {
      return;
    }

    setState(() => _trackingSaving = true);

    try {
      final payload = await api.post(
        '/api/matches/' +
            Uri.encodeComponent(widget.eventId) +
            '/tracking',
        {
          'enabled': enabled,
          'minutes': minutes,
        },
      );

      if (!mounted) return;

      setState(() {
        _trackingEnabled = payload['tracking_enabled'] == true;
        _trackingMinutes =
            (payload['refresh_minutes'] as num?)?.toInt() ?? minutes;
        _trackingSettingsLoaded = true;
        _trackingSaving = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _trackingSaving = false);
      rethrow;
    }
  }

  String _oddText(dynamic value) {
    final number = value is num
        ? value.toDouble()
        : double.tryParse(value?.toString() ?? '');
    if (number == null) return '—';
    return number.toStringAsFixed(2);
  }

  String _oddTrend(dynamic current, dynamic previous) {
    final currentValue = current is num
        ? current.toDouble()
        : double.tryParse(current?.toString() ?? '');
    final previousValue = previous is num
        ? previous.toDouble()
        : double.tryParse(previous?.toString() ?? '');

    if (currentValue == null || previousValue == null) return 'none';
    if (currentValue > previousValue) return 'up';
    if (currentValue < previousValue) return 'down';
    return 'none';
  }

  Widget _detailTab({
    required String label,
    required bool selected,
    required VoidCallback onTap,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(10),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 180),
          padding: const EdgeInsets.symmetric(vertical: 11),
          decoration: BoxDecoration(
            color: selected
                ? scheme.primaryContainer
                : scheme.surfaceContainerHighest.withOpacity(0.72),
            borderRadius: BorderRadius.circular(10),
          ),
          alignment: Alignment.center,
          child: Text(
            label,
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w900,
              color: selected
                  ? scheme.onPrimaryContainer
                  : scheme.onSurfaceVariant,
            ),
          ),
        ),
      ),
    );
  }

  String _matchDateTimeText() {
    final rawDate = widget.matchDate.trim();
    final rawTime = widget.kickoffTime.trim();
    String dateText = rawDate;

    if (rawDate.length >= 10) {
      final ymd = rawDate.substring(0, 10).split('-');
      if (ymd.length == 3) {
        dateText = ymd[2] + '.' + ymd[1] + '.' + ymd[0];
      }
    }

    if (dateText.isNotEmpty && rawTime.isNotEmpty) {
      return dateText + ' · ' + rawTime;
    }
    if (dateText.isNotEmpty) return dateText;
    if (rawTime.isNotEmpty) return rawTime;
    return 'Tarih / saat bilgisi yok';
  }

  Widget _matchIdentityCard() {
    final scheme = Theme.of(context).colorScheme;
    final teams = widget.title.split(' - ');
    final home = teams.isNotEmpty ? teams.first.trim() : widget.title.trim();
    final away =
        teams.length > 1 ? teams.sublist(1).join(' - ').trim() : '';
    final league =
        widget.league.trim().isEmpty ? 'Lig bilgisi yok' : widget.league.trim();

    return TweenAnimationBuilder<double>(
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      tween: Tween<double>(begin: 0, end: 1),
      builder: (context, value, child) => Opacity(
        opacity: value,
        child: Transform.translate(
          offset: Offset(0, 6 * (1 - value)),
          child: child,
        ),
      ),
      child: Container(
        margin: const EdgeInsets.fromLTRB(12, 2, 12, 8),
        padding: const EdgeInsets.fromLTRB(13, 11, 13, 12),
        decoration: BoxDecoration(
          color: scheme.surfaceContainerLow,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: scheme.outlineVariant.withOpacity(0.42),
          ),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.10),
              blurRadius: 12,
              offset: const Offset(0, 4),
            ),
          ],
        ),
        child: Column(
          children: [
            Row(
              children: [
                Icon(
                  Icons.emoji_events_outlined,
                  size: 15,
                  color: scheme.primary,
                ),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    league,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 10.5,
                      fontWeight: FontWeight.w800,
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      Icons.schedule_rounded,
                      size: 13,
                      color: scheme.onSurfaceVariant,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      _matchDateTimeText(),
                      style: TextStyle(
                        fontSize: 9.5,
                        fontWeight: FontWeight.w700,
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 11),
            Row(
              children: [
                Expanded(
                  child: Text(
                    home.isEmpty ? 'Ev sahibi' : home,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.left,
                    style: TextStyle(
                      fontSize: 14,
                      height: 1.15,
                      fontWeight: FontWeight.w900,
                      color: scheme.onSurface,
                    ),
                  ),
                ),
                Container(
                  margin: const EdgeInsets.symmetric(horizontal: 10),
                  padding:
                      const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
                  decoration: BoxDecoration(
                    color: scheme.primaryContainer.withOpacity(0.72),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Text(
                    'VS',
                    style: TextStyle(
                      fontSize: 9,
                      fontWeight: FontWeight.w900,
                      color: scheme.onPrimaryContainer,
                    ),
                  ),
                ),
                Expanded(
                  child: Text(
                    away.isEmpty ? 'Deplasman' : away,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.right,
                    style: TextStyle(
                      fontSize: 14,
                      height: 1.15,
                      fontWeight: FontWeight.w900,
                      color: scheme.onSurface,
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

  Widget _trackingIntervalSelector() {
    final scheme = Theme.of(context).colorScheme;
    const options = <int>[120, 60, 30, 15, 5];

    return Container(
      margin: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 11),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: scheme.outlineVariant.withOpacity(0.42),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.timer_outlined,
                size: 15,
                color: scheme.primary,
              ),
              const SizedBox(width: 6),
              Text(
                'ORAN ÇEKİM ARALIĞI',
                style: TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 0.6,
                  color: scheme.onSurfaceVariant,
                ),
              ),
              const Spacer(),
              AnimatedSwitcher(
                duration: const Duration(milliseconds: 160),
                child: _trackingSaving
                    ? SizedBox(
                        key: const ValueKey('tracking-saving'),
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(
                          strokeWidth: 1.8,
                          color: scheme.primary,
                        ),
                      )
                    : const SizedBox(
                        key: ValueKey('tracking-idle'),
                        width: 14,
                        height: 14,
                      ),
              ),
            ],
          ),
          if (_trackingSettingsLoaded && _lastCheckedAtText.isNotEmpty) ...[
            const SizedBox(height: 5),
            Text(
              'Son kontrol: ' + _lastCheckedAtText,
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w700,
                color: scheme.onSurfaceVariant,
              ),
            ),
          ],
          const SizedBox(height: 9),
          Row(
            children: [
              for (final minutes in options) ...[
                Expanded(
                  child: Padding(
                    padding: EdgeInsets.only(
                      right: minutes == options.last ? 0 : 5,
                    ),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(10),
                      onTap: _trackingSaving ||
                              !_trackingSettingsLoaded ||
                              !_allowedTrackingMinutes.contains(minutes) ||
                              _trackingMinutes == minutes
                          ? null
                          : () async {
                              try {
                                await _saveTracking(
                                  enabled: _trackingEnabled,
                                  minutes: minutes,
                                );
                              } catch (e) {
                                if (!mounted) return;
                                ScaffoldMessenger.of(context).showSnackBar(
                                  SnackBar(
                                    content: Text(
                                      e.toString().replaceFirst(
                                            'Exception: ',
                                            '',
                                          ),
                                    ),
                                  ),
                                );
                              }
                            },
                      child: AnimatedContainer(
                        duration: const Duration(milliseconds: 180),
                        curve: Curves.easeOutCubic,
                        height: 38,
                        alignment: Alignment.center,
                        decoration: BoxDecoration(
                          color: _trackingSettingsLoaded &&
                                  _trackingMinutes == minutes
                              ? scheme.primaryContainer
                              : scheme.surfaceContainerHighest.withOpacity(0.55),
                          borderRadius: BorderRadius.circular(10),
                          border: Border.all(
                            width: _trackingSettingsLoaded &&
                                    _trackingMinutes == minutes
                                ? 1.3
                                : 1,
                            color: _trackingSettingsLoaded &&
                                    _trackingMinutes == minutes
                                ? scheme.primary
                                : scheme.outlineVariant.withOpacity(0.44),
                          ),
                          boxShadow: _trackingSettingsLoaded &&
                                  _trackingMinutes == minutes
                              ? [
                                  BoxShadow(
                                    color: scheme.primary.withOpacity(0.14),
                                    blurRadius: 8,
                                    offset: const Offset(0, 2),
                                  ),
                                ]
                              : const [],
                        ),
                        child: Text(
                          minutes.toString() + ' dk',
                          style: TextStyle(
                            fontSize: 10,
                            fontWeight: _trackingSettingsLoaded &&
                                    _trackingMinutes == minutes
                                ? FontWeight.w900
                                : FontWeight.w700,
                            color: _trackingSettingsLoaded &&
                                    _trackingMinutes == minutes
                                ? scheme.onPrimaryContainer
                                : scheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _trackingToggleButton() {
    final scheme = Theme.of(context).colorScheme;
    final active = _trackingEnabled;

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(14),
        child: InkWell(
          borderRadius: BorderRadius.circular(14),
          onTap: _trackingSaving || !_trackingSettingsLoaded
              ? null
              : () async {
                  try {
                    await _saveTracking(
                      enabled: !active,
                      minutes: _trackingMinutes,
                    );
                  } catch (e) {
                    if (!mounted) return;
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text(
                          e.toString().replaceFirst('Exception: ', ''),
                        ),
                      ),
                    );
                  }
                },
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 220),
            curve: Curves.easeOutCubic,
            height: 50,
            padding: const EdgeInsets.symmetric(horizontal: 16),
            decoration: BoxDecoration(
              color: active
                  ? const Color(0xFF7F1D1D).withOpacity(0.28)
                  : scheme.primaryContainer,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(
                width: 1.2,
                color: active
                    ? const Color(0xFFEF4444).withOpacity(0.72)
                    : scheme.primary.withOpacity(0.72),
              ),
              boxShadow: [
                BoxShadow(
                  color: (active ? const Color(0xFFEF4444) : scheme.primary)
                      .withOpacity(0.12),
                  blurRadius: 10,
                  offset: const Offset(0, 3),
                ),
              ],
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 180),
                  child: _trackingSaving
                      ? SizedBox(
                          key: const ValueKey('tracking-toggle-saving'),
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: active
                                ? const Color(0xFFFCA5A5)
                                : scheme.onPrimaryContainer,
                          ),
                        )
                      : Icon(
                          active
                              ? Icons.stop_circle_outlined
                              : Icons.play_circle_outline_rounded,
                          key: ValueKey(active),
                          size: 21,
                          color: active
                              ? const Color(0xFFFCA5A5)
                              : scheme.onPrimaryContainer,
                        ),
                ),
                const SizedBox(width: 9),
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 180),
                  child: Text(
                    active ? 'Takibi Durdur' : 'Takibi Başlat',
                    key: ValueKey(active),
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w900,
                      letterSpacing: 0.2,
                      color: active
                          ? const Color(0xFFFCA5A5)
                          : scheme.onPrimaryContainer,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _marketTab(String label, {bool active = false}) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: active
            ? scheme.primary
            : scheme.surfaceContainerHighest.withOpacity(0.58),
        borderRadius: BorderRadius.circular(9),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w900,
          color: active
              ? scheme.onPrimary
              : scheme.onSurfaceVariant,
        ),
      ),
    );
  }

  Widget _trendIcon(String trend) {
    if (trend == 'up') {
      return const Icon(
        Icons.arrow_upward_rounded,
        size: 15,
        color: Color(0xFF22C55E),
      );
    }
    if (trend == 'down') {
      return const Icon(
        Icons.arrow_downward_rounded,
        size: 15,
        color: Color(0xFFDC2626),
      );
    }
    return const SizedBox(width: 15);
  }

  Widget _oddValue(
    String value, {
    bool header = false,
    String trend = 'none',
    bool closed = false,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return Expanded(
      child: Container(
        alignment: Alignment.center,
        padding: EdgeInsets.symmetric(vertical: header ? 8 : 12),
        child: header
            ? Text(
                value,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w900,
                  color: scheme.onSurfaceVariant,
                ),
              )
            : Row(
                mainAxisAlignment: MainAxisAlignment.center,
                mainAxisSize: MainAxisSize.min,
                children: [
                  closed ? const SizedBox(width: 15) : _trendIcon(trend),
                  const SizedBox(width: 3),
                  Text(
                    value,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w800,
                      color: closed
                          ? scheme.onSurfaceVariant.withOpacity(0.62)
                          : scheme.onSurface,
                      decoration: closed
                          ? TextDecoration.lineThrough
                          : TextDecoration.none,
                      decorationThickness: 2,
                    ),
                  ),
                ],
              ),
      ),
    );
  }

  Future<void> _openBookmakerHistory(
    String bookmakerKey,
    String bookmakerName,
  ) async {
    final key = bookmakerKey.trim();
    if (key.isEmpty) return;

    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => BookmakerOddsHistoryPage(
          eventId: widget.eventId,
          bookmakerKey: key,
          bookmakerName: bookmakerName,
        ),
      ),
    );
  }

  Widget _bookmakerRow(
    String bookmakerKey,
    String name,
    String home,
    String draw,
    String away,
    String homeTrend,
    String drawTrend,
    String awayTrend,
    bool homeClosed,
    bool drawClosed,
    bool awayClosed,
  ) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: Colors.transparent,
      borderRadius: BorderRadius.circular(14),
      child: InkWell(
        borderRadius: BorderRadius.circular(14),
        onTap: () => _openBookmakerHistory(bookmakerKey, name),
        child: Container(
          margin: const EdgeInsets.only(bottom: 7),
          decoration: BoxDecoration(
            color: scheme.surfaceContainerLow,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(
              color: scheme.outlineVariant.withOpacity(0.34),
            ),
          ),
          child: Row(
            children: [
          Expanded(
            flex: 16,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 13),
              child: Text(
                name,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w900,
                  color: scheme.onSurface,
                ),
              ),
            ),
          ),
          Expanded(
            flex: 21,
            child: Row(
              children: [
                _oddValue(
                  home,
                  trend: homeTrend,
                  closed: homeClosed,
                ),
                _oddValue(
                  draw,
                  trend: drawTrend,
                  closed: drawClosed,
                ),
                _oddValue(
                  away,
                  trend: awayTrend,
                  closed: awayClosed,
                ),
              ],
            ),
          ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _oddsSkeleton() {
    final scheme = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _matchIdentityCard(),
        _trackingIntervalSelector(),
        _trackingToggleButton(),
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.fromLTRB(12, 6, 12, 8),
          child: Row(
            children: [
              _marketTab('1X2', active: true),
              const SizedBox(width: 8),
              _marketTab('Alt/Üst'),
              const SizedBox(width: 8),
              _marketTab('Asian'),
              const SizedBox(width: 8),
              _marketTab('KG'),
            ],
          ),
        ),
        Container(
          margin: const EdgeInsets.fromLTRB(12, 4, 12, 0),
          decoration: BoxDecoration(
            color: scheme.surfaceContainerHighest.withOpacity(0.54),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: scheme.outlineVariant.withOpacity(0.35),
            ),
          ),
          clipBehavior: Clip.antiAlias,
          child: Row(
            children: [
              Expanded(
                flex: 16,
                child: Padding(
                  padding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  child: Text(
                    'BOOKMAKER',
                    style: TextStyle(
                      fontSize: 10,
                      fontWeight: FontWeight.w900,
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ),
              ),
              Expanded(
                flex: 21,
                child: Row(
                  children: [
                    _oddValue('1', header: true),
                    _oddValue('X', header: true),
                    _oddValue('2', header: true),
                  ],
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: Container(
            margin: const EdgeInsets.fromLTRB(12, 0, 12, 12),
            decoration: BoxDecoration(
              color: Colors.transparent,
              borderRadius: const BorderRadius.vertical(
                bottom: Radius.circular(12),
              ),
              border: Border.all(color: Colors.transparent),
            ),
            clipBehavior: Clip.antiAlias,
            child: _oddsLoading
                ? const Center(child: CircularProgressIndicator())
                : _oddsError.isNotEmpty
                    ? Center(
                        child: Padding(
                          padding: const EdgeInsets.all(20),
                          child: Text(
                            _oddsError,
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w700,
                              color: scheme.error,
                            ),
                          ),
                        ),
                      )
                    : _oddsRows.isEmpty
                        ? Center(
                            child: Text(
                              '1X2 oranı bulunamadı.',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w700,
                                color: scheme.onSurfaceVariant,
                              ),
                            ),
                          )
                        : ListView(
                            padding: const EdgeInsets.only(top: 7),
                            children: [
                              for (final row in _oddsRows)
                                _bookmakerRow(
                                  row['bookmaker_id']?.toString().trim().isNotEmpty == true
                                      ? row['bookmaker_id'].toString()
                                      : row['bookmaker_name']?.toString() ?? '',
                                  row['bookmaker_name']?.toString() ?? '—',
                                  _oddText(row['home_odd']),
                                  _oddText(row['draw_odd']),
                                  _oddText(row['away_odd']),
                                  row['_home_trend']?.toString() ?? 'none',
                                  row['_draw_trend']?.toString() ?? 'none',
                                  row['_away_trend']?.toString() ?? 'none',
                                  row['home_closed'] == true,
                                  row['draw_closed'] == true,
                                  row['away_closed'] == true,
                                ),
                            ],
                          ),
          ),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.title,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
            child: Row(
              children: [
                _detailTab(
                  label: 'Oran',
                  selected: _showOdds,
                  onTap: () => setState(() => _showOdds = true),
                ),
                const SizedBox(width: 8),
                _detailTab(
                  label: 'Performans',
                  selected: !_showOdds,
                  onTap: () => setState(() => _showOdds = false),
                ),
              ],
            ),
          ),
          Expanded(
            child: _showOdds
                ? _oddsSkeleton()
                : PerformanceV83Panel(
                    eventId: widget.eventId,
                    title: widget.title,
                  ),
          ),
        ],
      ),
    );
  }
}


class BookmakerOddsHistoryPage extends StatefulWidget {
  final String eventId;
  final String bookmakerKey;
  final String bookmakerName;

  const BookmakerOddsHistoryPage({
    super.key,
    required this.eventId,
    required this.bookmakerKey,
    required this.bookmakerName,
  });

  @override
  State<BookmakerOddsHistoryPage> createState() => _BookmakerOddsHistoryPageState();
}

class _BookmakerOddsHistoryPageState extends State<BookmakerOddsHistoryPage> {
  bool loading = true;
  String error = '';
  List<Map<String, dynamic>> rows = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      loading = true;
      error = '';
    });

    try {
      final payload = await api.get(
        '/api/matches/' +
            Uri.encodeComponent(widget.eventId) +
            '/odds/1x2/history?page=1&bookmaker=' +
            Uri.encodeQueryComponent(widget.bookmakerKey),
      );
      final raw = payload['rows'];
      final loaded = raw is List
          ? raw
              .whereType<Map>()
              .map((row) => Map<String, dynamic>.from(row))
              .toList()
          : <Map<String, dynamic>>[];

      loaded.sort((a, b) {
        final aType = a['capture_type']?.toString() ?? '';
        final bType = b['capture_type']?.toString() ?? '';
        if (aType == 'opening' && bType != 'opening') return 1;
        if (bType == 'opening' && aType != 'opening') return -1;

        final aTime =
            DateTime.tryParse(a['captured_at']?.toString() ?? '') ??
                DateTime.fromMillisecondsSinceEpoch(0);
        final bTime =
            DateTime.tryParse(b['captured_at']?.toString() ?? '') ??
                DateTime.fromMillisecondsSinceEpoch(0);
        return bTime.compareTo(aTime);
      });

      if (!mounted) return;
      setState(() {
        rows = loaded;
        loading = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        loading = false;
        error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  String _odd(dynamic value) {
    final n = value is num
        ? value.toDouble()
        : double.tryParse(value?.toString() ?? '');
    return n == null ? '—' : n.toStringAsFixed(2);
  }

  String _time(dynamic value) {
    final dt = DateTime.tryParse(value?.toString() ?? '')?.toLocal();
    if (dt == null) return '—';
    return dt.day.toString().padLeft(2, '0') +
        '.' +
        dt.month.toString().padLeft(2, '0') +
        '.' +
        dt.year.toString() +
        '  ' +
        dt.hour.toString().padLeft(2, '0') +
        ':' +
        dt.minute.toString().padLeft(2, '0');
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;

    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.bookmakerName,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      body: loading
          ? const Center(child: CircularProgressIndicator())
          : error.isNotEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: Text(
                      error,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        color: scheme.error,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                )
              : rows.isEmpty
                  ? Center(
                      child: Text(
                        'Bu bookmaker için oran geçmişi yok.',
                        style: TextStyle(
                          color: scheme.onSurfaceVariant,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                    )
                  : ListView.separated(
                      padding: const EdgeInsets.fromLTRB(12, 12, 12, 20),
                      itemCount: rows.length,
                      separatorBuilder: (_, __) =>
                          const SizedBox(height: 8),
                      itemBuilder: (context, index) {
                        final row = rows[index];
                        final opening =
                            row['capture_type']?.toString() == 'opening';

                        return Container(
                          padding: const EdgeInsets.fromLTRB(12, 10, 12, 11),
                          decoration: BoxDecoration(
                            color: opening
                                ? scheme.primaryContainer.withOpacity(0.72)
                                : scheme.surfaceContainerLow,
                            borderRadius: BorderRadius.circular(13),
                            border: Border.all(
                              color: opening
                                  ? scheme.primary.withOpacity(0.55)
                                  : scheme.outlineVariant.withOpacity(0.35),
                            ),
                          ),
                          child: Row(
                            children: [
                              Expanded(
                                flex: 17,
                                child: Column(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      opening
                                          ? 'Açılış'
                                          : _time(row['captured_at']),
                                      style: TextStyle(
                                        fontSize: 11,
                                        fontWeight: FontWeight.w900,
                                        color: opening
                                            ? scheme.onPrimaryContainer
                                            : scheme.onSurfaceVariant,
                                      ),
                                    ),
                                    if (opening) ...[
                                      const SizedBox(height: 2),
                                      Text(
                                        _time(row['captured_at']),
                                        style: TextStyle(
                                          fontSize: 9.5,
                                          fontWeight: FontWeight.w600,
                                          color: scheme.onSurfaceVariant,
                                        ),
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                              Expanded(
                                flex: 15,
                                child: Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        _odd(row['home_odd']),
                                        textAlign: TextAlign.center,
                                        style: TextStyle(
                                          fontSize: 13,
                                          fontWeight: FontWeight.w900,
                                          color: scheme.onSurface,
                                        ),
                                      ),
                                    ),
                                    Expanded(
                                      child: Text(
                                        _odd(row['draw_odd']),
                                        textAlign: TextAlign.center,
                                        style: TextStyle(
                                          fontSize: 13,
                                          fontWeight: FontWeight.w900,
                                          color: scheme.onSurface,
                                        ),
                                      ),
                                    ),
                                    Expanded(
                                      child: Text(
                                        _odd(row['away_odd']),
                                        textAlign: TextAlign.center,
                                        style: TextStyle(
                                          fontSize: 13,
                                          fontWeight: FontWeight.w900,
                                          color: scheme.onSurface,
                                        ),
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
    );
  }
}

class PerformanceV83Panel extends StatefulWidget {
  final String eventId;
  final String title;

  const PerformanceV83Panel({
    super.key,
    required this.eventId,
    required this.title,
  });

  @override
  State<PerformanceV83Panel> createState() => _PerformanceV83PanelState();
}
class _PerformanceV83PanelState extends State<PerformanceV83Panel>
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

  List<dynamic> _list(dynamic v) => v is List ? List<dynamic>.from(v) : <dynamic>[];
  String _v(dynamic v, {int decimals = 2}) {
    if (v == null) return '—';
    if (v is bool) return v ? 'Evet' : 'Hayır';
    if (v is num) {
      if (v.toDouble() == v.toInt().toDouble()) return v.toInt().toString();
      return v.toDouble().toStringAsFixed(decimals);
    }
    return v.toString();
  }

  String _confidenceText(dynamic value) {
    return value == null ? 'Hesaplanmadı' : _v(value);
  }

  String _date(dynamic raw) {
    if (raw == null) return '—';
    try {
      final d = DateTime.parse(raw.toString()).toLocal();
      return d.day.toString().padLeft(2, '0') + '.' +
          d.month.toString().padLeft(2, '0') + '.' +
          d.year.toString() + ' ' +
          d.hour.toString().padLeft(2, '0') + ':' +
          d.minute.toString().padLeft(2, '0');
    } catch (_) {
      return raw.toString();
    }
  }

  String _record(Map<String, dynamic> team, String period) {
    final r = _map(_map(team[period])['sonuc']);
    if (r.isEmpty) return '—';
    return _v(r['galibiyet'], decimals: 0) + 'G ' +
        _v(r['beraberlik'], decimals: 0) + 'B ' +
        _v(r['maglubiyet'], decimals: 0) + 'M';
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
      final fresh = await fetchPerformancePersistent(widget.eventId, force: force);
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

  Future<void> refresh() async => load(force: true);

  Widget _section(String text, {String? trailing}) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(3, 16, 3, 7),
      child: Row(
        children: [
          Expanded(child: Text(text, style: const TextStyle(
            fontSize: 13, fontWeight: FontWeight.w900))),
          if (trailing != null)
            Text(trailing, style: const TextStyle(
              fontSize: 9, color: Color(0xFF7B8A82))),
        ],
      ),
    );
  }
  Widget _chip(String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: const Color(0xFF172332),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0xFF2E4157)),
      ),
      child: Text(text, style: const TextStyle(
        fontSize: 9, fontWeight: FontWeight.w700, color: Color(0xFFB9C7D5))),
    );
  }

  Widget _banner() {
    final meta = _map(data['meta']);
    final coverage = _map(data['data_coverage']);
    final parts = <Widget>[
      _chip('Kaynak: ' + (meta['kaynak']?.toString() ?? '—')),
      _chip('Kapsam: ' + _v(coverage['available_count'], decimals: 0) +
          '/' + _v(coverage['total_count'], decimals: 0) +
          (coverage['score'] != null
              ? ' · %' + _v(coverage['score'], decimals: 0)
              : '')),
      _chip('Güven: ${_confidenceText(data['data_confidence'])}'),
      _chip(loadedFromCache ? 'Telefon cache' : 'Canlı API'),
    ];

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF101A24),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: const Color(0xFF29465F)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(Icons.analytics_outlined, size: 19, color: Color(0xFF60A5FA)),
              const SizedBox(width: 8),
              Expanded(child: Text(
                'MacRadar Performans Motoru v' + _v(meta['engineVersion'], decimals: 0),
                style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w900),
              )),
              if (refreshing)
                const SizedBox(width: 15, height: 15,
                    child: CircularProgressIndicator(strokeWidth: 1.6))
              else
                InkWell(
                  onTap: refresh,
                  borderRadius: BorderRadius.circular(20),
                  child: const Padding(
                    padding: EdgeInsets.all(5),
                    child: Icon(Icons.refresh_rounded, size: 18, color: Color(0xFF60A5FA)),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 8),
          Wrap(spacing: 6, runSpacing: 6, children: parts),
          if (refreshError.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(refreshError, style: const TextStyle(fontSize: 10, color: Color(0xFFFFC88A))),
          ],
        ],
      ),
    );
  }
  Widget _teamHeader(Map<String, dynamic> home, Map<String, dynamic> away) {
    Widget side(Map<String, dynamic> team, TextAlign align) {
      return Expanded(
        child: Column(
          crossAxisAlignment: align == TextAlign.right
              ? CrossAxisAlignment.end : CrossAxisAlignment.start,
          children: [
            Text(
              team['takim']?.toString() ?? '—',
              textAlign: align,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w900),
            ),
            const SizedBox(height: 3),
            Text(team['veriKaynagi']?.toString() ?? '',
                style: const TextStyle(fontSize: 9, color: Color(0xFF7C8A83))),
          ],
        ),
      );
    }

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFF151E2B),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(children: [
        side(home, TextAlign.left),
        const Padding(
          padding: EdgeInsets.symmetric(horizontal: 8),
          child: Text('VS', style: TextStyle(
            fontSize: 10, fontWeight: FontWeight.w900, color: Color(0xFF60A5FA))),
        ),
        side(away, TextAlign.right),
      ]),
    );
  }
  Widget _period(String label, Map<String, dynamic> home,
      Map<String, dynamic> away, String period) {
    Widget side(Map<String, dynamic> team, TextAlign align) {
      final p = _map(team[period]);
      final r = _map(p['sonuc']);
      final cross = align == TextAlign.right
          ? CrossAxisAlignment.end : CrossAxisAlignment.start;
      return Expanded(
        child: Column(
          crossAxisAlignment: cross,
          children: [
            Text(team['takim']?.toString() ?? '—', textAlign: align,
                maxLines: 1, overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 10, color: Color(0xFF8EA2B5))),
            const SizedBox(height: 4),
            Text(_record(team, period), textAlign: align,
                style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w900)),
            const SizedBox(height: 4),
            Text('Gol ' + _v(r['attigiGol'], decimals: 0) + ' / ' +
                _v(r['yedigiGol'], decimals: 0), textAlign: align,
                style: const TextStyle(fontSize: 10)),
            Text('Maç başı ' + _v(r['macBasiGol']) + ' / ' + _v(r['macBasiYedigi']),
                textAlign: align, style: const TextStyle(
                  fontSize: 9, color: Color(0xFF8EA2B5))),
            const SizedBox(height: 5),
            Text('xG ' + _v(p['xG']) + '  xGA ' + _v(p['xGA']), textAlign: align,
                style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800,
                  color: Color(0xFF7DD3FC))),
            Text('xG veri: ' + _v(p['xGVerisi'], decimals: 0) + ' maç', textAlign: align,
                style: const TextStyle(fontSize: 8.5, color: Color(0xFF718096))),
          ],
        ),
      );
    }
    return Container(
      padding: const EdgeInsets.all(11),
      decoration: BoxDecoration(
        color: const Color(0xFF111827),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: const Color(0xFF243246)),
      ),
      child: Column(children: [
        Text(label, style: const TextStyle(
          fontSize: 11, fontWeight: FontWeight.w900, color: Color(0xFF60A5FA))),
        const SizedBox(height: 9),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            side(home, TextAlign.left),
            const SizedBox(width: 10),
            side(away, TextAlign.right),
          ],
        ),
      ]),
    );
  }

  Widget _statRow(String label, dynamic left, dynamic right) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 7),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: Color(0xFF202B38), width: .6))),
      child: Row(children: [
        Expanded(child: Text(_v(left), style: const TextStyle(
          fontSize: 10, fontWeight: FontWeight.w800))),
        SizedBox(width: 142, child: Text(label, textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 9, color: Color(0xFF8EA2B5)))),
        Expanded(child: Text(_v(right), textAlign: TextAlign.right,
            style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800))),
      ]),
    );
  }
  Widget _stats(Map<String, dynamic> home, Map<String, dynamic> away, String period) {
    final h = _map(_map(home['standartIstatistik'])[period]);
    final a = _map(_map(away['standartIstatistik'])[period]);
    const metrics = <List<String>>[
      ['shots','Şut'], ['shotsOnTarget','İsabetli şut'],
      ['shotsAllowed','Rakip şut'], ['shotsOnTargetAllowed','Rakip isabetli'],
      ['shotsInsideBox','Ceza sahası şut'], ['shotsInsideBoxAllowed','Rakip ceza sahası şut'],
      ['bigChances','Büyük pozisyon'], ['bigChancesAllowed','Rakip büyük poz.'],
      ['corners','Korner'], ['cornersAllowed','Rakip korner'],
      ['possession','Topa sahip olma %'], ['passes','Pas'],
      ['accuratePasses','İsabetli pas'], ['passAccuracy','Pas isabet %'],
      ['ownHalfPasses','Kendi yarı alan pas'], ['oppositionHalfPasses','Rakip yarı alan pas'],
      ['touchesOppBox','Rakip ceza saha temas'], ['touchesOppBoxAllowed','Rakip temas izin'],
      ['tackles','Müdahale'], ['interceptions','Top kesme'],
      ['shotBlocks','Şut blok'], ['clearances','Uzaklaştırma'],
      ['duelsWon','Kazanılan ikili'], ['groundDuelsWon','Kazanılan yer'],
      ['aerialDuelsWon','Kazanılan hava'], ['successfulDribbles','Başarılı dripling'],
      ['accurateLongBalls','İsabetli uzun top'], ['accurateCrosses','İsabetli orta'],
      ['keeperSaves','Kaleci kurtarış'], ['savePercentage','Kurtarış %'],
      ['yellowCards','Sarı kart'], ['redCards','Kırmızı kart'],
    ];

    if (h.isEmpty && a.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(10),
        child: Text('Bu maç için detaylı standart istatistik henüz yok.',
            style: TextStyle(fontSize: 10, color: Color(0xFF829089))),
      );
    }

    return Column(children: [
      for (final m in metrics) _statRow(m[1], h[m[0]], a[m[0]]),
    ]);
  }
  void _flatten(dynamic value, String prefix,
      List<MapEntry<String, String>> out, {int depth = 0, int maxDepth = 4}) {
    if (out.length >= 90 || value == null || depth > maxDepth) return;
    if (value is Map) {
      for (final e in value.entries) {
        if (e.key.toString().startsWith('_')) continue;
        final key = prefix.isEmpty ? e.key.toString() : prefix + ' / ' + e.key.toString();
        _flatten(e.value, key, out, depth: depth + 1, maxDepth: maxDepth);
        if (out.length >= 90) break;
      }
      return;
    }
    if (value is List) {
      if (value.isEmpty) {
        out.add(MapEntry(prefix, '0 kayıt'));
      } else if (value.every((e) => e is! Map && e is! List)) {
        out.add(MapEntry(prefix, value.take(15).join(', ')));
      } else {
        out.add(MapEntry(prefix, value.length.toString() + ' kayıt'));
      }
      return;
    }
    out.add(MapEntry(prefix, _v(value)));
  }

  Widget _generic(String title, dynamic raw, {String? subtitle,
      bool expanded = false, int maxDepth = 4}) {
    final entries = <MapEntry<String, String>>[];
    _flatten(raw, '', entries, maxDepth: maxDepth);
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ExpansionTile(
        initiallyExpanded: expanded,
        title: Text(title, style: const TextStyle(
          fontSize: 12, fontWeight: FontWeight.w800)),
        subtitle: Text(subtitle ?? (entries.isEmpty ? 'Veri yok' :
          entries.length.toString() + ' alan'), style: const TextStyle(fontSize: 9)),
        childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
        children: [
          if (entries.isEmpty)
            const Padding(
              padding: EdgeInsets.all(8),
              child: Text('Bu veri kaynağı henüz mevcut değil.',
                  style: TextStyle(fontSize: 10, color: Color(0xFF829089))),
            )
          else
            for (final e in entries)
              Container(
                padding: const EdgeInsets.symmetric(vertical: 5),
                decoration: const BoxDecoration(
                  border: Border(top: BorderSide(color: Color(0xFF202B38), width: .5))),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(flex: 5, child: Text(
                      e.key.isEmpty ? 'değer' : e.key,
                      style: const TextStyle(fontSize: 8.7, color: Color(0xFF8EA2B5)))),
                    const SizedBox(width: 8),
                    Expanded(flex: 4, child: Text(
                      e.value, textAlign: TextAlign.right,
                      style: const TextStyle(fontSize: 9, fontWeight: FontWeight.w700))),
                  ],
                ),
              ),
        ],
      ),
    );
  }

  Widget _teamPair(String title, Map<String, dynamic> home,
      Map<String, dynamic> away, String key) {
    final h = home[key];
    final a = away[key];
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ExpansionTile(
        title: Text(title, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w800)),
        subtitle: Text(h == null && a == null ? 'Veri yok' : 'Ev / deplasman ayrıntısı',
            style: const TextStyle(fontSize: 9)),
        childrenPadding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
        children: [
          _generic(home['takim']?.toString() ?? 'Ev', h, maxDepth: 3),
          _generic(away['takim']?.toString() ?? 'Dep', a, maxDepth: 3),
        ],
      ),
    );
  }

  Widget _lineup(Map<String, dynamic> team) {
    final lineup = _map(team['lineup']);
    final last = _map(lineup['sonMac']);
    final starters = _maps(last['starters']);
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ExpansionTile(
        title: Text(team['takim']?.toString() ?? 'Takım',
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w800)),
        subtitle: Text(starters.isEmpty ? 'Kadro verisi yok' :
            starters.length.toString() + ' ilk 11 · ' + (last['formation']?.toString() ?? '—'),
            style: const TextStyle(fontSize: 9)),
        childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
        children: [
          if (last.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text('Formasyon: ' + (last['formation']?.toString() ?? '—') +
                  ' · Takım rating: ' + _v(last['teamRating']) +
                  ' · Ort. yaş: ' + _v(last['averageStarterAge']),
                  style: const TextStyle(fontSize: 9)),
            ),
          for (final p in starters.take(11))
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 3),
              child: Row(children: [
                SizedBox(width: 28, child: Text(p['shirtNumber']?.toString() ?? '—',
                    style: const TextStyle(fontSize: 9, color: Color(0xFF60A5FA)))),
                Expanded(child: Text(p['name']?.toString() ?? '—',
                    style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w700))),
                Text(_v(p['rating']), style: const TextStyle(fontSize: 9)),
              ]),
            ),
        ],
      ),
    );
  }

  Widget _absences(Map<String, dynamic> home, Map<String, dynamic> away) {
    Widget side(Map<String, dynamic> team) {
      final rows = _maps(team['eksikler']);
      final ok = team['eksikVerisi'] == true;
      return Expanded(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(team['takim']?.toString() ?? '—',
              style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800,
                color: Color(0xFF60A5FA))),
          const SizedBox(height: 5),
          if (!ok)
            const Text('Eksik verisi alınamadı',
                style: TextStyle(fontSize: 9, color: Color(0xFF829089)))
          else if (rows.isEmpty)
            const Text('Kayıtlı eksik yok', style: TextStyle(fontSize: 9))
          else
            for (final p in rows.take(12))
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text((p['ad'] ?? p['name'] ?? '—').toString() + ' · ' +
                    (p['durum'] ?? p['status'] ?? '—').toString(),
                    style: const TextStyle(fontSize: 9)),
              ),
        ]),
      );
    }
    return Card(
      margin: EdgeInsets.zero,
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          side(home), const SizedBox(width: 12), side(away),
        ]),
      ),
    );
  }

  Widget _matchLine(Map<String, dynamic> m) {
    final h = (m['ev'] ?? m['home'] ?? '—').toString();
    final a = (m['deplasman'] ?? m['away'] ?? '—').toString();
    final hs = m['evGol'] ?? m['homeScore'];
    final as = m['deplasmanGol'] ?? m['awayScore'];
    final score = hs != null && as != null
        ? ' ' + _v(hs, decimals: 0) + '-' + _v(as, decimals: 0) + ' '
        : ' - ';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(children: [
        Expanded(child: Text(h + score + a, maxLines: 1,
            overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 9.5))),
        const SizedBox(width: 8),
        Text(_date(m['tarih'] ?? m['date']),
            style: const TextStyle(fontSize: 8, color: Color(0xFF78857E))),
      ]),
    );
  }

  Widget _fixtures(Map<String, dynamic> home, Map<String, dynamic> away) {
    Widget team(Map<String, dynamic> t) {
      final next = _maps(t['sonrakiMaclar']);
      final history = _maps(t['maclar']);
      final dense = _map(t['fiksturYogunlugu']);
      return Card(
        margin: const EdgeInsets.only(bottom: 8),
        child: ExpansionTile(
          title: Text(t['takim']?.toString() ?? 'Takım',
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w800)),
          subtitle: Text('7g ' + _v(dense['sonraki7Gun'], decimals: 0) +
              ' · 14g ' + _v(dense['sonraki14Gun'], decimals: 0) +
              ' · Geçmiş ' + history.length.toString(),
              style: const TextStyle(fontSize: 9)),
          childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
          children: [
            if (next.isNotEmpty)
              const Align(alignment: Alignment.centerLeft,
                child: Text('Sonraki maçlar', style: TextStyle(
                  fontSize: 10, fontWeight: FontWeight.w900, color: Color(0xFF60A5FA)))),
            for (final m in next.take(5)) _matchLine(m),
            if (history.isNotEmpty) ...[
              const Divider(height: 18),
              const Align(alignment: Alignment.centerLeft,
                child: Text('Analize giren geçmiş maçlar', style: TextStyle(
                  fontSize: 10, fontWeight: FontWeight.w900, color: Color(0xFF60A5FA)))),
              for (final m in history.take(10)) _matchLine(m),
            ],
          ],
        ),
      );
    }
    return Column(children: [team(home), team(away)]);
  }

  Widget _h2h() {
    final h2h = _map(data['h2h']);
    final rows = _maps(h2h['maclar']);
    return Card(
      margin: EdgeInsets.zero,
      child: ExpansionTile(
        initiallyExpanded: rows.isNotEmpty,
        title: const Text('İkili rekabet (H2H)',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800)),
        subtitle: Text(rows.length.toString() + '/' +
            _v(h2h['hedef'], decimals: 0) + ' maç · ' +
            (h2h['kaynak']?.toString() ?? '—'),
            style: const TextStyle(fontSize: 9)),
        childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
        children: [
          if (rows.isEmpty)
            const Padding(
              padding: EdgeInsets.all(8),
              child: Text('Geçmiş karşılaşma bulunamadı.',
                  style: TextStyle(fontSize: 10)),
            ),
          for (final m in rows) _matchLine(m),
        ],
      ),
    );
  }

  Widget _tagGroup(String title, List<dynamic> values, Color color) {
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(title, style: const TextStyle(fontSize: 9, fontWeight: FontWeight.w900)),
        const SizedBox(height: 5),
        Wrap(spacing: 5, runSpacing: 5, children: [
          for (final item in values)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
              decoration: BoxDecoration(color: color, borderRadius: BorderRadius.circular(15)),
              child: Text(item.toString(), style: const TextStyle(fontSize: 8)),
            ),
        ]),
      ]),
    );
  }
  Widget _coverage(Map<String, dynamic> home, Map<String, dynamic> away) {
    final c = _map(data['data_coverage']);
    final available = _list(c['available']);
    final missing = _list(c['missing']);
    final added = _list(c['supplement_added']);
    final metricSources = _map(c['metric_sources']);
    final supplements = _map(data['source_supplements']);
    return Column(children: [
      Card(
        margin: const EdgeInsets.only(bottom: 8),
        child: ExpansionTile(
          initiallyExpanded: true,
          title: const Text('Veri kapsamı',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800)),
          subtitle: Text(_v(c['available_count'], decimals: 0) + '/' +
              _v(c['total_count'], decimals: 0) + ' alan · ' +
              available.length.toString() + ' mevcut · ' +
              missing.length.toString() + ' eksik',
              style: const TextStyle(fontSize: 9)),
          childrenPadding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
          children: [
            if (available.isNotEmpty) _tagGroup('Mevcut', available, const Color(0xFF14532D)),
            if (added.isNotEmpty) _tagGroup('Supplement ile tamamlanan', added, const Color(0xFF1E3A5F)),
            if (missing.isNotEmpty) _tagGroup('Eksik', missing, const Color(0xFF4A2630)),
          ],
        ),
      ),
      _generic('Metrik kaynakları', metricSources, maxDepth: 2),
      _generic('Motor / kaynak meta', {
        'meta': data['meta'],
        'evTakimiKaynak': home['veriKaynagi'],
        'deplasmanTakimiKaynak': away['veriKaynagi'],
        'coverage_score': c['score'],
        'primary_coverage_score': c['primary_score'],
        'data_confidence': data['data_confidence'],
        'primary_data_confidence': data['primary_data_confidence'],
        'confidence_policy': _map(data['meta'])['confidencePolicy'],
      }, maxDepth: 3),
      _generic('Supplement kaynakları', supplements,
          subtitle: supplements.isEmpty ? 'Supplement yok' : supplements.keys.join(', '),
          maxDepth: 3),
    ]);
  }
  Widget _advanced(Map<String, dynamic> home, Map<String, dynamic> away) {
    const contexts = <List<String>>[
      ['Kaleci', 'goalkeeperContext'],
      ['Kırmızı kart bağlamı', 'kirmiziKartBaglami'],
      ['Oyuncu ilerleme', 'playerProgressionContext'],
      ['Takım ilerleme / pas', 'progressionContext'],
      ['Pressing', 'pressingContext'],
      ['Savunma yapısı', 'defensiveStructureContext'],
      ['Düello / ikili mücadele', 'duelContext'],
      ['Oyun stili', 'styleContext'],
      ['Yüksek bölge top kazanma', 'highZoneRegainContext'],
      ['XI sürekliliği', 'ilk11Surekliligi'],
      ['Teknik direktör / sistem', 'teknikSistemDegisimi'],
      ['Oyuncu formu', 'oyuncuFormu'],
      ['Lig durumu', 'ligDurumu'],
      ['Stil kaynakları', 'styleSources'],
      ['İlerleme kaynakları', 'progressionSources'],
      ['Pressing kaynakları', 'pressingSources'],
      ['Sonuç vs temel performans', 'resultVsUnderlyingSources'],
    ];
    return Column(children: [
      for (final c in contexts) _teamPair(c[0], home, away, c[1]),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    if (loading) {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const CircularProgressIndicator(),
          const SizedBox(height: 12),
          Text('v$performanceEngineVersion Performans verileri hazırlanıyor…',
              style: const TextStyle(fontSize: 11, color: Color(0xFF97A39C))),
        ]),
      );
    }
    if (error.isNotEmpty) return ErrorPane(message: error, retry: load);

    final home = _map(data['evTakimi']);
    final away = _map(data['deplasmanTakimi']);
    if (home.isEmpty || away.isEmpty) {
      return ErrorPane(message: 'v$performanceEngineVersion Performans verisi eksik geldi.', retry: load);
    }

    return RefreshIndicator(
      onRefresh: refresh,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 28),
        children: [
          _banner(),
          const SizedBox(height: 8),
          _teamHeader(home, away),

          _section('Form ve gol analizi', trailing: 'Son 5 / Son 10'),
          _period('SON 5', home, away, 'son5'),
          const SizedBox(height: 8),
          _period('SON 10', home, away, 'son10'),

          _section('Detaylı maç istatistikleri', trailing: 'Eksik veri 0 sayılmaz'),
          Card(
            margin: const EdgeInsets.only(bottom: 8),
            child: ExpansionTile(
              initiallyExpanded: true,
              title: const Text('Son 5 standart istatistik',
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800)),
              children: [_stats(home, away, 'son5')],
            ),
          ),
          Card(
            margin: const EdgeInsets.only(bottom: 8),
            child: ExpansionTile(
              title: const Text('Son 10 standart istatistik',
                  style: TextStyle(fontSize: 12, fontWeight: FontWeight.w800)),
              children: [_stats(home, away, 'son10')],
            ),
          ),

          _section('Kadro, oyuncu ve sistem'),
          _lineup(home),
          _lineup(away),
          _teamPair('XI sürekliliği', home, away, 'ilk11Surekliligi'),
          _teamPair('Teknik direktör / formasyon değişimi',
              home, away, 'teknikSistemDegisimi'),
          _teamPair('Oyuncu formu', home, away, 'oyuncuFormu'),

          _section('Eksikler'),
          _absences(home, away),

          _section('Gelişmiş performans katmanları'),
          _advanced(home, away),

          _section('Fikstür ve maç geçmişi'),
          _fixtures(home, away),

          _section('Geçmiş karşılaşmalar'),
          _h2h(),

          _section('Veri kalitesi, kapsama ve kaynaklar'),
          _coverage(home, away),

          const SizedBox(height: 12),
          Center(
            child: Text(
              'v$performanceEngineVersion · Gelecek veri sızıntısı engelli · Eksik değerler 0 kabul edilmez',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 8.5, color: Color(0xFF68736D)),
            ),
          ),
        ],
      ),
    );
  }
}

class DroppingPage extends StatefulWidget {
  const DroppingPage({super.key});
  @override
  State<DroppingPage> createState() => _DroppingPageState();
}

class _DroppingPageState extends State<DroppingPage> {
  bool loading = true;
  String? error;
  List<Map<String, dynamic>> live = [];
  Map<String, dynamic> status = {};
  Map<String, dynamic> settingsData = {};
  bool savingSettings = false;
  int settingHours = 1;
  String settingMatches = 'today';
  int settingBookies = 30;
  bool settingNotifications = true;
  Timer? _autoRefreshTimer;
  bool _refreshing = false;

  @override
  void initState() {
    super.initState();
    _load();
    _autoRefreshTimer = Timer.periodic(
      const Duration(seconds: 5),
      (_) {
        if (mounted && !_refreshing && !savingSettings) {
          _load(silent: true);
        }
      },
    );
  }

  @override
  void dispose() {
    _autoRefreshTimer?.cancel();
    super.dispose();
  }

  List<Map<String, dynamic>> _mapList(dynamic raw) {
    if (raw is! List) return [];
    return raw.whereType<Map>().map((x) => Map<String, dynamic>.from(x)).toList();
  }

  num? _num(dynamic value) {
    if (value is num) return value;
    return num.tryParse(value?.toString() ?? '');
  }

  String _odd(dynamic value) {
    final n = _num(value);
    return n == null ? '-' : n.toDouble().toStringAsFixed(2);
  }

  String _pct(dynamic value) {
    final n = _num(value);
    return n == null ? '-' : n.toString() + '%';
  }

  String _stamp(dynamic value) {
    final raw = value?.toString() ?? '';
    if (raw.isEmpty) return '-';
    final dt = DateTime.tryParse(raw)?.toLocal();
    if (dt == null) return raw;
    String two(int v) => v.toString().padLeft(2, '0');
    return two(dt.day) + '.' + two(dt.month) + ' ' + two(dt.hour) + ':' + two(dt.minute) + ':' + two(dt.second);
  }

  Future<void> _load({bool silent = false}) async {
    if (_refreshing) return;
    _refreshing = true;
    if (mounted && !silent) {
      setState(() {
        loading = true;
        error = null;
      });
    }
    try {
      final current = await api.get('/api/dropping/current');
      final health = await api.get('/api/dropping/status');
      final fetchedSettings = await api.get('/api/dropping/settings');
      if (!mounted) return;
      setState(() {
        live = _mapList(current['items']);
        status = health;
        settingsData = fetchedSettings;
        settingHours = _num(fetchedSettings['drops_in_last_hours'])?.toInt() ?? 1;
        settingMatches = fetchedSettings['matches_for']?.toString() ?? 'today';
        settingBookies = _num(fetchedSettings['bookies_pct'])?.toInt() ?? 30;
        settingNotifications = fetchedSettings['notifications_enabled'] == true;
        loading = false;
      });
    } catch (e) {
      if (!mounted || silent) return;
      setState(() {
        error = e.toString().replaceFirst('Exception: ', '');
        loading = false;
      });
    } finally {
      _refreshing = false;
    }
  }

  Widget _statusCard() {
    final lastError = status['last_error']?.toString() ?? '';
    final ok = lastError.isEmpty && status['last_ok_at'] != null;
    final active = _num(status['active_count'])?.toInt() ?? live.length;
    final interval = _num(status['interval_seconds'])?.toInt();
    final pushConfigured = status['push_configured'] == true;
    final pushReady = status['push_ready'] == true;
    final pushDevices = _num(status['push_device_count'])?.toInt() ?? 0;
    final pushPending = _num(status['push_pending_count'])?.toInt() ?? 0;
    final pushFailed = _num(status['push_failed_pending_count'])?.toInt() ?? 0;
    final pushLastError = status['push_last_error']?.toString() ?? '';
    final scheme = Theme.of(context).colorScheme;
    final pushStateText = pushReady
        ? 'Push haz\u0131r'
        : (pushConfigured ? 'Telefon bekleniyor' : 'Firebase bekleniyor');
    final pushStateColor = pushReady
        ? Colors.greenAccent
        : (pushConfigured ? Colors.orangeAccent : scheme.onSurfaceVariant);
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 10, 12, 8),
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 10,
                  height: 10,
                  decoration: BoxDecoration(
                    color: ok ? Colors.greenAccent : scheme.error,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    ok ? 'Kaynak OK' : 'Kaynak kontrol edilmeli',
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
                  ),
                ),
                Text(
                  active.toString() + ' canl\u0131',
                  style: TextStyle(color: scheme.onSurfaceVariant),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Text(
              'Son ba\u015far\u0131l\u0131 kontrol: ' + _stamp(status['last_ok_at']) +
                  (interval == null ? '' : '  \u00b7  ' + interval.toString() + ' sn'),
              style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Icon(
                  pushReady
                      ? Icons.notifications_active_rounded
                      : Icons.notifications_none_rounded,
                  size: 18,
                  color: pushStateColor,
                ),
                const SizedBox(width: 7),
                Expanded(
                  child: Text(
                    pushStateText,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
                      color: pushStateColor,
                    ),
                  ),
                ),
                Text(
                  'Cihaz ' + pushDevices.toString() +
                      '  \u00b7  Bekleyen ' + pushPending.toString(),
                  style: TextStyle(
                    fontSize: 12,
                    color: scheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
            if (pushFailed > 0 || pushLastError.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                'Push hata: ' +
                    pushFailed.toString() +
                    (pushLastError.isEmpty ? '' : '  \u00b7  ' + pushLastError),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: scheme.error),
              ),
            ],
            if (lastError.isNotEmpty) ...[
              const SizedBox(height: 8),
              Text(
                lastError,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: scheme.error),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _empty(String text) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 44),
      child: Center(
        child: Column(
          children: [
            const Icon(Icons.trending_down_rounded, size: 42),
            const SizedBox(height: 12),
            Text(text),
          ],
        ),
      ),
    );
  }

  Widget _rowCard(Map<String, dynamic> item, {required bool alert}) {
    final scheme = Theme.of(context).colorScheme;
    final selection = item['selection']?.toString() ?? '?';
    final match = item['match_name']?.toString() ?? item['match']?.toString() ?? 'Ma\u00e7';
    final league = item['league']?.toString() ?? '';
    final localKickoff = _droppingLocalDateTime(item);
    final date = localKickoff.key;
    final time = localKickoff.value;
    final oldOdd = _odd(item['previous_odd'] ?? item['old_odd']);
    final currentOdd = _odd(item['current_odd']);
    final drop = _pct(item['drop_pct']);
    final bookies = _pct(item['bookies_pct']);
    final down = _num(item['bookies_down'])?.toInt();
    final total = _num(item['bookies_total'])?.toInt();

    return Card(
      margin: const EdgeInsets.fromLTRB(12, 5, 12, 5),
      child: Padding(
        padding: const EdgeInsets.all(13),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  constraints: const BoxConstraints(minWidth: 38),
                  padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
                  decoration: BoxDecoration(
                    color: scheme.primaryContainer,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    selection,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      color: scheme.onPrimaryContainer,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    match,
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
                  decoration: BoxDecoration(
                    color: Colors.redAccent.withOpacity(0.13),
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child: Text(
                    '-' + drop,
                    style: const TextStyle(color: Colors.redAccent, fontWeight: FontWeight.w800),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 11),
            Row(
              children: [
                Text(
                  oldOdd,
                  style: TextStyle(
                    color: scheme.onSurfaceVariant,
                    decoration: TextDecoration.lineThrough,
                  ),
                ),
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 7),
                  child: Icon(Icons.arrow_forward_rounded, size: 17),
                ),
                Text(
                  currentOdd,
                  style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 18),
                ),
                const Spacer(),
                Text(
                  'B: ' + bookies +
                      (down == null || total == null ? '' : ' (' + down.toString() + '/' + total.toString() + ')'),
                  style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
                ),
              ],
            ),
            const SizedBox(height: 9),
            Text(
              [
                if (league.isNotEmpty) league,
                if (date.isNotEmpty || time.isNotEmpty) (date + ' ' + time).trim(),
                if (alert) _stamp(item['created_at']),
              ].join('  \u00b7  '),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12, color: scheme.onSurfaceVariant),
            ),
          ],
        ),
      ),
    );
  }


  MapEntry<String, String> _droppingLocalDateTime(Map<String, dynamic> item) {
    final rawDate = (item['match_date']?.toString() ?? '').trim();
    final rawTime = (item['kickoff_time']?.toString() ?? '').trim();
    final dateMatch = RegExp(r'^(\d{2})\.(\d{2})\.(\d{4})$').firstMatch(rawDate);
    final timeMatch = RegExp(r'^(\d{2}):(\d{2})$').firstMatch(rawTime);
    if (dateMatch == null || timeMatch == null) {
      return MapEntry(rawDate, rawTime);
    }

    final sourceUtc = DateTime.utc(
      int.parse(dateMatch.group(3)!),
      int.parse(dateMatch.group(2)!),
      int.parse(dateMatch.group(1)!),
      int.parse(timeMatch.group(1)!),
      int.parse(timeMatch.group(2)!),
    ).subtract(const Duration(hours: 1));
    final local = sourceUtc.toLocal();
    final date =
        '${local.day.toString().padLeft(2, '0')}.${local.month.toString().padLeft(2, '0')}.${local.year.toString().padLeft(4, '0')}';
    final time =
        '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
    return MapEntry(date, time);
  }

  String _droppingFlag(dynamic rawCode, dynamic rawCountry) {
    final code = (rawCode?.toString() ?? '').trim().toLowerCase();
    final country = (rawCountry?.toString() ?? '').trim().toLowerCase();

    if (RegExp(r'^[a-z]{2}$').hasMatch(code)) {
      return String.fromCharCodes(
        code.toUpperCase().codeUnits.map((unit) => 127397 + unit),
      );
    }

    const special = <String, String>{
      'england': '🏴',
      'scotland': '🏴',
      'wales': '🏴',
      'northern ireland': '🇬🇧',
    };
    return special[country] ?? '🌐';
  }

  Widget _liveDroppingCard(Map<String, dynamic> item) {
    final scheme = Theme.of(context).colorScheme;
    final selection = (item['selection']?.toString() ?? '?').toUpperCase();
    final match = item['match_name']?.toString() ??
        item['match']?.toString() ??
        'Maç';
    final league = item['league']?.toString() ?? '';
    final country = item['country_name']?.toString() ?? '';
    final flag = _droppingFlag(item['country_code'], country);
    final localKickoff = _droppingLocalDateTime(item);
    final date = localKickoff.key;
    final time = localKickoff.value;
    final currentOdd = _num(item['current_odd']);
    final oldOdd = _num(item['old_odd'] ?? item['previous_odd']);
    final drop = _num(item['drop_pct']);
    final bookiesPct = _num(item['bookies_pct']);
    final down = _num(item['bookies_down'])?.toInt();
    final total = _num(item['bookies_total'])?.toInt();

    num? odd1 = _num(item['odd_1']);
    num? oddX = _num(item['odd_x']);
    num? odd2 = _num(item['odd_2']);
    if (selection == '1' && odd1 == null) odd1 = currentOdd;
    if (selection == 'X' && oddX == null) oddX = currentOdd;
    if (selection == '2' && odd2 == null) odd2 = currentOdd;

    final bestBetOdd = _num(item['best_bet_odd']);
    final bookmaker = (item['best_bet_bookmaker']?.toString() ?? '').trim();

    String oddText(num? value) =>
        value == null ? '-' : value.toDouble().toStringAsFixed(2);

    Widget oddCell(String label, num? value) {
      final highlighted = selection == label;
      return Expanded(
        child: Container(
          margin: EdgeInsets.only(
            left: label == '1' ? 0 : 4,
            right: label == '2' ? 0 : 4,
          ),
          padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 6),
          decoration: BoxDecoration(
            color: highlighted
                ? scheme.primary
                : scheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: highlighted
                  ? scheme.primary
                  : scheme.outlineVariant.withOpacity(0.55),
            ),
          ),
          child: Column(
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w800,
                  color: highlighted
                      ? scheme.onPrimary
                      : scheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                oddText(value),
                style: TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w900,
                  color: highlighted ? scheme.onPrimary : scheme.onSurface,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                highlighted ? 'DÜŞÜYOR' : ' ',
                style: TextStyle(
                  fontSize: 9,
                  fontWeight: FontWeight.w800,
                  color: highlighted
                      ? scheme.onPrimary.withOpacity(0.82)
                      : Colors.transparent,
                ),
              ),
            ],
          ),
        ),
      );
    }

    final dropText =
        drop == null ? '-' : '-' + drop.toString().replaceAll('.0', '') + '%';
    final bookiesText = bookiesPct == null
        ? ''
        : 'Bookies ' +
            bookiesPct.toString().replaceAll('.0', '') +
            '%' +
            (down == null || total == null
                ? ''
                : '  (' + down.toString() + '/' + total.toString() + ')');

    return Card(
      margin: const EdgeInsets.fromLTRB(12, 6, 12, 6),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.fromLTRB(13, 11, 11, 11),
            color: scheme.surfaceContainerHighest.withOpacity(0.55),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Text(flag, style: const TextStyle(fontSize: 23)),
                const SizedBox(width: 9),
                Expanded(
                  child: Text(
                    league.isEmpty ? (country.isEmpty ? 'Lig' : country) : league,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontWeight: FontWeight.w800,
                      fontSize: 13,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 9, vertical: 6),
                  decoration: BoxDecoration(
                    color: scheme.errorContainer,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    dropText,
                    style: TextStyle(
                      color: scheme.onErrorContainer,
                      fontWeight: FontWeight.w900,
                      fontSize: 14,
                    ),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(13, 12, 13, 13),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Text(
                        match,
                        style: const TextStyle(
                          fontWeight: FontWeight.w800,
                          fontSize: 16,
                        ),
                      ),
                    ),
                    if (date.isNotEmpty || time.isNotEmpty) ...[
                      const SizedBox(width: 10),
                      Text(
                        [date, time].where((x) => x.isNotEmpty).join('\n'),
                        textAlign: TextAlign.right,
                        style: TextStyle(
                          fontSize: 11,
                          height: 1.25,
                          color: scheme.onSurfaceVariant,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    oddCell('1', odd1),
                    oddCell('X', oddX),
                    oddCell('2', odd2),
                  ],
                ),
                if (oldOdd != null && currentOdd != null) ...[
                  const SizedBox(height: 9),
                  Text(
                    'Düşüş: ' +
                        oddText(oldOdd) +
                        '  →  ' +
                        oddText(currentOdd),
                    style: TextStyle(
                      fontSize: 12,
                      color: scheme.onSurfaceVariant,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
                const SizedBox(height: 11),
                Container(
                  width: double.infinity,
                  padding:
                      const EdgeInsets.symmetric(horizontal: 11, vertical: 9),
                  decoration: BoxDecoration(
                    color: scheme.surfaceContainerHighest.withOpacity(0.45),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Row(
                    children: [
                      Icon(
                        Icons.workspace_premium_outlined,
                        size: 17,
                        color: scheme.onSurfaceVariant,
                      ),
                      const SizedBox(width: 7),
                      Text(
                        'Best bet',
                        style: TextStyle(
                          fontSize: 12,
                          color: scheme.onSurfaceVariant,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      const Spacer(),
                      Text(
                        bestBetOdd == null
                            ? (bookmaker.isEmpty ? '-' : bookmaker)
                            : oddText(bestBetOdd) +
                                (bookmaker.isEmpty ? '' : ' @ ' + bookmaker),
                        style: const TextStyle(
                          fontWeight: FontWeight.w800,
                          fontSize: 13,
                        ),
                      ),
                    ],
                  ),
                ),
                if (bookiesText.isNotEmpty) ...[
                  const SizedBox(height: 7),
                  Text(
                    bookiesText,
                    style: TextStyle(
                      fontSize: 11,
                      color: scheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }


  Future<void> _saveSettings({bool showMessage = true}) async {
    if (savingSettings) return;
    setState(() => savingSettings = true);
    try {
      final response = await api.post(
        '/api/dropping/settings',
        {
          'drops_in_last_hours': settingHours,
          'matches_for': settingMatches,
          'bookies_pct': settingBookies,
          'notifications_enabled': settingNotifications,
        },
      );

      final savedRaw = response['settings'];
      if (savedRaw is Map) {
        final saved = Map<String, dynamic>.from(savedRaw);
        if (mounted) {
          setState(() {
            settingsData = saved;
            settingHours = _num(saved['drops_in_last_hours'])?.toInt() ?? settingHours;
            settingMatches = saved['matches_for']?.toString() ?? settingMatches;
            settingBookies = _num(saved['bookies_pct'])?.toInt() ?? settingBookies;
            settingNotifications = saved['notifications_enabled'] == true;
          });
        }
      }

      if (!mounted) return;
      if (showMessage) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('D\u00fc\u015f\u00fc\u015f ayarlar\u0131 kaydedildi.')),
        );
      }
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            e.toString().replaceFirst('Exception: ', ''),
          ),
        ),
      );
    } finally {
      if (mounted) setState(() => savingSettings = false);
    }
  }

  Future<void> _applyLiveFilter({
    int? hours,
    String? matches,
    int? bookies,
  }) async {
    if (savingSettings) return;
    setState(() {
      if (hours != null) settingHours = hours;
      if (matches != null) settingMatches = matches;
      if (bookies != null) settingBookies = bookies;
    });
    await _saveSettings(showMessage: false);
    await Future<void>.delayed(const Duration(milliseconds: 500));
    if (mounted) await _load();
  }

  Widget _liveFiltersCard() {
    return Card(
      margin: const EdgeInsets.fromLTRB(12, 2, 12, 8),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
        child: Column(
          children: [
            DropdownButtonFormField<int>(
              value: settingHours,
              decoration: const InputDecoration(
                labelText: 'Düşüşler · son',
                border: OutlineInputBorder(),
                isDense: true,
              ),
              items: const [
                DropdownMenuItem(value: 1, child: Text('1 saat')),
                DropdownMenuItem(value: 2, child: Text('2 saat')),
                DropdownMenuItem(value: 12, child: Text('12 saat')),
                DropdownMenuItem(value: 24, child: Text('24 saat')),
                DropdownMenuItem(value: 48, child: Text('48 saat')),
              ],
              onChanged: savingSettings ? null : (v) {
                if (v != null) _applyLiveFilter(hours: v);
              },
            ),
            const SizedBox(height: 10),
            DropdownButtonFormField<String>(
              value: settingMatches,
              decoration: const InputDecoration(
                labelText: 'Maçlar',
                border: OutlineInputBorder(),
                isDense: true,
              ),
              items: const [
                DropdownMenuItem(value: 'today', child: Text('Bugün')),
                DropdownMenuItem(
                  value: 'today_tomorrow',
                  child: Text('Bugün + yarın'),
                ),
                DropdownMenuItem(value: '7d', child: Text('Sonraki 7 gün')),
                DropdownMenuItem(value: 'anytime', child: Text('Tümü')),
              ],
              onChanged: savingSettings ? null : (v) {
                if (v != null) _applyLiveFilter(matches: v);
              },
            ),
            const SizedBox(height: 10),
            DropdownButtonFormField<int>(
              value: settingBookies,
              decoration: const InputDecoration(
                labelText: 'Dropping bookies',
                border: OutlineInputBorder(),
                isDense: true,
              ),
              items: const [
                DropdownMenuItem(value: 30, child: Text('>%30')),
                DropdownMenuItem(value: 40, child: Text('>%40')),
                DropdownMenuItem(value: 50, child: Text('>%50')),
                DropdownMenuItem(value: 60, child: Text('>%60')),
                DropdownMenuItem(value: 70, child: Text('>%70')),
              ],
              onChanged: savingSettings ? null : (v) {
                if (v != null) _applyLiveFilter(bookies: v);
              },
            ),
            const SizedBox(height: 8),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              value: settingNotifications,
              title: const Text('Bildirimler'),
              subtitle: const Text(
                'Yeni veya de\u011fi\u015fen oran d\u00fc\u015f\u00fc\u015flerinde uyar',
              ),
              onChanged: savingSettings
                  ? null
                  : (v) async {
                      setState(() => settingNotifications = v);
                      await _saveSettings(showMessage: false);
                    },
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final items = live;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          _statusCard(),
          _liveFiltersCard(),
          if (loading)
            const Padding(
              padding: EdgeInsets.all(32),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (error != null)
            Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                children: [
                  Text(error!, textAlign: TextAlign.center),
                  const SizedBox(height: 12),
                  FilledButton.icon(
                    onPressed: _load,
                    icon: const Icon(Icons.refresh_rounded),
                    label: const Text('Tekrar dene'),
                  ),
                ],
              ),
            )
          else if (items.isEmpty)
            _empty('Aktif oran d\u00fc\u015f\u00fc\u015f\u00fc yok.')
          else
            ...items.map(_liveDroppingCard),
          const SizedBox(height: 16),
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
