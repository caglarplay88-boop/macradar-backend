MACRADAR — BETEXPLORER ORAN BÖLÜMÜNÜ BAŞTAN KUR
 
GÖREV
 
Mevcut MacRadar uygulamasının oran toplama, takip, saklama, temel hesaplama ve dışa aktarma bölümünü aşağıdaki sözleşmeye göre baştan kur.
 
Eski oran koduna art arda yama ekleme. Yeni bölümü tek, tutarlı mimariyle oluştur; uygulamanın mevcut maç seçimi ve “Maç kartı indir” akışına bağla. Yeni bölüm doğrulandıktan sonra eski oran yolunu devreden çıkar. İki ayrı aktif oran sistemi bırakma.
 
Bütün uygulamayı yeniden yazma. Performans toplama, giriş, kullanıcı verileri ve ilgisiz çalışan bölümleri koru.
 
Mevcut BetExplorer kazıyıcısının gerçek kaynak erişimini inceleyip yeniden kullanabilirsin; yanlış eşleştirmelerini veya eski veri tasarımını yeni bölüme taşıma. Yeni API sağlayıcısına geçme.
 
Telefon uygulaması ve mevcut backend arasındaki görev dağılımını incele. Düzenli takip, mevcut altyapıda güvenilir çalışacağı yerde yürüsün. Telefon ekranının açık olmasına bağımlı takip tasarlama; arka plan veya bağlantı kesintilerini gizleme.
 
Yapay zekâ, bahis yorumu, kazanacak takım tahmini ve tuzak puanı ekleme. Bu bölüm veriyi doğru toplayacak ve temel hesapları çıkaracak. Yorumlama MacRadar Analiz eklentisinde yapılacak.
 
1. ÖNCE GÖREVİ KALICI KAYDET

 
Kod değiştirmeden bu metni eksiksiz olarak: docs/BETEXPLORER_ODDS_DATA_CONTRACT.md
 
dosyasına kaydet.
 
docs/ODDS_PROGRESS.md dosyasında aktif aşamayı, tamamlanan işlerin kanıtlarını, değişen dosyaları, test sonuçlarını, açık sorunları ve sonraki işlemi tut.
 
Mevcut AGENTS.md talimatlarını koruyarak, bu görevde her yeni oturumun bu iki dosyayı okuyarak başlaması gerektiğini ekle.
 
Görevi ve ilerlemeyi Git kaydına dahil et. Sohbet hafızasını tek görev kaydı olarak kullanma. Her aşama sonunda ilerlemeyi güncelle.
 

2. KULLANICININ AKIŞI

 
Kullanıcı:
 
- Mevcut APK’da bir maç seçer.
- Takibi/analizi başlatır.
- Uygulama erişilebilir açılışları ve geçmiş hareketleri toplar.
- Sonraki fiyatları düzenli takip eder.
- Kullanıcı mevcut “Maç kartı indir” düğmesine basar.
- Uygulama sözleşmeye uygun tek maç verisini indirir.

 
Ayrı kart hazırlama aracı, elle JSON üretme veya kullanıcıya ek dosya birleştirme işi çıkarma.
 
İndirilen veri MacRadar Analiz eklentisine verilecek. Mevcut indirme biçimini incele; arşiv kullanılıyorsa içinde match-data.json bulunsun. Mevcut HTML kartı varsa aynı veriden üretilebilir. Analizin asıl kaynağı görüntü değil JSON olacak.
 

3. GERÇEK BETEXPLORER KAYNAĞINI DOĞRULA

 
Yeni parserı yazmadan gerçek bir maçta dört piyasayı ayrı incele:
 
1X2, Alt/Üst, Asian Handicap, KG.
 
Şunların gerçek kaynağını doğrula:
 
- Güncel fiyat tablosu veya veri yanıtı.
- Kaynağın açılış olarak etiketlediği fiyat.
- Erişilebilir ara fiyat geçmişi.
- Kaynak zamanının anlamı, hassasiyeti ve saat dilimi.
- Maç, takım ve bookmaker kimlikleri.
- Gol çizgileri.
- Asian takım sırası ve handikap işareti.
- Maç süresi kapsamı.
- Açık/askıda/kapalı bilgisi.
- Exchange back/lay ayrımı.

 
Sayfanın yüklediği veri yanıtları erişilebiliyorsa bunları işle. Endpoint, selector, zaman veya alan anlamı uydurma.
 
