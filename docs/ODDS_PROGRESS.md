# BetExplorer oran bölümü ilerlemesi

## Aktif aşama

2026-10-12 — Aşama 1: sözleşmeyi kalıcı kaydetme ve güncel kaynak erişimini
doğrulama. Aşama 3 gerçek kaynak doğrulaması tamamlanmadı; parser yazılmadı.

Güncelleme: Güncel kaynak ve kayıtlı gerçek yanıtlar alındı. Aktif işlem:
mevcut yeni `oddsContract` mimarisinin denetimi, büyük maç dışa aktarımının
HTTP sürecinden ayrılması ve kullanıcıya indirme verisinin saatini gösterme.
Eski parsera yeni yama eklenmiyor; kaynakta kanıtlanmayan alanlar açılmıyor.

## Bu oturumun güncel doğrulaması

- Güncel kaynak dalı `codex/macradar-current-source-20261012`,
  kaynak snapshot HEAD `ffb327e`, gerçek kanıt ekleme HEAD `ba8cdd7`.
- Sunucuda görev kayıtları 2026-10-12 tarihinde `9d0f782` kaydıyla,
  diğer 232 değişiklik commit'e alınmadan kalıcı kaydedildi.
- 95 kaynak/audit dosyası ve mevcut şema `test/fixtures/betexplorer-20261011`
  ve `docs/odds-contract` içine alındı. Tarihî audit raporları güncel test
  başarısı sayılmıyor.
- Kayıtlı gerçek dört piyasa cevabı geçici bir klasöre kopyalandı.
  `currentParser.test.cjs` önce çalıştırıldı; diğer testlerin her biri gerçek
  fixture klasörü argümanıyla ayrı Node sürecinde çalıştırıldı.
- Bu oturumda 47 test dosyasının 45'i geçti. `exportJobs.test.cjs`
  taşınmamış eski ZIP'e; `scheduledIdentity.test.cjs` sunucuya özgü mutlak
  response klasörüne bağlı olduğu için çalışamadı. Bunlar geçti sayılmadı.
- Kayıtlı yanıtlar: Montpellier–Grenoble / `0p1XkgIt`, 1X2 30, OU 153,
  ASIAN 322 ve KG 14 ham fiyat hücresi. Kaynak arşiv örnekleri tek satırlı.
  Gerçek ara geçmiş gözlenmiş sayılmıyor.
- Kaynak ödeme dönemi, Asian ev işareti, inactive durum anlamı, sportsbook
  sınıflandırması ve exchange back/lay hâlen kanıtlanmış değil.
- `diskExportZip.js` var fakat mevcut paket oluşturma yolu kullanmıyor.
  JSON ve ZIP üretimi HTTP sürecinde yapılıyor; yeni export iş sınırı
  içinde ayrı süreç ve diskten paketleme uygulanacak.
- İndirme ekranına son başarılı tarama saati ve yenileme sonucu aktarılacak.
  Telefon kabulü ve harici okuyucu entegrasyonu henüz yapılmadı.

## Yeni dışa aktarım revizyonu

- Bu oturumda 48 backend test dosyası geçti. Gerçek yanıt tekrarları ve
  birim senaryoları ayrı nitelikte; telefon kabulü yerine sayılmıyor.
- Yeni süreç testi, paket işi CPU kullanırken ana event loop'un çalıştığını,
  timeout/hata ve geçici dosya temizliğini doğruluyor.
- scheduledIdentity testi özgün yanıt SHA256'sı denetlenen taşınabilir
  gerçek planlanmış maç fixture'ına bağlandı.
- Paket oluşturma ortak toplayıcının turu bitince ayrı Node sürecinde
  yapılıyor. Ham state IPC üzerinden taşınmıyor; paket okuyucusu collection
  state'ini veya yarım tur kurtarma kayıtlarını değiştirmiyor.
