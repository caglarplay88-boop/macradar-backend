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
    const names = ['Bülten', 'Takip', 'Düşüş'];
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
            label: 'Takip',
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
      var oddsTrackingStarted = 0;
      for (final row in rows.whereType<Map>()) {
        if (row['ok'] != true || row['queued'] != true) continue;
        final eventId = row['eventId']?.toString() ?? '';
        if (eventId.isEmpty) continue;
        try {
          await api.post(
            '/api/matches/' + Uri.encodeComponent(eventId) + '/tracking',
            {'enabled': true, 'minutes': 60},
          );
          oddsTrackingStarted++;
        } catch (_) {
          // The match remains followed; report the odds setup separately.
        }
      }

      if (mounted) {
        setState(() {
          selected.clear();
          saving = false;
        });

        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              ok == count && oddsTrackingStarted == ok
                  ? '$ok maç takibe alındı; oran takibi başladı.'
                  : '$ok / $count maç eklendi, $oddsTrackingStarted maçın oran takibi başladı.',
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
        : 'Oranlar · grafik · performans';

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
  bool _showOdds = true;
  String _oddsSort = 'bookmaker';
  bool _oddsLoading = true;
  bool _oddsRequestRunning = false;
  String _oddsError = '';
  List<Map<String, dynamic>> _oddsRows = const [];
  Timer? _oddsRefreshTimer;
  Map<String, dynamic> _matchData = <String, dynamic>{};
  bool _matchLoading = true;
  bool _trackingBusy = false;
  bool _intervalSaving = false;
  int? _systemRefreshMinutes;

  @override
  void initState() {
    super.initState();
    _loadMatchInfo();
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

  Future<void> _loadMatchInfo({bool silent = false}) async {
    if (!silent && mounted) setState(() => _matchLoading = true);
    try {
      final eventPath = Uri.encodeComponent(widget.eventId);
      final match = await api.get('/api/matches/' + eventPath);
      Map<String, dynamic> tracking = <String, dynamic>{};
      try {
        tracking = await api.get('/api/matches/' + eventPath + '/odds/1x2');
      } catch (_) {}
      if (!mounted) return;
      setState(() {
        _matchData = Map<String, dynamic>.from(match);
        if (tracking.isNotEmpty) {
          _matchData['tracking_enabled'] = tracking['tracking_enabled'] == true;
          final minutes = (tracking['refresh_minutes'] as num?)?.toInt();
          if (minutes != null) _matchData['refresh_minutes'] = minutes;
        }
        _matchLoading = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _matchLoading = false);
    }
  }

  int _effectiveRefreshMinutes() {
    return (_matchData['refresh_minutes'] as num?)?.toInt() ?? 60;
  }

  Future<void> _setMatchInterval(int minutes) async {
    if (_intervalSaving) return;
    setState(() => _intervalSaving = true);
    try {
      final enabled = _matchData['tracking_enabled'] == true;
      final result = await api.post(
        '/api/matches/' + Uri.encodeComponent(widget.eventId) + '/tracking',
        {'enabled': enabled, 'minutes': minutes},
      );
      if (!mounted) return;
      setState(() {
        _matchData['tracking_enabled'] = result['tracking_enabled'] == true;
        _matchData['refresh_minutes'] =
            (result['refresh_minutes'] as num?)?.toInt() ?? minutes;
        _intervalSaving = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _intervalSaving = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    }
  }

  Future<void> _toggleTracking() async {
    if (_trackingBusy) return;
    setState(() => _trackingBusy = true);
    try {
      final enabled = _matchData['tracking_enabled'] == true;
      final result = await api.post(
        '/api/matches/' + Uri.encodeComponent(widget.eventId) + '/tracking',
        {'enabled': !enabled, 'minutes': _effectiveRefreshMinutes()},
      );
      if (!mounted) return;
      setState(() {
        _matchData['tracking_enabled'] = result['tracking_enabled'] == true;
        _matchData['refresh_minutes'] =
            (result['refresh_minutes'] as num?)?.toInt() ?? _effectiveRefreshMinutes();
        _trackingBusy = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() => _trackingBusy = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(e.toString().replaceFirst('Exception: ', ''))),
      );
    }
  }

  String _matchDateTimeText() {
    final date = _matchData['match_date']?.toString().trim() ?? '';
    final time = _matchData['kickoff_time']?.toString().trim() ?? '';
    String dateText = date;
    final parsed = DateTime.tryParse(date);
    if (parsed != null) {
      dateText = parsed.day.toString().padLeft(2, '0') +
          '.' +
          parsed.month.toString().padLeft(2, '0') +
          '.' +
          parsed.year.toString();
    }
    if (dateText.isEmpty) return time;
    if (time.isEmpty) return dateText;
    return dateText + ' · ' + time;
  }

  String _lastControlText() {
    final raw = _matchData['latest_capture']?.toString() ?? '';
    final dt = DateTime.tryParse(raw)?.toLocal();
    if (dt == null) return '—';
    return dt.hour.toString().padLeft(2, '0') +
        ':' +
        dt.minute.toString().padLeft(2, '0');
  }

  List<String> _teamNames() {
    final title =
        (_matchData['display_name']?.toString().trim().isNotEmpty ?? false)
            ? _matchData['display_name'].toString().trim()
            : widget.title.trim();
    final parts = title.split(RegExp(r'\s+-\s+'));
    if (parts.length >= 2) {
      return [parts.first.trim(), parts.sublist(1).join(' - ').trim()];
    }
    return [title, ''];
  }

  Widget _matchInfoCard() {
    final scheme = Theme.of(context).colorScheme;
    final teams = _teamNames();
    final league = _matchData['league']?.toString().trim() ?? '';
    final dateTime = _matchDateTimeText();

    return Container(
      margin: const EdgeInsets.fromLTRB(12, 10, 12, 8),
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: scheme.outlineVariant.withOpacity(0.42),
        ),
      ),
      child: _matchLoading
          ? const SizedBox(
              height: 74,
              child: Center(child: CircularProgressIndicator()),
            )
          : Column(
              children: [
                Row(
                  children: [
                    Icon(
                      Icons.emoji_events_outlined,
                      size: 17,
                      color: scheme.primary,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        league.isEmpty ? 'Maç' : league,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w800,
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                    if (dateTime.isNotEmpty) ...[
                      Icon(
                        Icons.schedule_rounded,
                        size: 16,
                        color: scheme.onSurfaceVariant,
                      ),
                      const SizedBox(width: 5),
                      Text(
                        dateTime,
                        style: TextStyle(
                          fontSize: 10.5,
                          fontWeight: FontWeight.w700,
                          color: scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        teams[0],
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ),
                    Container(
                      margin: const EdgeInsets.symmetric(horizontal: 12),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 11,
                        vertical: 7,
                      ),
                      decoration: BoxDecoration(
                        color: scheme.primaryContainer,
                        borderRadius: BorderRadius.circular(18),
                      ),
                      child: Text(
                        'VS',
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w900,
                          color: scheme.onPrimaryContainer,
                        ),
                      ),
                    ),
                    Expanded(
                      child: Text(
                        teams[1],
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.right,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w900,
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
    );
  }

  Widget _intervalChoice(int minutes) {
    final scheme = Theme.of(context).colorScheme;
    final selected = _effectiveRefreshMinutes() == minutes;
    return Expanded(
      child: InkWell(
        onTap: _intervalSaving ? null : () => _setMatchInterval(minutes),
        borderRadius: BorderRadius.circular(12),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          height: 54,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: selected
                ? scheme.primaryContainer
                : scheme.surfaceContainerHighest.withOpacity(0.62),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: selected
                  ? scheme.primary.withOpacity(0.9)
                  : scheme.outlineVariant.withOpacity(0.45),
              width: selected ? 1.5 : 1,
            ),
          ),
          child: Text(
            '$minutes dk',
            style: TextStyle(
              fontSize: 11,
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

  Widget _trackingControls() {
    final scheme = Theme.of(context).colorScheme;
    final active = _matchData['tracking_enabled'] == true;

    return Column(
      children: [
        Container(
          margin: const EdgeInsets.fromLTRB(12, 0, 12, 10),
          padding: const EdgeInsets.fromLTRB(14, 12, 14, 14),
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
                    size: 19,
                    color: scheme.primary,
                  ),
                  const SizedBox(width: 8),
                  const Text(
                    'ORAN ÇEKİM ARALIĞI',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w900,
                      letterSpacing: 0.6,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                'Son kontrol: ${_lastControlText()}',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: scheme.onSurfaceVariant,
                ),
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  _intervalChoice(120),
                  const SizedBox(width: 7),
                  _intervalChoice(60),
                  const SizedBox(width: 7),
                  _intervalChoice(30),
                  const SizedBox(width: 7),
                  _intervalChoice(15),
                  const SizedBox(width: 7),
                  _intervalChoice(5),
                ],
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
          child: SizedBox(
            width: double.infinity,
            height: 54,
            child: FilledButton.icon(
              onPressed: _trackingBusy ? null : _toggleTracking,
              style: FilledButton.styleFrom(
                backgroundColor: active
                    ? const Color(0xFF4B171D)
                    : scheme.primaryContainer,
                foregroundColor: active
                    ? const Color(0xFFFFA7B0)
                    : scheme.onPrimaryContainer,
                side: BorderSide(
                  color: active
                      ? const Color(0xFFEF4444)
                      : scheme.primary.withOpacity(0.7),
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(14),
                ),
              ),
              icon: _trackingBusy
                  ? const SizedBox(
                      width: 17,
                      height: 17,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : Icon(
                      active
                          ? Icons.stop_circle_outlined
                          : Icons.play_circle_outline_rounded,
                    ),
              label: Text(
                active ? 'Takibi Durdur' : 'Takibi Başlat',
                style: const TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ),
          ),
        ),
      ],
    );
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

  Widget _bookmakerRow(
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
    VoidCallback onTap,
  ) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(bottom: 7),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(14),
          child: Container(
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
      ),
    );
  }

  void _openBookmaker(Map<String, dynamic> row) {
    final bookmakerName = row['bookmaker_name']?.toString().trim() ?? '';
    final bookmakerId = row['bookmaker_id']?.toString().trim() ?? '';
    if (bookmakerName.isEmpty && bookmakerId.isEmpty) return;

    Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => BookmakerOddsDetail(
          eventId: widget.eventId,
          matchTitle: widget.title,
          bookmakerName: bookmakerName.isEmpty ? 'Bookmaker' : bookmakerName,
          bookmakerId: bookmakerId,
        ),
      ),
    );
  }

  Widget _oddsSkeleton() {
    final scheme = Theme.of(context).colorScheme;
    final rows = List<Map<String, dynamic>>.from(_oddsRows);
    if (_oddsSort == 'bookmaker') {
      rows.sort((a, b) => (a['bookmaker_name']?.toString() ?? '')
          .toLowerCase()
          .compareTo((b['bookmaker_name']?.toString() ?? '').toLowerCase()));
    } else {
      double value(Map<String, dynamic> row) {
        final raw = row[_oddsSort];
        return raw is num
            ? raw.toDouble()
            : double.tryParse(raw?.toString() ?? '') ?? -1;
      }
      rows.sort((a, b) => value(b).compareTo(value(a)));
    }

    return RefreshIndicator(
      onRefresh: () async {
        await _loadMatchInfo(silent: true);
        await _loadOdds1x2();
      },
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.only(bottom: 22),
        children: [
          _matchInfoCard(),
          _trackingControls(),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 5, 14, 4),
            child: Row(
              children: [
                const Expanded(
                  child: Text('1X2 ORANLARI',
                      style: TextStyle(fontSize: 13,
                          fontWeight: FontWeight.w900, letterSpacing: 0.5)),
                ),
                Text(rows.length.toString() + ' bookmaker',
                    style: TextStyle(fontSize: 10,
                        color: scheme.onSurfaceVariant)),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: Text('Bir bookmaker’a dokunarak oran geçmişini ve grafiğini aç.',
                style: TextStyle(fontSize: 10,
                    color: scheme.onSurfaceVariant)),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
            child: DropdownButtonFormField<String>(
              value: _oddsSort,
              decoration: const InputDecoration(
                labelText: 'Sıralama',
                isDense: true,
                contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 9),
                border: OutlineInputBorder(),
              ),
              items: const [
                DropdownMenuItem(value: 'bookmaker', child: Text('Bookmaker A–Z')),
                DropdownMenuItem(value: 'home_odd', child: Text('1 oranı yüksekten')),
                DropdownMenuItem(value: 'draw_odd', child: Text('X oranı yüksekten')),
                DropdownMenuItem(value: 'away_odd', child: Text('2 oranı yüksekten')),
              ],
              onChanged: (value) {
                if (value != null) setState(() => _oddsSort = value);
              },
            ),
          ),
          Container(
            margin: const EdgeInsets.fromLTRB(12, 0, 12, 5),
            padding: const EdgeInsets.symmetric(vertical: 2),
            decoration: BoxDecoration(
              color: scheme.surfaceContainerHighest.withOpacity(0.54),
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: scheme.outlineVariant.withOpacity(0.35)),
            ),
            child: Row(
              children: [
                Expanded(
                  flex: 16,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    child: Text('BOOKMAKER',
                        style: TextStyle(fontSize: 10,
                            fontWeight: FontWeight.w900,
                            color: scheme.onSurfaceVariant)),
                  ),
                ),
                Expanded(
                  flex: 21,
                  child: Row(children: [
                    _oddValue('1', header: true),
                    _oddValue('X', header: true),
                    _oddValue('2', header: true),
                  ]),
                ),
              ],
            ),
          ),
          if (_oddsLoading)
            const Padding(
              padding: EdgeInsets.all(30),
              child: Center(child: CircularProgressIndicator()),
            )
          else if (_oddsError.isNotEmpty)
            Padding(
              padding: const EdgeInsets.all(20),
              child: Text(_oddsError, textAlign: TextAlign.center,
                  style: TextStyle(color: scheme.error)),
            )
          else if (rows.isEmpty)
            Padding(
              padding: const EdgeInsets.all(30),
              child: Text('1X2 oranı henüz bulunamadı.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: scheme.onSurfaceVariant)),
            )
          else
            for (final row in rows)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 12),
                child: _bookmakerRow(
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
                  () => _openBookmaker(row),
                ),
              ),
        ],
      ),
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


class BookmakerOddsDetail extends StatefulWidget {
  final String eventId;
  final String matchTitle;
  final String bookmakerName;
  final String bookmakerId;

  const BookmakerOddsDetail({
    super.key,
    required this.eventId,
    required this.matchTitle,
    required this.bookmakerName,
    required this.bookmakerId,
  });

  @override
  State<BookmakerOddsDetail> createState() => _BookmakerOddsDetailState();
}

class _BookmakerOddsDetailState extends State<BookmakerOddsDetail> {
  bool _loading = true;
  String _error = '';
  int _tab = 0;
  List<Map<String, dynamic>> _history = const [];
  List<Map<String, dynamic>> _openingRows = const [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final eventPath = Uri.encodeComponent(widget.eventId);
      final bookmakerQuery = Uri.encodeQueryComponent(widget.bookmakerName);
      final rows = <Map<String, dynamic>>[];
      var page = 1;
      while (true) {
        final payload = await api.get(
          '/api/matches/' + eventPath +
              '/odds/1x2/history?bookmaker=' + bookmakerQuery +
              '&page=' + page.toString(),
        );
        final raw = payload['rows'];
        if (raw is List) {
          rows.addAll(raw.whereType<Map>().map((r) => Map<String, dynamic>.from(r)));
        }
        if (payload['has_next'] != true || page >= 20) break;
        page++;
      }
      final live = await api.get('/api/matches/' + eventPath + '/odds/1x2');
      final openingRows = <Map<String, dynamic>>[];
      final opening = live['opening'];
      final rawOpening = opening is Map ? opening['rows'] : null;
      final earliestHistoryTime = rows
          .map((row) => DateTime.tryParse(row['captured_at']?.toString() ?? ''))
          .whereType<DateTime>()
          .fold<DateTime?>(null, (earliest, time) =>
              earliest == null || time.isBefore(earliest) ? time : earliest);
      if (rawOpening is List) {
        for (final raw in rawOpening.whereType<Map>()) {
          final row = Map<String, dynamic>.from(raw);
          if (_sameBookmaker(row)) {
            row['_opening'] = true;
            row['captured_at'] ??= opening is Map ? opening['captured_at'] : null;
            row['captured_at'] ??= earliestHistoryTime?.toIso8601String();
            openingRows.add(row);
            break;
          }
        }
      }
      if (openingRows.isEmpty) {
        final openingHistory = rows
            .where((row) =>
                _sameBookmaker(row) &&
                row['capture_type']?.toString() == 'opening')
            .toList();
        openingHistory.sort((a, b) {
          final aTime = DateTime.tryParse(a['captured_at']?.toString() ?? '');
          final bTime = DateTime.tryParse(b['captured_at']?.toString() ?? '');
          if (aTime == null && bTime == null) return 0;
          if (aTime == null) return 1;
          if (bTime == null) return -1;
          return aTime.compareTo(bTime);
        });
        if (openingHistory.isNotEmpty) {
          openingRows.add({...openingHistory.first, '_opening': true});
        }
      }
      if (!mounted) return;
      setState(() {
        _history = rows
            .where((row) =>
                _sameBookmaker(row) &&
                row['capture_type']?.toString() != 'opening')
            .toList()
          ..sort((a, b) {
            final aTime = DateTime.tryParse(a['captured_at']?.toString() ?? '');
            final bTime = DateTime.tryParse(b['captured_at']?.toString() ?? '');
            if (aTime == null && bTime == null) return 0;
            if (aTime == null) return 1;
            if (bTime == null) return -1;
            return bTime.compareTo(aTime);
          });
        _openingRows = openingRows;
        _loading = false;
        _error = '';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString().replaceFirst('Exception: ', '');
      });
    }
  }

  String _bookmakerKey(String value) =>
      value.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');

  bool _sameBookmaker(Map<String, dynamic> row) {
    final id = row['bookmaker_id']?.toString().trim() ?? '';
    final name = row['bookmaker_name']?.toString().trim().toLowerCase() ?? '';
    if (widget.bookmakerId.isNotEmpty &&
        id.isNotEmpty &&
        widget.bookmakerId == id) {
      return true;
    }
    return name.isNotEmpty &&
        _bookmakerKey(name) == _bookmakerKey(widget.bookmakerName);
  }

  String _odd(dynamic value) {
    final number = value is num
        ? value.toDouble()
        : double.tryParse(value?.toString() ?? '');
    return number == null ? '\u2014' : number.toStringAsFixed(2);
  }

  String _time(Map<String, dynamic> row) {
    final raw = row['captured_at'] ??
        row['capture_time'] ??
        row['created_at'] ??
        row['updated_at'];
    final dt = DateTime.tryParse(raw?.toString() ?? '')?.toLocal();
    if (dt == null) return raw?.toString() ?? '\u2014';
    return dt.day.toString().padLeft(2, '0') +
        '/' +
        dt.month.toString().padLeft(2, '0') +
        ' ' +
        dt.hour.toString().padLeft(2, '0') +
        ':' +
        dt.minute.toString().padLeft(2, '0');
  }

  Widget _tabButton(String label, int index) {
    final scheme = Theme.of(context).colorScheme;
    final selected = _tab == index;
    return Expanded(
      child: InkWell(
        onTap: () => setState(() => _tab = index),
        borderRadius: BorderRadius.circular(10),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 11),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: selected
                ? scheme.primaryContainer
                : scheme.surfaceContainerHighest.withOpacity(0.72),
            borderRadius: BorderRadius.circular(10),
          ),
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

  Widget _oddsList() {
    final scheme = Theme.of(context).colorScheme;
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error.isNotEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Text(
            _error,
            textAlign: TextAlign.center,
            style: TextStyle(fontWeight: FontWeight.w700, color: scheme.error),
          ),
        ),
      );
    }
    final displayRows = <Map<String, dynamic>>[..._history, ..._openingRows];
    if (displayRows.isEmpty) {
      return const Center(
        child: Text('Bu bookmaker i\u00e7in ge\u00e7mi\u015f oran bulunamad\u0131.'),
      );
    }

    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(12, 8, 12, 16),
      itemCount: displayRows.length,
      separatorBuilder: (_, __) => const SizedBox(height: 7),
      itemBuilder: (_, index) {
        final row = displayRows[index];
        final isOpening = row['_opening'] == true;
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
          decoration: BoxDecoration(
            color: isOpening
                ? const Color(0xFF263B60)
                : scheme.surfaceContainerLow,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: isOpening
                  ? const Color(0xFF7FA9F8)
                  : scheme.outlineVariant.withOpacity(0.34),
            ),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  isOpening ? 'AÇILIŞ ORANI\n${_time(row)}' : _time(row),
                  maxLines: isOpening ? 2 : 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    color: isOpening
                        ? const Color(0xFFB9D1FF)
                        : scheme.onSurfaceVariant,
                  ),
                ),
              ),
              SizedBox(
                width: 58,
                child: _historyOdd('1', _odd(row['home_odd'])),
              ),
              SizedBox(
                width: 58,
                child: _historyOdd('X', _odd(row['draw_odd'])),
              ),
              SizedBox(
                width: 58,
                child: _historyOdd('2', _odd(row['away_odd'])),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _historyOdd(String label, String value) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label, style: const TextStyle(fontSize: 9, fontWeight: FontWeight.w800)),
        const SizedBox(height: 2),
        Text(value, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w900)),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              widget.bookmakerName,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontWeight: FontWeight.w900),
            ),
            Text(
              widget.matchTitle,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w600,
                color: scheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 8),
            child: Row(
              children: [
                _tabButton('Oran geçmişi', 0),
                const SizedBox(width: 8),
                _tabButton('Grafik', 1),
              ],
            ),
          ),
          Expanded(
            child: _tab == 0
                ? _oddsList()
                : BookmakerOddsChart(
                    history: [..._openingRows, ..._history],
                    bookmakerName: widget.bookmakerName,
                  ),
          ),
        ],
      ),
    );
  }
}


