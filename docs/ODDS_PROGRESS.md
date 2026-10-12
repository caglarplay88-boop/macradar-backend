# BetExplorer oran bölümü ilerlemesi

## Aktif aşama

2026-10-12 — Aşama 1: sözleşmeyi kalıcı kaydetme ve güncel kaynak erişimini
doğrulama. Aşama 3 gerçek kaynak doğrulaması tamamlanmadı; parser yazılmadı.

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