- match-data.json diskten akışla yazılıyor; manifest dosyanın byte/hash
  değerlerini kullanıyor. ZIP diskten hazırlanıyor. Boyut sınırı aşılırsa
  kayıtlar kesilmeden hata veriliyor.
- Hazırlama/sorgulama ve doğrudan export aynı üretim builder'ını kullanıyor.
- Paket yanıtı son başarılı tarama zamanı ve yenileme sonucunu mobil indirme
  ekranına taşıyor. Başarısız yenileme kayıtlı veri olarak gösteriliyor.
- Mobil sürüm 1.0.10+110. Yeni mobil widget testi yazıldı; bu oturumun Flutter
  test/analyze ve gerçek APK derlemesi henüz çalıştırılmadı.
- Kaynakta kanıtlanmayan dönem, Asian ev işareti, durum ve fiyat türü
  null/UNKNOWN kalıyor. Eksik arşiv yılı veya ara geçmiş üretilmiyor.
- Sonraki işlem: sunucuda Node/Flutter doğrulaması; temel dosya hash'leri
  eşleşiyorsa yedekleme ve uygulama; gerçek HTTP/kaynak turu ve APK teslimi.

### Sunucu ön doğrulaması

Kullanıcının gerçek Termux çıktısı: revizyon `15940cd`, 48 backend test
dosyası ve 26 Flutter testi geçti. Flutter analyze 254 uyarı/bilgi, sıfır
hata. Çalışan uygulama henüz bu aşamada değiştirilmedi.

Sonrasında paket grafik anahtarı için hedefli regresyon ve gerçek paket
fonksiyonu testi tekrar geçti: doğrulanmamış Asian ev işareti null korunurken
aynı kaynak çizgisinin farklı tarama kayıtları aynı grafikte kalıyor. Farklı
çizgi ve bağlamlar ayrılıyor. Her taramada ayrı grafik üretip paket boyutunu
gereksiz büyütme giderildi; ham kayıtlar kesilmiyor.

Gerçek HTTP protokol denetimi `scripts/validate-odds-http.py` eklendi.
Bu bir test istemcisidir; kartı elle oluşturmaz, mevcut APK düğmesinin
hazırlama/sorgulama/indirme rotasını kullanır. Telefon testi yerine sayılmaz.

MacRadar Analiz get_methods/list_matches erişimi bu oturumda çalıştı:
v0.2.0, odds-only; yüklenmiş maç listesi boş. Dosya yükleme aracı bu bağlantıda
sunulmuyor. Yeni paket gerçek okuyucuda henüz sınanmadı; entegrasyon NOT_RUN.

## Tamamlanan işler ve kanıtlar

- Kullanıcının tam görev sözleşmesi kod değişikliğinden önce
  `docs/BETEXPLORER_ODDS_DATA_CONTRACT.md` içine kaydedildi.
- Bağlı GitHub hesabından `caglarplay88-boop/macradar-backend` bulundu ve
  klonlandı. İncelenen ana dal HEAD:
  `ecd40edd525f6693f6164919179052e9046e61f5`, kayıt tarihi
  `2026-09-30T19:47:08Z`.
- Ayrı çalışma dalı: `codex/betexplorer-odds-contract-20261012`.
- Bu HEAD'de mevcut AGENTS.md bulunmadığı dosya envanterinde doğrulandı;
  yeni oturumlarda iki görev dosyasını okumayı zorunlu kılan AGENTS.md eklendi.
- Bu sürümde `src/odds.js`, `src/odds-v2.js`, `src/odds1x2.js`,
  `src/puller.js`, `src/scraper-service.js` ve `mobile/lib/main.dart`
  bulunuyor. Mevcut kazıyıcı erişimi curl/Tor ve uzaktaki kazıyıcı
  seçeneklerini içeriyor. Alan anlamları henüz doğrulanmış sayılmıyor.
- `rg` ile `src/` ve `mobile/lib/main.dart` üzerinde match-data,
  download, export, card ve ilgili aramalar yapıldı: mevcut görevde tarif
  edilen maç kartı dışa aktarma akışı bu eski sürümde bulunamadı.