class _OddsGraphSample {
  final DateTime time;
  final double? home;
  final double? draw;
  final double? away;
  final bool opening;

  const _OddsGraphSample({
    required this.time,
    required this.home,
    required this.draw,
    required this.away,
    this.opening = false,
  });
}

class BookmakerOddsChart extends StatefulWidget {
  final List<Map<String, dynamic>> history;
  final String bookmakerName;
  final bool fullScreen;
  final int initialRangeMinutes;
  final bool initialHome;
  final bool initialDraw;
  final bool initialAway;

  const BookmakerOddsChart({
    super.key,
    required this.history,
    required this.bookmakerName,
    this.fullScreen = false,
    this.initialRangeMinutes = 0,
    this.initialHome = true,
    this.initialDraw = true,
    this.initialAway = true,
  });

  @override
  State<BookmakerOddsChart> createState() => _BookmakerOddsChartState();
}

class _BookmakerOddsChartState extends State<BookmakerOddsChart> {
  late int _rangeMinutes;
  late bool _showHome;
  late bool _showDraw;
  late bool _showAway;
  int? _selectedIndex;

  static const _homeColor = Color(0xFF2563EB);
  static const _drawColor = Color(0xFFEC4899);
  static const _awayColor = Color(0xFF8B5CF6);

  @override
  void initState() {
    super.initState();
    _rangeMinutes = widget.initialRangeMinutes;
    _showHome = widget.initialHome;
    _showDraw = widget.initialDraw;
    _showAway = widget.initialAway;
  }

