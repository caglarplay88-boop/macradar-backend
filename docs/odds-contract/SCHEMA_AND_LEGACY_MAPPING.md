# BetExplorer oran sözleşmesi ve eski alan eşlemesi

Ana gereksinim kaynağı: ../../BETEXPLORER_ODDS_DATA_CONTRACT.md
Sözleşme SHA256: 414277046fd489dd821ada72689f054b9b799bd02861ed4af991b8814de38be5

## Sürümler ve asıl kayıt

Şema: betexplorer-match-data-v2. Temel hareket hesabı: betexplorer-basic-movement-v2.
odds_raw asıl taraf kaydıdır. raw_evidence gerekli kaynak parçalarını dosyanın içinde taşır.
raw_evidence_ref bu bölümdeki anahtardır. Yerel dosya yolu veya hash tek başına kaynak kanıtı değildir.
snapshot_id toplama turunu, quote_group_id birlikte alınan tablo satırını tanımlar.
Bu bağlar bütün şirketlerin veya tarafların kaynakta eşzamanlı güncellendiğini kanıtlamaz.
source_group_id sadece kaynak ortak kimlik sağlarsa doldurulur.

## captured_at: doğrulanmış eski anlam

Gerçek eski paket: MacRadar-0p1XkgIt-1791703861588.zip içindeki match-data.json.
Eski current/periodic satırlarında captured_at kazıyıcının gözlem zamanıdır.
Eski opening satırlarında captured_at taraf açılış zamanlarının en büyüğünden üretilmiştir.
Eski parser bu zamanı yıl ve saat dilimi varsayımlarıyla UTC biçimine çevirmiştir.
Dolayısıyla captured_at bütün capture_type değerlerinde tek bir anlam taşımaz.
Bu alan yeniden yorumlanmaz veya değiştirilmez. Yeni source_timestamp ve observed_at ile eşit sayılmaz.
Eski verinin gerçek kaynak zamanı/ilk alınma zamanı kanıtlanamıyorsa yeni alanlar null kalır.
created_at veritabanına yazılma zamanıdır; gerçek gözlem zamanı diye yeniden adlandırılmaz.

| Piyasa | Eski taraf alanları | Çizgi |
|---|---|---|
| 1X2 | home_odd → HOME; draw_odd → DRAW; away_odd → AWAY | null |
| OU | under_odd → UNDER; over_odd → OVER | total_line |
| ASIAN | home_odd → HOME; away_odd → AWAY | handicap_line |
| KG | yes_odd → YES; no_odd → NO | null |

Eski event_id, bookmaker alanları, captured_at, capture_type ve kapanma alanları korunur.
Her eski satır raw_record_ids ile ham kayıtlara bağlanır.
ASIAN için yeni home_handicap/away_handicap kaynak ev takımının işareti doğrulanmadan doldurulmaz.
Eski handicap_line sessizce işaret değiştirmez. Okuyucunun ev takımı işaretini desteklediği henüz doğrulanmadı.
Farklı zamanlı geçmiş taraflarından uyumluluk satırı üretilmez.
Yeni ve eski satırların tamamının eski okuyucu tarafından anlaşıldığı iddia edilmez.

## Hesap ve zaman

Doğrulanmış zamanlar UTC ISO 8601; hassasiyet ayrıca timestamp_precision.
Kaynak yılı veya saat dilimi bilinmiyorsa ham zaman korunur, source_timestamp null olur.
strict_as_of: observed_at kesimden sonra olamaz; bilinen kaynak zamanı da kesimden sonra olamaz.
retrospective_source_history sonradan edinilmiş geçmişi ayrı inceler.
since_start ve pencere result alanları gözlenen hareketlerdir; son değerleri kesim fiyatı iddiası değildir.
cutoff_price, cutoff_change ve pencere cutoff_result alanları eskilik/uygunluk denetiminden geçer.
Uygun kesim fiyatı yoksa null ve gerekçe verilir. Geçmiş hareketler bu nedenle silinmez.
Normalize fiyat payı tahmin veya gerçek kazanma olasılığı değildir. Overround gerçek kâr değildir.
Power/Shin, EV, adil oran, gol modeli, tuzak veya maç sonucu tahmini üretilmez.

## Tekrarlar ve kesintiler