- Depoda yalnızca `mobile/lib/main.dart` var; Android proje yapısı ve
  pubspec.yaml yok. Bu kaynak tek başına mevcut APK'yı derlemek için yeterli değil.

## Değişen dosyalar

- docs/BETEXPLORER_ODDS_DATA_CONTRACT.md — tam görev metni.
- docs/ODDS_PROGRESS.md — ilerleme, kanıt ve engel kaydı.
- AGENTS.md — yeni oturum başlangıç talimatı.

## Test sonuçları

- Kaynak envanteri ve Git HEAD kontrolü yapıldı.
- Gerçek BetExplorer dört piyasa doğrulaması: yapılmadı.
- Uygulama maç seçimi / takip / indirme kabul testleri: yapılmadı.
- Yeniden başlatma, strict_as_of ve hamdan özet testleri: yapılmadı.
- APK derleme ve APK'dan gerçek indirme: yapılmadı.
- MacRadar Analiz okuyucu entegrasyon testi: yapılmadı.

## Açık sorunlar

- GitHub'da görünen sürüm son günlerdeki uygulama çalışmalarıyla eşleşmiyor.
  Güncel sunucu checkout'u ve tam Android projesi bulunmalı.
- Güncel gerçek match-data.json örneğine erişilmedi; captured_at,
  capture_type, performans şeması ve mevcut Asian okuyucu anlamları belirsiz.
- Çalışan kazıyıcının mevcut ortam ayarları ve veri yanıtları doğrulanmadı.
  Dört piyasanın geçmiş kapsamı hakkında henüz iddia yok.

## Sonraki işlem

Güncel MacRadar sunucu/Android kaynak konumunu bul ve erişimi doğrula.
Görev kayıtlarını güncel checkout'a, mevcut AGENTS.md talimatlarını koruyarak
taşı. Ardından gerçek maç ve mevcut indirme dosyasında kaynak/şema denetimi
yap. Ancak bu kanıtlardan sonra yeni oran mimarisini uygulamaya bağla.

## 2026-10-12 güncel sunucu erişimi

Kullanıcı Termux üzerinden kayıtlı `oracle` SSH bağlantısıyla sunucuya
erişti. Gelen gerçek çıktılara göre:

- Sunucu: `instance-20260920-1551`, kullanıcı `ubuntu`.
- Çalışan backend: `/home/ubuntu/macradar-src-test`.
- Backend HEAD: `3013f6e`, 2026-10-09 tarihli. 232 kaydedilmemiş değişiklik
  var; mevcut checkout'a reset/clean/stash uygulanmayacak.
- `src/server.js` 2026-10-12 tarihinde değiştirilmiş.
- Güncel Android projesi: `/home/ubuntu/macradar-mobile-src/pubspec.yaml`.
- Mevcut dışa aktarma: `src/matchDataExport.js:181`, arşive
  `match-data.json` ekleniyor.
- Sunucudaki eski sözleşme kök dizinde, 18054 karakter. Bu yeni görev
  sözleşmesiyle aynı olduğu varsayılmadı.
- Kontrol edilen iki proje kökünde AGENTS.md / docs/ODDS_PROGRESS.md yok.
- Sonraki adım güncel kaynakları ayrı inceleme dalına almak, yeni görev
  kayıtlarını güncel projeye bağlamak ve gerçek kazıyıcı doğrulamasını yapmak.
- Buluttan normal `git push` kimlik doğrulaması yok; GitHub bağlantısı
  üzerinden görev belgelerinin ayrı dala kaydı kullanılacak.

## 2026-10-12 sunucu uygulama kontrolü
- 153 dosya yedeklenerek uygulandı; ilgisiz dosyalar değiştirilmedi.
- 48 backend testi geçti; yeniden başlatılan backend sağlık kontrolünü geçti.
- HTTP paket doğrulaması eski sistem jsonschema sürümü nedeniyle durdu.
- APK derlemesi bu çalıştırmada başlamadı.
- Sonraki işlem: ayrı Python ortamında Draft 2020-12 doğrulaması ve teslim akışını yeniden çalıştırma.