  double? _number(dynamic raw) {
    if (raw is num) return raw.toDouble();
    return double.tryParse(raw?.toString() ?? '');
  }

  DateTime? _date(Map<String, dynamic> row) {
    final raw = row['captured_at'] ??
        row['capture_time'] ??
        row['created_at'] ??
        row['updated_at'];
    return DateTime.tryParse(raw?.toString() ?? '')?.toLocal();
  }

  List<_OddsGraphSample> _allSamples() {
    final out = <_OddsGraphSample>[];
    for (final row in widget.history) {
      final time = _date(row);
      if (time == null) continue;
      final item = _OddsGraphSample(
        time: time,
        home: _number(row['home_odd']),
        draw: _number(row['draw_odd']),
        away: _number(row['away_odd']),
        opening: row['_opening'] == true,
      );
      if (item.home != null || item.draw != null || item.away != null) {
        out.add(item);
      }
    }
    out.sort((a, b) {
      final byTime = a.time.compareTo(b.time);
      if (byTime != 0) return byTime;
      if (a.opening == b.opening) return 0;
      return a.opening ? -1 : 1;
    });
    return out;
  }

  List<_OddsGraphSample> _visibleSamples() {
    final all = _allSamples();
    if (all.isEmpty) return const [];
    if (_rangeMinutes <= 0) return all;
    final start = all.last.time.subtract(Duration(minutes: _rangeMinutes));
    final visible = all.where((e) => !e.time.isBefore(start)).toList();
    return visible.isEmpty ? [all.last] : visible;
  }