Her bookmaker/piyasa/çizgi için geçmiş erişimini ayrı kaydet: history_available, opening_only, current_only, unavailable, fetch_failed.
 
history_available eksiksiz geçmiş garantisi değildir. Erişilebilir başlangıç/bitiş ve kapsam sınırları ayrıca yazılmalı.
 

4. MAÇ VE SERİ KİMLİĞİ

 
Maçı kalıcı kaynak event_id ile eşleştir. Yalnızca takım adına güvenme.
 
Ana kapsam: Maç öncesi, 90 dakika ve hakemin eklediği duraklama süreleri. Ekstra süre ve penaltılar hariç. period = FULL_TIME_90.
 
İlk yarı, canlı, tur atlama ve Avrupa üç yönlü handicap piyasalarını bu kapsamla karıştırma.
 
Seri anahtarı: event_id + source + bookmaker_id + source_context_id + market + period + line + selection + price_type.
 
market: 1X2, OU, ASIAN, KG.
 
selection: 1X2: HOME, DRAW, AWAY. OU: UNDER, OVER. ASIAN: HOME, AWAY. KG: YES, NO.
 
Kaynağın bölge, dil, saat ayarı veya fiyat bağlamı değişirse kaydet; farklı bağlamları sessizce tek seri yapma.
 

5. İLK TOPLAMA VE TAKİP

 
Takip başlatılınca:
 
- Maç ve başlama zamanını doğrula.
- Dört piyasadaki erişilebilir bookmaker ve çizgileri keşfet.
- Güncel fiyat gruplarını al.
- Erişilebilir açılışları ve geçmiş değişimleri al.
- Yerel kayıtlarla kayıpsız birleştir.
- Düzenli takibi başlat.

 
Aynı maça tekrar basılması ikinci takip işi oluşturmasın.
 
Takip ve kayıtlar kalıcı olsun. Servis/program yeniden başladığında devam etsin. Kesintileri kaydet.
 
Başlangıç türlerini ayır: source_reported_opening: kaynağın açılış etiketi. earliest_available_history: erişilebilir en eski geçmiş. first_observed: bizim ilk gözlemimiz.
 
İlk gözlemi açılış diye adlandırma. Açılış saati yoksa üretme. Her şirket ve çizginin başlangıcı ayrı olabilir.
 

6. TOPLAMA SIKLIĞI

 
Ayarlanabilir başlangıç düzeni:
 
Maça 72 saatten fazla: 60 dakika. 72–24 saat: 30 dakika. 24–6 saat: 10 dakika. 6–1 saat: 5 dakika. Son 60 dakika: 2 dakika.
 
Bunlar bizim gözlem ayarlarımızdır; BetExplorer’ın garantili güncelleme süreleri değildir.
 
Bir tur bitmeden yenisini başlatma. Çok maç için merkezi kuyruk ve sınırlı eşzamanlılık kullan. Hata/erişim kısıtında artan bekleme uygula; başarısızlığı kaydet.
 
İlk takipte erişilebilir geçmişi al. Normal turlarda güncel fiyatları, durumları ve yeni çizgileri kontrol et. Geçmişi son 6 saate kadar 30 dakikada, son 6 saatte 10 dakikada bir uzlaştır. Bu aralıklar ayarlanabilir olsun.
 
Her turda bütün eski geçmişi gereksiz yeniden indirme. Gerçek sayfalama varsa kontrollü ilerle.
 
İndirmede son güncel taramayı ve geçmiş uzlaştırmasını dene. Başarısız olursa son başarılı veriyi dışa aktar; başarısızlığı ve veri saatini göster.
 
Başlama zamanı değişirse takvimi güncelle ve eski/yeni zamanı koru. Maç canlıya geçince maç öncesi toplamayı sonlandır. Canlı kayıtları aynı seriye ekleme.
 
Son maç öncesi gözleme last_pre_match_observation de; doğrulanmamış kapanış etiketi kullanma.
 

7. HAM VERİ

 
odds_raw içindeki her taraf kaydı şunları taşısın:
 