Birebir aynı arşiv yanıtı aynı seri/bağlamda tekrar alınırsa ilk observed_at korunur.
Sonraki çekimin zamanı, snapshot ve kanıt bağlantısı collection.archive_retrievals içine yazılır.
Kaynak kalıcı geçmiş satırı kimliği vermediği için değişmiş/belirsiz yanıtlar otomatik silinmez.
Aynı fiyata dönüşler ve durum değişimleri korunur.
Yarım tur kalıcı pending_run kaydıyla tutulur; ölen süreç yeniden açılınca kesinti kaydı oluşur.
Kurtarma zamanı gerçek tur bitiş zamanı veya fiyat değişim zamanı sayılmaz.
Kontrol noktaları gerçek takip sırasında geçilen sınırların strict_as_of bilgi kümesini saklar.
Kesimde kaynak taraması yapıldığı veya geç başlayan takibin kontrol noktasını gördüğü iddia edilmez.

## Çalışma yeri ve ayarlar

Toplayıcı mevcut Ubuntu backend üzerinde çalışır; telefon takip ve dışa aktarım istemcisidir.
Telefon arka plan kısıtı sunucudaki toplama turunu durdurmaz.
Telefonun indirme beklemesi ile sunucunun kaynak toplama kesintisi ayrı değerlendirilir.
Toplama ve eskilik ayarları dosyada görünür. Aralıklar kaynak güncelleme süreleri değildir.
MACRADAR_ODDS_CONTRACT_SETTINGS_FILE program ayar dosyasını seçer.
Kaynak yılı/dönemi/Asian işareti/durum/exchange türü kanıtlanmadan uygunluk bayrağı açılmaz.

## MacRadar okuyucu adaptörü: gerekli işler

- schema_version ve calculation_version okuyup bilinmeyen sürümü açıkça bildirmek.
- raw_evidence, odds_raw, raw_record_ids ve quote_group_id bağlarını doğrulamak.
- captured_at ile source_timestamp/observed_at alanlarını ayırmak.
- Bağlam, dönem, taraf, çizgi ve exchange türünü karşılaştırma anahtarına katmak.
- Asian ev işaretini doğrulamak; bilinmeyen işareti tahmin etmemek.
- strict_as_of ve retrospective hesaplarını ayırmak.
- Kaynak kapsamı, kesintiler, dışlama nedenleri ve güncellik bilgisini göstermek.
- Yeni ham serileri ve çizgileri eski odds bölümünde bulunmasa da kayıpsız okuyabilmek.

Gerçek MacRadar okuyucu entegrasyonu: YAPILMADI / NOT_RUN.
JSON açılabilmesi veya ZIP hash doğrulaması okuyucu entegrasyonu kanıtı değildir.

## Eski çizgi alanlarının veri tipi

Eski odds.total_line/handicap_line değeri ve veri tipi aynen korunur.
Yeni odds_raw.line, yalnızca tam ondalık sayı metniyse sayısal değere çevrilir.
Özgün değer legacy_line_raw alanındadır. Belirsiz metin null ve
LEGACY_LINE_UNPARSEABLE bayrağıyla korunur; bölünmüş çizgi tahmin edilmez.
Bu veri tipi dönüşümü Asian ev işaretinin kaynakta doğrulandığı anlamına gelmez.
Şema denetimi güncel buildContractExport çıktısında çalışır; eski denetim
adayının saklandığı tarihteki sürümü güncel programın çıktısı sayılmaz.


### Kaynak saat dilimi gösterimi

`source_timezone`, mevcut kaynak kayıtlarında metin, null veya `{"kind":"FIXED_OFFSET","offset_minutes":0}` biçiminde olabilir. Şema sabit offset nesnesinin türünü ve dakika sınırını açıkça denetler. Bu gösterim tek başına saat dilimi doğrulama kanıtı değildir; kaynak kanıtı, ham zaman ve kalite bayrakları ayrıca korunur. Kaynak zamanları bu düzeltmede değiştirilmemiştir. MacRadar adaptörü yapılandırılmış saat dilimi gösterimini desteklemelidir.

Dışa aktarımın varsayılan toplam sıkıştırılmamış sınırı 128 MiB'dır. `MACRADAR_EXPORT_MAX_UNCOMPRESSED_BYTES` ile ayarlanabilir; geçersiz değerler ve 512 MiB üzeri reddedilir. Sınır aşımında kayıtlar kesilmez; dışa aktarım hata verir. Genel ZIP işlevinin varsayılanı 64 MiB olarak korunmuştur.
