# Kaynak kapsamı ve kabul durumu

## Gerçek kaynak kanıtı

Montpellier - Grenoble / 0p1XkgIt için dört piyasadan gerçek BetExplorer yanıtları saklandı.
1X2: 30 fiyat hücresi, 10 satır.
OU: 153 fiyat hücresi, 79 satır; erişilen 18 farklı çizgi, 2.5/2.75/3.0 ayrı.
ASIAN: 322 fiyat hücresi, 162 satır; çeyrek çizgiler ve çözülemeyen çizgiler korunuyor.
KG: 14 fiyat hücresi, 7 satır.
Bu sayılar kayıtlı gerçek yanıtların parser karşılaştırmasıdır; yeni başarılı canlı tur değildir.

Seçilmiş bet365 1X2/OU/KG ve bets.io ASIAN arşiv örnekleri yalnızca birer satır döndürdü.
Kaynak JavaScript'i son arşiv satırını Opening odds olarak etiketliyor.
Bu örneklerin kapsamı opening_only; bookmakerın mutlak ilk fiyatı veya eksiksiz geçmiş garanti edilmez.
Gerçek çok satırlı ara geçmiş henüz doğrulanmadı. A → B → A senaryosu yapay testle sınandı.
Sayfalama ve bütün bookmaker/çizgilerin geçmiş kapsamı doğrulanmadı.
Her seri kendi fetch sonucu ve kapsamıyla saklanır; örnek başarısı bütün serilere yayılmaz.

Kaynak my_tz_format kodu comma hücre zamanını sabit UTC+1 temelinden dönüştürüyor.
Kontrollü +0/+3 arşiv saat tercihi deneyi 180 dakika fark verdi.
Arşiv metninde yıl yok; kanıtlanmayan yıl üretilmez.
FULL_TIME_90 kaynak ödeme kapsamı, Asian ev takımına ait işaret,
inactive sınıfının CLOSED/SUSPENDED ayrımı ve exchange BACK/LAY türü halen doğrulanmadı.
Bunlar için null/UNKNOWN, kalite bayrağı ve analiz dışlama uygulanır.

## Başarısız yeni çekim

Atalanta - Venezia / GxLyDAQb yeni ortak toplayıcıyla gerçekten denendi.
Maç sayfası NL, CA, varsayılan Tor ve doğrudan bağlantıda zaman aşımına uğradı.
Kimlik doğrulanamadığından dört piyasa fiyat çekimine geçilmedi; sıfır yeni kayıt alındı.
Son bağlantı teşhisinde DNS/TCP/TLS kuruldu; HTTP 502 veya ilk yanıt zaman aşımı gözlendi.
Bu, bütün dünyada kaynak kesintisi olduğuna dair kanıt değildir.
Yeni başarılı dört piyasa gerçek çekim kabulü: BEKLİYOR / BAŞARISIZ.
Eski paketten sözleşme adayı oluşturulması yeni gerçek çekim teslimi değildir.

## Sınananlar

Program ayarları/zaman sınırları/backoff; kaynak-gözlem zamanı ayrımı;
dört gerçek piyasa yanıtında taraf ve hücre koruma; çeyrek çizgiler;
arşiv satırları/açılış etiketi; strict_as_of sızıntı engeli;
temel hareket hesabı ve kesim fiyatı eskiliği; fiyat grubu payları;
kalıcı kuyruk/idempotent tekrar takip; yarım tur yeniden başlatma;
aynı arşiv yanıtının tekrar çekimi; gerçek PostgreSQL salt okunur takvim ifadeleri;
paket alan/performans koruma ve bütün ZIP dosyalarının hashleri;
şirket karşılaştırması zaman/çizgi ayrımı; kontrol noktaları;
telefon hazırlama/sorgulama/indirme akışı ve Flutter analizi.