record_id event_id source source_url source_context_id bookmaker_id bookmaker_name market period selection line home_handicap away_handicap odds_decimal status price_type source_record_id source_timestamp source_timestamp_raw source_timezone timestamp_precision observed_at capture_started_at capture_finished_at snapshot_id quote_group_id source_group_id record_origin opening_type is_main_line quality_flags raw_evidence_ref
 
Eksik alanlar null olsun; eksiklik nedeni kaydedilsin.
 
record_origin: source_opening, source_history, scraper_observation.
 
status: OPEN, SUSPENDED, CLOSED, UNKNOWN.
 
price_type: SPORTSBOOK, EXCHANGE_BACK, EXCHANGE_LAY, UNKNOWN.
 
snapshot_id tarama turudur. quote_group_id birlikte alınan karşılıklı fiyat grubudur. source_group_id yalnızca kaynak sağlıyorsa doldurulur.
 
Aynı tarama turundaki bütün fiyatları eşzamanlı kabul etme.
 
Kaynak yanıtlarını denetim için sakla. JSON içindeki raw_evidence bölümüne takım/çizgi/fiyat/zaman eşleştirmesini denetleyecek kanıt parçalarını koy. Yalnızca telefondaki dosya yolu veya hash, eklentinin okuyabileceği kanıt sayılmaz.
 
Çerez, oturum belirteci veya kişisel hesap bilgisi dışa aktarma.
 

8. ZAMAN

 
source_timestamp kaynağın bildirdiği fiyat zamanıdır. observed_at programın kaydı gerçekten aldığı zamandır.
 
Birbirinin yerine kullanma. Sonradan alınan geçmişin observed_at zamanını geriye çekme.
 
Doğrulanmış zamanlar UTC ISO 8601 olsun. Arayüz Türkiye saati gösterebilir.
 
Saat dilimi belirsizse UTC dönüşümü uydurma; ham zamanı koru, source_timestamp null ve kalite notu olsun.
 
Dakika hassasiyetinden saniye doğruluğu üretme. Açılışın saati yoksa rastgele saat atama.
 

9. PİYASALAR

 
1X2: HOME, DRAW, AWAY taraflarını doğru bağla. Farklı zamanlı geçmiş taraflarını eşzamanlı üçlü diye gösterme.
 
OU: Bütün erişilebilir gol çizgilerini ve UNDER/OVER taraflarını al. 2.5, 2.75, 3.0 ayrı seriler.
 
ASIAN: Bütün erişilebilir çizgileri al. home_handicap ve away_handicap açıkça saklansın. Örnek: ev +1, deplasman −1. İşareti kaynaktan doğrula; favoriden veya fiyat büyüklüğünden çıkarma.
 
Aynı çizgide fiyat değişimi ile kaynak ana çizgisinin değişimini ayır.
 
KG: YES/NO taraflarını doğru eşleştir. Eksik tarafı üretme.
 
Ana çizgi: Kaynak açıkça bildiriyorsa is_main_line doldur. Bildirmiyorsa null; fiyatlardan kaynak ana çizgisi uydurma.
 
Exchange: Back/lay ayrımını koru. Hacim, likidite ve komisyon yalnızca gerçekten sağlanıyorsa kaydet. Türü belirsiz exchange fiyatını normal bookmaker karşılaştırmasına otomatik dahil etme.
 

10. TEKRARLAR VE KESİNTİLER

 
Her tarama için başlangıç/bitiş, başarı, kapsam, bulunan seri sayısı ve hatayı kaydet.
 
Değişmeyen fiyatları bağımsız hareket sayma. Ardışık eşit gözlemler first_seen_at, last_seen_at, observation_count ile sıkıştırılabilir; denetim kayıtları korunmalı.
 
A→B→A hareketini silme. Açık→kapalı→açık geçişini fiyat aynı olsa da koru. Kaynak bağlamı değişimini silme.
 
İki gözlem arasında fiyatın kesintisiz aynı kaldığını iddia etme.
 
Görünmeyen satırı otomatik kapalı sayma. Kaynak kapanması, eksik yükleme ve çekim hatası ayrı olsun.
 
Eksik fiyatı 0, 1.01 veya türetilmiş fiyatla doldurma.
 

11. TEMEL HESAPLAR

 
odds_raw asıl kayıttır. odds_summary hamdan yeniden üretilebilir yardımcı hesaptır.
 