## Büyük maç paket boyutu doğrulaması

- Gerçek sunucu ölçümü: GxLyDAQb için 83.541 ham kayıt; match-data.json
  641.629.085 byte, toplam açılmış paket 660.246.966 byte, 2400 dosya.
- 512 MiB ortam ayarı paket sürecine ulaşmış; boyut sınırı gerçekten aşılmış.
- Varsayılan 128 MiB korunuyor; yapılandırılabilir üst sınır 1 GiB oldu.
  Bu maçın denetim testi için sunucu ayarı 1 GiB kullanılacak. Ham veri kesilmiyor.
- Küçük maç gerçek HTTP/schema/manifest/kanıt ve performans koruma testi geçti.
  Maç öncesi dönem bittiği için yenileme PRE_MATCH_ENDED; güncel diye sunulmuyor.
- Büyük maç testi ve APK derlemesi henüz geçmedi; telefon/okuyucu testi yapılmadı.
- Değişen dosyalar: src/matchDataExport.js, exportSizeLimit.test.cjs, bu kayıt
  ve dağıtım planı. Sonraki işlem: boyut regresyonu, gerçek büyük maç ZIP testi.

## Büyük maç HTTP sonucu ve mobil paket sınırı

- Gerçek büyük maç HTTP testi geçti: ZIP 72.068.243 byte, önceki 83.541
  record_id korunmuş; 1X2 8700, OU 44285, ASIAN 42202, KG 3771 kayıt.
- Schema, manifest hash, kanıt bağlantıları ve performans bölümleri geçti.
  Ara geçmiş kaydı 0; yenileme PRE_MATCH_ENDED, güncel veri iddiası yok.
- APK derlemesi Android SDK ortam yolu eksikliğiyle durdu. Yeni betik mevcut
  local.properties/ortam veya kurulu build-tools yolundan SDK'yı doğruluyor.
- Gerçek 72 MB paket eski 64 MiB telefon sınırını aşıyor. Dart ve native
  kaydetme sınırı birlikte 128 MiB oldu; ZIP/hash denetimleri korunuyor.
- Mobil testler bu son değişiklikten sonra yeniden çalıştırılacak. Telefon
  kart indirme ve harici okuyucu kabulü hâlen yapılmadı.

## Sunucu uygulama ve APK sonucu

- macradar.service yenilendi; ayrı dropping servisi değiştirilmedi.
- 48 backend testi ve 26 mobil test geçti; analiz hata sayısı 0.
- İki gerçek mevcut APK HTTP export akışı, ZIP/schema/manifest/kanıt ve ham kayıt koruma denetimleri geçti.
- APK 1.0.10+110 derlendi; imza, aynı güncelleme imzası ve ZIP bütünlüğü doğrulandı.
- Telefon indirme/kurulum/kart indirme ve harici okuyucu kabulü henüz yapılmadı.
- Teslim kanıtı: artifacts/odds-revision-delivery-20261012/delivery.json

## Doğrulanmış APK teslimi
- APK 1.0.10+110: 19.714.871 byte; imza ve eski APK ile güncelleme imzası geçti.
- SHA256: 6e9de42f40eadf8af38ae81a0aff087b42fcc04de2aba17e8ddcfde4ccfa7059
- 48 backend ve son revizyondaki 26 mobil test geçti.
- İki gerçek HTTP paketinde schema, manifest, kanıt ve performans koruma geçti.
- Büyük maçta önceki 83.541 ham kayıt korundu; paket yaklaşık 72 MB.
- Sunucu açılmış paket sınırı 1 GiB; Dart/native indirme sınırı 128 MiB.
- Gerçek ara geçmiş kaydı 0; kaynakta bulunmayan geçmiş üretilmedi.
- Kaynak dönem/Asian işareti/durum/fiyat türü belirsizlikleri korunuyor.
- Telefon APK indirme kontrolü sonraki adım; kurulum ve APK düğmesinden kart
  indirme kabulü ile harici okuyucu entegrasyonu henüz yapılmadı.