  String _stamp(DateTime t) {
    return t.day.toString().padLeft(2, '0') +
        '/' +
        t.month.toString().padLeft(2, '0') +
        ' ' +
        t.hour.toString().padLeft(2, '0') +
        ':' +
        t.minute.toString().padLeft(2, '0');
  }

  Widget _rangeChip(String label, int minutes) {
    final selected = _rangeMinutes == minutes;
    return Padding(
      padding: const EdgeInsets.only(right: 6),
      child: ChoiceChip(
        label: Text(
          label,
          style: const TextStyle(fontSize: 10, fontWeight: FontWeight.w800),
        ),
        selected: selected,
        visualDensity: VisualDensity.compact,
        onSelected: (_) {
          setState(() {
            _rangeMinutes = minutes;
            _selectedIndex = null;
          });
        },
      ),
    );
  }

  Widget _seriesChip(
    String label,
    bool selected,
    Color color,
    VoidCallback onTap,
  ) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(right: 7),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(20),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
          decoration: BoxDecoration(
            color: selected ? color.withOpacity(0.14) : scheme.surfaceContainerLow,
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: selected ? color.withOpacity(0.75) : scheme.outlineVariant,
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(
                  color: selected ? color : scheme.onSurfaceVariant.withOpacity(0.35),
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 6),
              Text(
                label,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w900,
                  color: selected ? color : scheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _badge(String label, double? value, Color color) {
    return Container(
      margin: const EdgeInsets.only(left: 7),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: color.withOpacity(0.12),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        label + ' ' + (value?.toStringAsFixed(2) ?? '\u2014'),
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.w900,
          color: color,
        ),
      ),
    );
  }