Hesaplarda calculation_version, kullanılan record_id değerleri, zaman temeli ve dışlama nedenleri bulunsun.
 
Her seri/taraf için:
 
- Başlangıç türü, fiyatı, zamanı.
- Kesimdeki son uygun fiyat ve zamanı.
- Kaynak fiyat yaşı; bilinmiyorsa gözlem yaşı ayrıca.
- Mutlak değişim: son−ilk.
- Yüzde değişim: 100×(son/ilk−1).
- Gözlenen minimum/maksimum ve zamanları.
- Farklı fiyatlar arasındaki geçiş sayısı.
- Eşit tekrarlar atlandıktan sonra yön değişimi sayısı.
- Son gözlenen değişim.
- Geçmiş kapsamı ve toplama boşlukları.

 
Kaynak değişim zamanı yoksa gözlem anını gerçek değişim zamanı diye sunma; önceki/yeni gözlem arasındaki aralığı göster.
 
Tam, karşılaştırılabilir fiyat grubunda: q_i = 1/odds_i Q = toplam(q_i) overround = Q−1 normalized_price_share_i = q_i/Q
 
Payları 0–1 olarak sakla; arayüzde yüzde göster. Pay farkını yüzde puan olarak göster. “Normalize fiyat payı” de; gerçek tahmin olasılığı deme. Overround gerçek bookmaker kârı değildir.
 
Eksik veya uyumsuz grupta hesap null ve gerekçeli olsun.
 
Geçmiş fiyatlar ileri taşınarak grup yeniden kurulursa reconstructed=true olsun; her tarafın zamanı ve yaşı gösterilsin. Zamanı bilinmeyen taraf taşınmasın. Ayarlanmış eskilik sınırı dosyada yazsın. Politika yoksa güvenilir grup hesabı üretme.
 
Asian ve OU tam/çeyrek çizgilerinde iade/yarım sonuç nedeniyle normalize pay kazanma olasılığı değildir.
 
Bu aşamada Power/Shin, gol dağılımı, EV, adil oran, tahmin yüzdesi veya tuzak puanı ekleme.
 

12. KESİMLER VE KARŞILAŞTIRMA

 
Başlangıçtan kesime ve son 24 saat, 6 saat, 1 saat, 15 dakika için özet üret.
 
Takip sırasında erişilen T−24 saat, T−6 saat, T−60 dakika, T−10 dakika kontrol noktalarını kaydet. Takip daha sonra başladıysa o anda gerçekten gözlenmiş veri varmış gibi davranma.
 
İki modu ayır: strict_as_of: kesimde gerçekten bilinen kayıtlar. retrospective_source_history: sonradan alınan geçmiş.
 
strict_as_of içinde observed_at kesimden sonra olan kayıt kullanılmaz. Bilinen source_timestamp de kesimden sonra olmamalı.
 
Pencere sınırında sahte fiyat veya doğrusal interpolasyon üretme. Uygun önceki kayıt varsa zamanını ve yaşını göster; yoksa null.
 
Şirketleri aynı çizgi, dönem, fiyat türü, bağlam ve karşılaştırılabilir pencerede karşılaştır.
 
Yükselen/düşen/değişmeyen şirketleri ve dışlananları göster. Medyan varsa kullanılan örneklem yazılsın.
 
Farklı tarihli açılışları eşzamanlı hareket sayma. Sorgulama sırasından piyasa lideri çıkarma.
 

13. VERİ KALİTESİ

 
Ham kayıtları silmeden işaretle:
 
- Parsing/geçersiz fiyat.
- Belirsiz maç, takım veya Asian işareti.
- Belirsiz zaman.
- Aynı kimlik/zamanda çelişen kayıt.
- Eksik/uyumsuz grup.
- Olağandışı overround.
- Karşılaştırılabilir komşu çizgilerde ters fiyat sıralaması.
- Kaynak bağlamı değişimi.
- Eski fiyat ve kesinti.
- Kesim sonrası kayıt.
- Canlı/başlama sonrası kayıt.
- Belirsiz exchange türü.

 
Şüpheli fiyatı otomatik düzeltme. Teknik olarak okunabilen, analize uygun ve şüpheli kayıt sayılarını ayrı göster.
 