Test günlükleri: artifacts/odds-contract-audit/20261011T120630Z altındaki validation klasörleri.
Gerçek kaynak kanıtı ile yapay senaryo testleri birbirinin yerine sayılmaz.

## Teslimde kapanmamış kabul maddeleri

- Yeni toplayıcıyla başarılı gerçek dört piyasa turu ve match-data.json.
- Gerçek erişilebilir çok satırlı ara geçmiş karşılaştırması.
- Kaynak dönem/ödeme kapsamı, Asian ev işareti, durum ve exchange fiyat türü kanıtları.
- Gerçek MacRadar okuyucusunda yeni dosyanın entegrasyon testi.
- Canlı servisin yenilenmesi ve canlı regresyon kontrolleri.
- Yeni APK derleme, imza, güncelleme ve telefon indirme doğrulaması.

İş tamamlandı veya entegrasyon tamamlandı olarak işaretlenmemiştir.


## 2026-10-11 son gerçek yenileme ve servis geçişi

Gerçek export koordinatörü güncel kaynak çekimini ve geçmiş uzlaştırmasını tamamladı. Yeni paket şema, ZIP bütünlüğü, manifest hashleri ve gömülü kanıt bağlantıları kontrollerinden geçti. Önceki 1631 gerçek kayıt korundu; toplam ham kayıt 18114, source_history kayıt sayısı 0. Ara geçmişin gerçek çok satırlı karşılaştırması doğrulanmadı. Dönem/ödeme kapsamı, Asian ev işareti ve fiyat/durum türü için doğrulanmayan alanlar korunuyor. Harici MacRadar okuyucu testi yapılmadı. Backend 40 test dosyası ve mobil testler geçti. Analiz: 0 hata, 6 uyarı, 230 bilgi. Canlı servis yeni süreçle etkinleştirildi; APK derlemesi bekliyor.
Kanıt: /home/ubuntu/macradar-src-test/artifacts/odds-contract-audit/20261011T120630Z/export-fresh-coordinator-20261011T193435Z/final-refresh-validation.json

## 2026-10-12 mobil açılış, çizgi ve gecikme düzeltmesi

Dört canlı piyasa API’sinde iki kullanıcı maçının güncel fiyatları ve kaynak açılışları doğrulandı. Açılışlar taraf başına kendi kaynak zamanıyla gösterilir; ayrı arşiv taraflarından eşzamanlı fiyat grubu üretilmez. Alt/Üst bütün kaynak çizgilerini tam değeriyle gösterir. Asian doğrulanmış ev çizgisi ile takım/işareti belirsiz kaynak çizgisini ayrı tutar; belirsiz kaynak çizgileri kendi değerlerine göre ayrı bölümlerde açılır. Geçmiş ve açılış seçimleri kaynak bağlamı, dönem ve fiyat türüne göre ayrılır. Büyük kayıt yazımı HTTP sürecinden ayrı toplayıcı sürecine taşındı; tek toplayıcı içindeki maç/kaynak istek sınırları korunur. Kayıtlar silinmedi. Node heap sınırı 6144 MiB; API için yalnız iki değişmez okuma modeli tutulur ve dosya sürümü değişince yenilenir.

Backend 46 test dosyası, mobil 25 test geçti; canlı HTTP fiyat/geçmiş filtre kontrolleri geçti. Gerçek kaynak kayıtlarıyla mobil ekran testinde dört piyasanın açılışları geçmiş isteği beklerken görünür. Bu test telefon kurulumu veya harici MacRadar okuyucu kabulü yerine sayılmaz. Kaynak ara geçmişi, normal süre/ödeme kapsamı, Asian ev işareti ve fiyat/durum türü için açık kaynak doğrulama maddeleri kapanmadı.

Yeni APK 1.0.9+109 derleniyor. Maç ekranının gerçek asenkron ZIP hazırlama rotası ayrıca sınanıyor; telefon indirme/kurulum doğrulaması henüz yapılmadı.