## Telefon kabulünde yeniden açılan sorun — 2026-10-12

- Kullanıcı APK 1.0.10'da hazırlama ekranı ve eksik bwin açılışı bildirdi.
  Fiziksel telefon kart indirme kabulü tamamlanmış sayılmıyor.
- Gerçek işler xnGLmLIO ve 88eKVac4 yaklaşık 5 dakikada READY olmuş.
  APK adresinden hazır paketler HTTP 200, doğru SHA256, 955371/850956 byte.
- xnGLmLIO: 1045 ham kayıt, 402 kaynak açılışı; bwin current_only ve
  NO_ARCHIVE_LOCATOR_IN_THIS_SOURCE_ROW. Açılış yokluğu parser hatası diye
  varsayılmadı. 88eKVac4: 393 kaynak açılışı, bwin'de 14 açılış kaydı var.
- Yeni mobil revizyon: iş kimliği SharedPreferences'da tutulur, bağlantı
  kesilince aynı iş sorgulanır; toplama/ZIP/indirme/kayıt aşamaları görünür.
- Android 10+ doğrudan Download'a MediaStore ile kaydeder; eski Android
  kayıt seçicisini kullanır. Başarısız yazılan MediaStore girdisi temizlenir.
- İş kimliği yalnızca native kayıt başarısından sonra silinir; başarısız
  indirme/kayıt tekrarında hazır paketin yeniden hazırlanması önlenir.
- APK sürümü 1.0.11+111. Kesinti/aynı iş/aşama bildirim testleri eklendi;
  bu revizyonun Flutter testleri, Kotlin derlemesi ve telefon kabulü henüz
  çalıştırılmadı. Sonraki işlem: gerçek seçili maç HTTP testi ve mobil doğrulama.

- Dört piyasanın şirket detayına Yenile eklendi; ilk toplama sonrasında
  gelen açılışlar tekrar okunabilir. Aynı detayda iki yenileme başlatılmaz.
  Eksik kayıt, şirket/çizgi için kaydedilmiş kaynak açılışı yok diye belirtilir.

## Sunucu uygulama ve APK sonucu

- macradar.service yenilendi; ayrı dropping servisi değiştirilmedi.
- 48 backend testi ve son revizyon mobil testleri geçti; analiz hata sayısı 0.
- İki gerçek mevcut APK HTTP export akışı, ZIP/schema/manifest/kanıt ve ham kayıt koruma denetimleri geçti.
- APK 1.0.11+111 derlendi; imza, aynı güncelleme imzası ve ZIP bütünlüğü doğrulandı.
- Telefon indirme/kurulum/kart indirme ve harici okuyucu kabulü henüz yapılmadı.
- Teslim kanıtı: artifacts/odds-revision-delivery-20261012/delivery.json

## Telefon indirme revizyonu doğrulaması
- APK 1.0.11+111 derlendi; imza ve önceki sürümle güncelleme imzası geçti.
- 29 mobil test ve 48 backend testi geçti.
- Seçili xnGLmLIO maçında gerçek kaynak yenilemesi ve HTTP paket testi geçti.
- Büyük paket schema/hash/kanıt ve 83.541 önceki kayıt koruma testi geçti.
- Kalıcı iş kimliği, aynı işte bağlantı tekrarı ve aşama bildirimi testleri geçti.
- Download'a native kayıt Kotlin derlemesinden geçti; fiziksel telefon
  düğmesinden dosya kaydetme kabulü henüz doğrulanmadı.
- Bwin arşiv bağlantısı olmayan satırlara açılış üretilmedi.
- Harici okuyucu entegrasyonu henüz yapılmadı.