  Widget _selectedValues(List<_OddsGraphSample> samples) {
    if (samples.isEmpty) return const SizedBox.shrink();
    final index = (_selectedIndex ?? samples.length - 1)
        .clamp(0, samples.length - 1)
        .toInt();
    final item = samples[index];
    final scheme = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.fromLTRB(12, 8, 12, 6),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerLow,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: scheme.outlineVariant.withOpacity(0.45)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              (item.opening ? 'Açılış · ' : '') + _stamp(item.time),
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w800,
                color: scheme.onSurfaceVariant,
              ),
            ),
          ),
          if (_showHome) _badge('1', item.home, _homeColor),
          if (_showDraw) _badge('X', item.draw, _drawColor),
          if (_showAway) _badge('2', item.away, _awayColor),
        ],
      ),
    );
  }

  void _updateSelection(double dx, double width, int count) {
    if (count <= 0 || width <= 54) return;
    const left = 42.0;
    const right = 12.0;
    final usable = math.max(1.0, width - left - right);
    final ratio = ((dx - left) / usable).clamp(0.0, 1.0);
    final index = count == 1 ? 0 : (ratio * (count - 1)).round();
    if (_selectedIndex != index) {
      setState(() => _selectedIndex = index);
    }
  }

  Future<void> _openFullScreen() async {
    await Navigator.push(
      context,
      MaterialPageRoute(
        builder: (_) => _BookmakerGraphFullscreenPage(
          history: widget.history,
          bookmakerName: widget.bookmakerName,
          rangeMinutes: _rangeMinutes,
          showHome: _showHome,
          showDraw: _showDraw,
          showAway: _showAway,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final samples = _visibleSamples();

    return Container(
      color: scheme.surface,
      child: Column(
        children: [
          Padding(
            padding: EdgeInsets.fromLTRB(
              widget.fullScreen ? 18 : 12,
              widget.fullScreen ? 8 : 4,
              widget.fullScreen ? 18 : 12,
              4,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    widget.bookmakerName + '  \u2022  1X2',
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w900,
                    ),
                  ),
                ),
                if (!widget.fullScreen)
                  IconButton(
                    tooltip: 'Tam ekran',
                    onPressed: _openFullScreen,
                    icon: const Icon(Icons.open_in_full_rounded),
                  ),
              ],
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: EdgeInsets.symmetric(
              horizontal: widget.fullScreen ? 18 : 12,
            ),
            child: Row(
              children: [
                _rangeChip('Tümü', 0),
                _rangeChip('24 saat', 1440),
                _rangeChip('12 saat', 720),
                _rangeChip('6 saat', 360),
                _rangeChip('120 dk', 120),
              ],
            ),
          ),
          const SizedBox(height: 5),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            padding: EdgeInsets.symmetric(
              horizontal: widget.fullScreen ? 18 : 12,
            ),
            child: Row(
              children: [
                _seriesChip(
                  '1',
                  _showHome,
                  _homeColor,
                  () => setState(() => _showHome = !_showHome),
                ),
                _seriesChip(
                  'X',
                  _showDraw,
                  _drawColor,
                  () => setState(() => _showDraw = !_showDraw),
                ),
                _seriesChip(
                  '2',
                  _showAway,
                  _awayColor,
                  () => setState(() => _showAway = !_showAway),
                ),
              ],
            ),
          ),
          _selectedValues(samples),
          Expanded(
            child: samples.isEmpty
                ? Center(
                    child: Text(
                      'Bu zaman aral\u0131\u011f\u0131nda grafik verisi yok.',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                  )
                : LayoutBuilder(
                    builder: (context, constraints) {
                      return GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onTapDown: (d) => _updateSelection(
                          d.localPosition.dx,
                          constraints.maxWidth,
                          samples.length,
                        ),
                        onHorizontalDragStart: (d) => _updateSelection(
                          d.localPosition.dx,
                          constraints.maxWidth,
                          samples.length,
                        ),
                        onHorizontalDragUpdate: (d) => _updateSelection(
                          d.localPosition.dx,
                          constraints.maxWidth,
                          samples.length,
                        ),
                        child: CustomPaint(
                          size: Size.infinite,
                          painter: _OddsAreaChartPainter(
                            samples: samples,
                            showHome: _showHome,
                            showDraw: _showDraw,
                            showAway: _showAway,
                            homeColor: _homeColor,
                            drawColor: _drawColor,
                            awayColor: _awayColor,
                            selectedIndex: _selectedIndex,
                            surfaceColor: scheme.surfaceContainerLow,
                            gridColor: scheme.outlineVariant.withOpacity(0.45),
                            textColor: scheme.onSurfaceVariant,
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}

class _BookmakerGraphFullscreenPage extends StatefulWidget {
  final List<Map<String, dynamic>> history;
  final String bookmakerName;
  final int rangeMinutes;
  final bool showHome;
  final bool showDraw;
  final bool showAway;

  const _BookmakerGraphFullscreenPage({
    required this.history,
    required this.bookmakerName,
    required this.rangeMinutes,
    required this.showHome,
    required this.showDraw,
    required this.showAway,
  });

  @override
  State<_BookmakerGraphFullscreenPage> createState() =>
      _BookmakerGraphFullscreenPageState();
}

class _BookmakerGraphFullscreenPageState
    extends State<_BookmakerGraphFullscreenPage> {
  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations(
      const [DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight],
    );
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  }

  @override
  void dispose() {
    SystemChrome.setPreferredOrientations(
      const [DeviceOrientation.portraitUp],
    );
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Stack(
          children: [
            BookmakerOddsChart(
              history: widget.history,
              bookmakerName: widget.bookmakerName,
              fullScreen: true,
              initialRangeMinutes: widget.rangeMinutes,
              initialHome: widget.showHome,
              initialDraw: widget.showDraw,
              initialAway: widget.showAway,
            ),
            Positioned(
              top: 4,
              right: 6,
              child: IconButton.filledTonal(
                tooltip: 'Kapat',
                onPressed: () => Navigator.pop(context),
                icon: const Icon(Icons.close_fullscreen_rounded),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _OddsAreaChartPainter extends CustomPainter {
  final List<_OddsGraphSample> samples;
  final bool showHome;
  final bool showDraw;
  final bool showAway;
  final Color homeColor;
  final Color drawColor;
  final Color awayColor;
  final int? selectedIndex;
  final Color surfaceColor;
  final Color gridColor;
  final Color textColor;

  const _OddsAreaChartPainter({
    required this.samples,
    required this.showHome,
    required this.showDraw,
    required this.showAway,
    required this.homeColor,
    required this.drawColor,
    required this.awayColor,
    required this.selectedIndex,
    required this.surfaceColor,
    required this.gridColor,
    required this.textColor,
  });

  double? _value(_OddsGraphSample s, int series) {
    if (series == 0) return s.home;
    if (series == 1) return s.draw;
    return s.away;
  }

  String _clock(DateTime t) {
    return t.hour.toString().padLeft(2, '0') +
        ':' +
        t.minute.toString().padLeft(2, '0');
  }

  void _text(
    Canvas canvas,
    String value,
    Offset offset, {
    TextAlign align = TextAlign.left,
  }) {
    final tp = TextPainter(
      text: TextSpan(
        text: value,
        style: TextStyle(
          fontSize: 9,
          fontWeight: FontWeight.w700,
          color: textColor,
        ),
      ),
      textDirection: TextDirection.ltr,
      textAlign: align,
    )..layout();
    var dx = offset.dx;
    if (align == TextAlign.center) dx -= tp.width / 2;
    if (align == TextAlign.right) dx -= tp.width;
    tp.paint(canvas, Offset(dx, offset.dy));
  }

  List<Offset> _points(
    Rect plot,
    int series,
    double minValue,
    double maxValue,
  ) {
    final points = <Offset>[];
    final span = math.max(0.001, maxValue - minValue);
    for (var i = 0; i < samples.length; i++) {
      final value = _value(samples[i], series);
      if (value == null) continue;
      final x = samples.length == 1
          ? plot.center.dx
          : plot.left + plot.width * i / (samples.length - 1);
      final y = plot.bottom - ((value - minValue) / span) * plot.height;
      points.add(Offset(x, y));
    }
    return points;
  }

  Path _smoothPath(List<Offset> points) {
    final path = Path();
    if (points.isEmpty) return path;
    path.moveTo(points.first.dx, points.first.dy);
    for (var i = 1; i < points.length; i++) {
      final a = points[i - 1];
      final b = points[i];
      final mid = (a.dx + b.dx) / 2;
      path.cubicTo(mid, a.dy, mid, b.dy, b.dx, b.dy);
    }
    return path;
  }

  void _drawSeries(
    Canvas canvas,
    Rect plot,
    int series,
    Color color,
    double minValue,
    double maxValue,
  ) {
    final points = _points(plot, series, minValue, maxValue);
    if (points.isEmpty) return;

    final path = _smoothPath(points);
    if (points.length > 1) {
      final fill = Path.from(path)
        ..lineTo(points.last.dx, plot.bottom)
        ..lineTo(points.first.dx, plot.bottom)
        ..close();
      canvas.drawPath(
        fill,
        Paint()
          ..shader = LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [
              color.withOpacity(0.22),
              color.withOpacity(0.025),
            ],
          ).createShader(plot),
      );
    }

    canvas.drawPath(
      path,
      Paint()
        ..color = color
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2.35
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );

    for (final p in points) {
      canvas.drawCircle(p, 3.0, Paint()..color = color);
      canvas.drawCircle(
        p,
        3.0,
        Paint()
          ..color = surfaceColor
          ..style = PaintingStyle.stroke
          ..strokeWidth = 1.5,
      );
    }
  }

  @override
  void paint(Canvas canvas, Size size) {
    const left = 42.0;
    const right = 12.0;
    const top = 12.0;
    const bottom = 28.0;
    final plot = Rect.fromLTRB(
      left,
      top,
      math.max(left + 1, size.width - right),
      math.max(top + 1, size.height - bottom),
    );

    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(
          8,
          2,
          math.max(1, size.width - 16),
          math.max(1, size.height - 8),
        ),
        const Radius.circular(16),
      ),
      Paint()..color = surfaceColor,
    );

    final values = <double>[];
    for (final e in samples) {
      if (showHome && e.home != null) values.add(e.home!);
      if (showDraw && e.draw != null) values.add(e.draw!);
      if (showAway && e.away != null) values.add(e.away!);
    }

    if (values.isEmpty) {
      _text(
        canvas,
        '1 / X / 2 se\u00e7imi yap\u0131n',
        Offset(plot.center.dx, plot.center.dy),
        align: TextAlign.center,
      );
      return;
    }

    var minValue = values.reduce(math.min);
    var maxValue = values.reduce(math.max);
    if ((maxValue - minValue).abs() < 0.01) {
      minValue -= 0.05;
      maxValue += 0.05;
    } else {
      final pad = (maxValue - minValue) * 0.12;
      minValue -= pad;
      maxValue += pad;
    }

    final grid = Paint()
      ..color = gridColor
      ..strokeWidth = 0.8;

    for (var i = 0; i <= 4; i++) {
      final y = plot.top + plot.height * i / 4;
      canvas.drawLine(Offset(plot.left, y), Offset(plot.right, y), grid);
      final value = maxValue - (maxValue - minValue) * i / 4;
      _text(
        canvas,
        value.toStringAsFixed(2),
        Offset(plot.left - 5, y - 5),
        align: TextAlign.right,
      );
    }

    for (var i = 0; i <= 4; i++) {
      final x = plot.left + plot.width * i / 4;
      canvas.drawLine(Offset(x, plot.top), Offset(x, plot.bottom), grid);
    }

    if (showHome) _drawSeries(canvas, plot, 0, homeColor, minValue, maxValue);
    if (showDraw) _drawSeries(canvas, plot, 1, drawColor, minValue, maxValue);
    if (showAway) _drawSeries(canvas, plot, 2, awayColor, minValue, maxValue);

    final openingIndex = samples.indexWhere((sample) => sample.opening);
    if (openingIndex >= 0) {
      final x = samples.length == 1
          ? plot.center.dx
          : plot.left + plot.width * openingIndex / (samples.length - 1);
      canvas.drawLine(
        Offset(x, plot.top),
        Offset(x, plot.bottom),
        Paint()
          ..color = const Color(0xFF7FA9F8).withOpacity(0.55)
          ..strokeWidth = 1.1,
      );
      _text(canvas, 'Açılış', Offset(x + 4, plot.top + 2));
    }

    if (samples.isNotEmpty) {
      _text(canvas, _clock(samples.first.time), Offset(plot.left, plot.bottom + 7));
      _text(
        canvas,
        _clock(samples[samples.length ~/ 2].time),
        Offset(plot.center.dx, plot.bottom + 7),
        align: TextAlign.center,
      );
      _text(
        canvas,
        _clock(samples.last.time),
        Offset(plot.right, plot.bottom + 7),
        align: TextAlign.right,
      );
    }

    if (selectedIndex != null && samples.isNotEmpty) {
      final index = selectedIndex!.clamp(0, samples.length - 1).toInt();
      final x = samples.length == 1
          ? plot.center.dx
          : plot.left + plot.width * index / (samples.length - 1);

      canvas.drawLine(
        Offset(x, plot.top),
        Offset(x, plot.bottom),
        Paint()
          ..color = textColor.withOpacity(0.8)
          ..strokeWidth = 1.2,
      );

      final span = math.max(0.001, maxValue - minValue);
      void selected(double? value, Color color) {
        if (value == null) return;
        final y = plot.bottom - ((value - minValue) / span) * plot.height;
        canvas.drawCircle(Offset(x, y), 6, Paint()..color = surfaceColor);
        canvas.drawCircle(Offset(x, y), 4, Paint()..color = color);
      }

      if (showHome) selected(samples[index].home, homeColor);
      if (showDraw) selected(samples[index].draw, drawColor);
      if (showAway) selected(samples[index].away, awayColor);
    }
  }

  @override
  bool shouldRepaint(covariant _OddsAreaChartPainter old) {
    return old.samples != samples ||
        old.showHome != showHome ||
        old.showDraw != showDraw ||
        old.showAway != showAway ||
        old.selectedIndex != selectedIndex ||
        old.surfaceColor != surfaceColor ||
        old.gridColor != gridColor ||
        old.textColor != textColor;
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