14. “MAÇ KARTI İNDİR” ÇIKTISI

 
Mevcut düğme şu bölümleri içeren match-data.json üretsin:
 
schema_version calculation_version exportedAt match collection odds_raw odds odds_summary quality raw_evidence performance
 
Mevcut performans alanlarını kaybetme. Eski alanları sessizce silme veya farklı anlamda kullanma.
 
collection: Kesim ve dışa aktarma zamanı, analiz modu, son başarılı tarama, son tarama sonucu, kapsam, kesintiler, toplama ayarları ve parser sürümü.
 
odds: Mevcut MacRadar okuyucusuyla uyumluluk bölümü.
 
Ortak alanlar: event_id, bookmaker_key veya bookmaker_id/bookmaker_name, captured_at.
 
1X2: home_odd, draw_odd, away_odd.
 
OU: under_odd, over_odd, total_line.
 
ASIAN: home_odd, away_odd, handicap_line.
 
KG: yes_odd, no_odd.
 
Mevcut capture_type ve kapanma alanlarını anlamlarıyla koru. raw_record_ids ile uyumluluk satırını ham kayıtlara bağla.
 
captured_at alanının eski anlamını gerçek dosyadan doğrula ve belgele. Kaynak/gözlem zamanıyla sessizce değiş tokuş etme.
 
ASIAN handicap_line ev takımının işaretli handikapı olarak belgelenmeli. Okuyucunun desteklediği doğrulanmadan işareti değiştirme.
 
Gruplanamayan geçmiş odds_raw içinde korunsun. Uyumluluk satırı oluşturmak için sahte eşzamanlı fiyat grubu üretme.
 
Yeni alanları eski eklentinin tamamen desteklediğini varsayma. Gerekli adaptör değişikliklerini compatibility.warnings içinde bildir.
 
Son tarama başarısızsa indirme çalışabilir; “güncel” yazma, son başarılı veri saatini göster.
 

15. TAMAMLAMA VE KABUL

 
Testleri gerçek uygulamanın maç seçimi, takip ve “Maç kartı indir” akışından yap. Elle hazırlanmış dosyayı çalışan uygulama testi yerine sunma.
 
Doğrula:
 
- Dört piyasada gerçek kaynak–çıktı eşleşmesi.
- Erişilebilir ara geçmişin korunması.
- Açılış/ilk gözlem ayrımı.
- 1X2 ve KG taraf eşleşmesi.
- OU çizgi ayrımı.
- Asian takım ve işaret doğruluğu.
- A→B→A ve durum geçişleri.
- Tekrar takipte ikinci iş oluşmaması.
- Kesinti/değişmeyen fiyat ayrımı.
- Yeniden başlatma sonrası devam.
- Zaman belirsizliğinin korunması.
- Kesim sonrası geçmişin strict_as_of’a sızmaması.
- Hamdan özet üretimi.
- Mevcut performans akışının korunması.
- APK’dan gerçek dosya indirilmesi.

 
MacRadar eklentisine erişebiliyorsan gerçek okuyucu testi yap. Erişemiyorsan “entegrasyon testi yapılmadı” yaz; JSON’un açılmasını entegrasyon kanıtı sayma.
 
Yeni oran bölümü doğrulandıktan sonra eski kod yolunu kaldır ve uygulamayı tek yeni akışta bırak.
 
Dosya varlığı, syntax veya APK derlenmesi tek başına tamamlanma değildir. Çalıştırılmayan testi geçti yazma; bulunmayan geçmişi üretme.
 
İşi yalnızca plan sunarak bırakma. Uygulama ve testleri tamamla. Somut bir erişim engelinde neye erişemediğini ve gereken tek işlemi açıkça bildir.
 
SON TESLİM
 
Mevcut MacRadar’ın revize edilmiş APK’sı ve güncellenmiş kaynak kodu teslim edilecek. Kullanıcı maç kartını bu APK’nın mevcut indirme düğmesinden alacak.
 
Kısa teslim bilgisinde:
 
- Gerçekten çalışan dört piyasa kapsamı.
- Kaynakta bulunmayan geçmiş alanları.
- Test sonuçları.
- Varsa çözülmemiş engel veya eklenti adaptör ihtiyacı.
 
Ayrı elle kart hazırlama süreci kurma.
