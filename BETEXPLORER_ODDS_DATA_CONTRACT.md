MacRadar’ın BetExplorer’dan oran toplayan mevcut telefon programını aşağıdaki sözleşmeye göre revize et.
 
AMAÇ VE SORUMLULUK
 
Kullanıcı bir maç seçip takibi başlattığında BetExplorer’da gerçekten erişilebilen açılışları, geçmiş fiyat değişimlerini ve takip başladıktan sonraki gözlemleri topla. Bunları 1X2, Alt/Üst, Asian Handicap ve KG piyasaları için tek bir match-data.json dosyasında dışa aktar.
 
Telefon programının görevi:
 
- Kaynağı doğru okumak.
- Takım, piyasa, çizgi, taraf ve zamanı doğru eşleştirmek.
- Ham veriyi ve toplama denetimini korumak.
- Aşağıda tanımlanan temel hesapları tekrar üretilebilir biçimde yapmak.
- MacRadar’ın mevcut dosya alanlarını koruyarak yeni veri sözleşmesini sunmak.

 
Telefon programına bahis yorumu, tuzak tahmini, kazanacak takım tahmini, yapay zekâ veya tahmin modeli ekleme. Bunlar MacRadar tarafının işidir.
 
Yeni bir API sağlayıcısına geçme. Mevcut BetExplorer kazıyıcısını kullan. Çalışan performans toplama işlevlerini ve ilgisiz kodları koru.
 
1. KOD DEĞİŞİKLİĞİNDEN ÖNCE GERÇEK KAYNAĞI DOĞRULA

 
Mevcut kazıyıcıyı ve mevcut match-data.json örneğini incele.
 
Gerçek bir maçta dört piyasa için ayrı ayrı doğrula:
 
- Güncel fiyatların geldiği tablo veya yanıt.
- Kaynağın açılış olarak etiketlediği fiyat.
- Erişilebilen ara değişim geçmişi.
- Kaynak zamanının anlamı, hassasiyeti ve saat dilimi.
- Bookmaker kimliği.
- Takım sırası.
- Gol çizgisi.
- Asian çizgisinin hangi takıma ait olduğu ve işareti.
- Piyasanın normal süre/ilk yarı/canlı gibi kapsamı.
- Açık, askıda veya kapalı durum bilgisi.
- Exchange için fiyat türü.

 
Sayfanın yüklediği veri yanıtları erişilebiliyorsa bunları işle. Endpoint, selector, alan anlamı veya saat dilimi uydurma.
 
BetExplorer’ın bütün şirketlerde bütün ara değişimleri verdiğini varsayma. Her bookmaker/piyasa/çizgi için geçmiş kapsamını ayrı kaydet: history\_available, opening\_only, current\_only, unavailable veya fetch\_failed.
 
history\_available etiketi eksiksiz geçmiş garantisi değildir. Erişilebilen en eski ve en yeni zamanı, sayfalamanın bitip bitmediğini ve bilinen kapsam sınırlarını ayrıca yaz.
 
Kaynakta bulunmayan alan null olsun. Eksikliğin nedeni kaydedilsin.
 

2. MAÇ VE SERİ KİMLİĞİ

 
Kalıcı kaynak event\_id kullan. Takım adları tek başına maç kimliği değildir.
 
Ana analiz kapsamı:
 
- Maç öncesi.
- Normal süre: 90 dakika ve hakemin eklediği duraklama süreleri.
- Ekstra süre ve penaltılar hariç.

 
Bunu period = FULL\_TIME\_90 olarak açıkça kaydet. Kaynağın farklı bir ödeme kuralı varsa ayrıca sakla; kapsamı doğrulanmayan kayıt ana analize uygun sayılmasın.
 
Seri kimliği: event\_id + source + bookmaker\_id + source\_context\_id + market + period + line + selection + price\_type.
 
market değerleri: 1X2, OU, ASIAN, KG.
 
selection değerleri:
 
- 1X2: HOME, DRAW, AWAY.
- OU: UNDER, OVER.
- ASIAN: HOME, AWAY.
- KG: YES, NO.

 
source\_context içinde kaynağın bölge, bookmaker grubu, dil ve saat ayarı gibi fiyatın yorumunu etkileyen bağlamını sakla. Değişen bağlamları sessizce tek seri gibi birleştirme.
 
Asian için home\_handicap ve away\_handicap ayrı alanlar olsun. İşaret kaynakta doğrulanmışsa birbirinin negatifi olmalı. İşareti oran büyüklüğünden veya favoriden tahmin etme.
 

3. TAKİBİ BAŞLATMA VE SÜRDÜRME

 
Takip başlangıcında:
 
- Maç kimliğini, takım sırasını ve başlama saatini doğrula.
- Dört piyasadaki erişilebilir şirketleri ve çizgileri keşfet.
- Güncel fiyat gruplarını al.
- Erişilebilir açılışları ve geçmiş değişimleri al.
- Yerel kayıtlarla kayıpsız birleştir.
- Düzenli gözleme başla.

 
Aynı maça tekrar basılması ikinci takip işi oluşturmasın. Takip durumu kalıcı saklansın; program yeniden başlatılınca kaldığı yerden sürsün. Telefon arka plan kısıtından oluşan kesintiler görünür olsun.
 
Üç başlangıç türünü ayır:
 
- source\_reported\_opening: kaynağın açılış olarak bildirdiği fiyat.
- earliest\_available\_history: erişilebilir geçmişin en eski fiyatı.
- first\_observed: programın ilk gördüğü fiyat.

 
İlk gözlemi açılış diye adlandırma. Kaynak açılışını bookmakerın mutlak ilk fiyatı olarak garanti etme. Açılış saati verilmemişse saat üretme. Her şirket ve çizginin başlangıcı ayrı olabilir.
 

4. AYARLANABİLİR TOPLAMA DÜZENİ

 
Başlangıç için şu varsayılanları kullan:
 
- Maça 72 saatten fazla: 60 dakika.
- 72–24 saat: 30 dakika.
- 24–6 saat: 10 dakika.
- 6–1 saat: 5 dakika.
- Son 60 dakika: 2 dakika.

 
Bunlar BetExplorer’ın ilan edilmiş güncelleme süreleri veya bilimsel optimum değildir. Program ayarlarıdır. Gerçek kaynak gecikmesi, tarama süresi ve cihaz kapasitesi ölçülerek değiştirilebilir.
 
Bir tur tamamlanmadan yenisini başlatma. Çok maç için merkezi kuyruk ve sınırlı eşzamanlılık kullan. Hata veya erişim kısıtında artan bekleme uygula ve kaydet.
 
Geçmiş uzlaştırması:
 
- İlk takipte erişilebilir geçmişi al.
- Normal turlarda güncel fiyatları, durumları ve yeni çizgileri kontrol et.
- Son 6 saate kadar geçmişi 30 dakikada bir uzlaştır.
- Son 6 saatte geçmişi 10 dakikada bir uzlaştır.
- Kullanıcı indirme istediğinde son güncel tarama ve geçmiş uzlaştırması yap.

 
Bu uzlaştırma aralıkları da ayarlanabilir olsun. Geçmiş endpoint’i veya sayfalama gerçekten varsa yeni kayıtları kontrollü al; yoksa geçmiş erişimini uydurma.
 
Başlangıç saatinin değişimini kaydet ve takvimi güncelle. Maç canlıya geçtiğinde maç öncesi akışı sonlandır veya ayrı kapsama taşı. Canlı fiyatları maç öncesi seriye karıştırma.
 
Son maç öncesi gözleme last\_pre\_match\_observation de. Gerçek kapanış olduğu doğrulanmadan closing\_odds deme.
 

5. HAM KAYIT VE ZAMAN SÖZLEŞMESİ

 
odds\_raw içindeki her taraf kaydı en az şu alanları taşısın:
 
record\_id event\_id source source\_url source\_context\_id bookmaker\_id bookmaker\_name market period selection line home\_handicap away\_handicap odds\_decimal status price\_type source\_record\_id source\_timestamp source\_timestamp\_raw source\_timezone timestamp\_precision observed\_at capture\_started\_at capture\_finished\_at snapshot\_id source\_group\_id record\_origin opening\_type is\_main\_line quality\_flags raw\_evidence\_ref
 
record\_origin: source\_opening, source\_history veya scraper\_observation.
 
status: OPEN, SUSPENDED, CLOSED veya UNKNOWN.
 
price\_type: SPORTSBOOK, EXCHANGE\_BACK, EXCHANGE\_LAY veya UNKNOWN.
 
source\_timestamp kaynağın bildirdiği fiyat zamanıdır. observed\_at programın o bilgiyi gerçekten aldığı zamandır.
 
Bu iki zamanı birbirinin yerine kullanma. Geçmişten sonradan alınan kaydın observed\_at zamanını geriye çekme.
 
Doğrulanmış zamanları UTC ISO 8601 olarak yaz. Arayüzde Türkiye saati gösterilebilir. Saat dilimi doğrulanmıyorsa UTC dönüşümü yapma; source\_timestamp null olsun, ham zaman metni ve belirsizlik korunsun.
 
Kaynak dakika hassasiyetindeyse saniye doğruluğu iddia etme. Tarih bilinip saat bilinmiyorsa aynı günün rastgele saatini atama.
 
snapshot\_id bir toplama gözlemini bağlar; tek başına bütün fiyatların kaynakta aynı anda güncellendiğini kanıtlamaz. Her tarafın kaynak zamanını koru. source\_group\_id yalnızca kaynak gerçekten ortak fiyat grubu kimliği sağlıyorsa doldurulsun.
 
Ham yanıtları denetim için yerelde sakla. Dosyaya gerekli kanıt parçalarını veya güvenli referans/hash bilgilerini koy. Oturum belirteci, çerez veya kişisel hesap bilgisi dışa aktarma.
 

6. TEKRARLAR, HAREKETLER VE TOPLAMA DENETİMİ

 
Her tarama için collection.runs altında: run\_id, başlangıç/bitiş, başarı, kapsam, bulunan seri sayısı, hata, önceki başarılı taramaya mesafe.
 
Değişmeyen fiyatların her gözlemini hareket sayma. İstenirse ardışık eşit gözlemler first\_seen\_at, last\_seen\_at, observation\_count ile sıkıştırılabilir; kaynak ham kayıtları ve tarama denetimi korunmalı.
 
Sıkıştırma, iki gözlem arasında fiyatın kesintisiz aynı kaldığı anlamına gelmez.
 
A → B → A hareketini koru. Açık → kapalı → açık geçişini fiyat aynı olsa da koru. Kaynak bağlamı değişimini fiyat tekrarına indirgeme.
 
Görünmeyen satırı otomatik kapalı sayma. Kaynağın bildirdiği kapanma, eksik yükleme ve çekim hatası ayrı olsun.
 
Eksik fiyatı 0, 1.01 veya karşı tarafın fiyatından türetilmiş değerle doldurma.
 

7. PİYASALARIN TOPLANMASI

 
1X2: HOME, DRAW, AWAY fiyatlarını al. Gerçek birlikte gözlenen grubu bağla. Farklı zamanlı geçmiş kayıtlarını eşzamanlı üçlü diye sunma.
 
OU: Bütün erişilebilir çizgileri al. 2.5, 2.75 ve 3.0 ayrı seriler olsun. Her çizgide UNDER ve OVER tarafları korunsun.
 
ASIAN: Bütün erişilebilir çizgileri al. Ev ve deplasman işaretlerini açıkça kaydet. Avrupa üç yönlü handicapını Asian içine koyma.
 
Aynı çizgide fiyat değişimi ile kaynak tarafından belirtilen ana çizginin değişimini ayrı olaylar olarak kaydet.
 
KG: YES ve NO taraflarını al. Eksik tarafı üretme.
 
Ana çizgi: is\_main\_line yalnızca kaynak açıkça bildiriyorsa doldurulsun. Kaynak belirtmiyorsa null olsun. Dengeli fiyatlardan seçilen çizgiyi kaynak ana çizgisi diye etiketleme.
 
EXCHANGE: Back ve lay ayrımını koru. Hacim, likidite ve komisyon yalnızca kaynak veriyorsa kaydedilsin. Türü belirsiz exchange fiyatı sportsbook karşılaştırmasına otomatik dahil edilmesin.
 

8. TELEFONDA YAPILACAK TEMEL HESAPLAR

 
Ham veri asıl kayıt olsun. odds\_summary yardımcı ve yeniden üretilebilir olsun. Her hesap calculation\_version, kullanılan record\_id değerleri, zaman temeli ve dışlama nedenlerini taşısın.
 
Her şirket/piyasa/çizgi/taraf için:
 
- Başlangıç türü, fiyatı ve zamanı.
- Kesimdeki son uygun fiyat ve zamanı.
- Fiyat yaşı; kaynak yaşı bilinmiyorsa gözlem yaşı ayrıca.
- Mutlak değişim: son − ilk.
- Yüzde değişim: 100 × (son / ilk − 1).
- Gözlenen minimum/maksimum ve zamanları.
- Farklı fiyatlar arasındaki geçiş sayısı.
- Eşit tekrarlar atlandıktan sonra fiyat yönünün tersine dönme sayısı.
- Son gözlenen fiyat değişimi.
- Erişilebilir geçmiş aralığı ve toplama boşlukları.

 
Kaynak değişim saati yoksa “son gerçek değişim saati” üretme. Değişim, önceki gözlem ile yeni gözlem arasında gerçekleşmiş olabilir; bu aralığı göster.
 
Tam ve karşılaştırılabilir fiyat grubunda: q\_i = 1 / odds\_i Q = toplam(q\_i) overround = Q − 1 normalized\_price\_share\_i = q\_i / Q
 
Oranları 0–1 aralığında sakla; ekranda yüzdeye dönüştür. Fiyat payı farkını yüzde puan olarak göster.
 
normalized\_price\_share için “normalize fiyat payı” adını kullan. Gerçek kazanma olasılığı veya tahmin yüzdesi deme. Overround gerçek bookmaker kârı değildir.
 
Eksik, zamanı belirsiz veya uyumsuz fiyat grubunda grup hesabı null ve gerekçeli olsun.
 
Geçmiş taraf fiyatları ileri taşınarak grup kurulursa:
 
- reconstructed = true.
- Her tarafın kaydı ve yaşı gösterilsin.
- Gerçek birlikte gözlenen gruptan ayrı tutulsun.
- Zamanı bilinmeyen taraf taşınmasın.
- Yapılandırılmış eskilik sınırı aşılırsa hesap yapılmasın; kullanılan sınır dosyada yazsın.

 
Asian ve OU tam/çeyrek çizgilerinde bu paylar kazanma olasılığı değildir; iade ve yarım sonuçlar vardır.
 
Telefon tarafında Power/Shin, gol dağılımı, iade olasılığı, EV, adil oran veya tuzak puanı üretme. Bunlar ayrıca uygulanıp sınanacak MacRadar hesaplarıdır.
 

9. KESİM VE ZAMAN PENCERELERİ

 
Açılış/başlangıçtan kesime ve son 24 saat, 6 saat, 1 saat, 15 dakika için ayrı özet üret.
 
T−24 saat, T−6 saat, T−60 dakika ve T−10 dakika kontrol noktaları takip sırasında geçiliyorsa kaydedilsin. Takip daha sonra başladıysa geçmişten alınan veriyle o anda gerçekten gözlenmiş kontrol noktası varmış gibi davranma.
 
İki inceleme biçimini ayır:
 
- strict\_as\_of: kesim anında programın gerçekten bildiği kayıtlar.
- retrospective\_source\_history: sonradan alınmış, kaynak zamanı geçmişe ait kayıtlar.

 
strict\_as\_of hesabında observed\_at kesimden sonra olan kayıt kullanılmasın. Bilinen source\_timestamp de kesimden sonra olmamalı.
 
Pencere başlangıcında kayıt yoksa doğrusal interpolasyon veya sahte dakika satırı üretme. Uygun önceki kayıt varsa zamanını ve yaşını göster; kabul edilebilir kayıt yoksa sonuç null olsun.
 
Şirketleri aynı piyasa, çizgi, dönem, fiyat türü ve karşılaştırılabilir zaman aralığında karşılaştır. Farklı tarihli açılış hareketlerini eşzamanlı ortak hareket sayma.
 
Yükselen/düşen/değişmeyen şirket sayıları, şirket listeleri ve dışlananlar ayrı verilsin. Medyan hesaplanıyorsa örneklem kapsamı yazsın.
 
Sorgulama sırasından piyasa lideri çıkarma. Zaman hassasiyeti yeterli değilse ilk hareket eden şirket sıralaması üretme.
 

10. KALİTE DENETİMİ

 
Ham kayıtları silmeden işaretle:
 
- Geçersiz ondalık fiyat/parsing.
- Belirsiz maç, takım, çizgi veya işaret.
- Belirsiz zaman/saat dilimi.
- Aynı kimlik ve zamanda çelişen fiyat.
- Eksik veya uyumsuz fiyat grubu.
- Olağandışı overround.
- Karşılaştırılabilir komşu çizgilerde ters fiyat sıralaması.
- Kaynak bağlamı geçişi.
- Eski fiyat veya toplama boşluğu.
- Kesim sonrası gözlem.
- Başlama sonrası/canlı kayıt.
- Belirsiz exchange fiyat türü.

 
Fiyat sıralaması kontrolü aynı şirket, bağlam, dönem ve karşılaştırılabilir zamanda yapılsın. Şüpheyi fiyat düzeltmesi veya manipülasyon kanıtı olarak sunma.
 
Teknik olarak okunabilen, analize uygun ve şüpheli kayıt sayılarını ayrı göster. Eşikler yapılandırılabilir ve dosyada görünür olsun.
 

11. TEK DOSYA VE MEVCUT EKLENTİ UYUMLULUĞU

 
match-data.json şu bölümleri taşısın:
 
schema\_version calculation\_version exportedAt match collection odds\_raw odds odds\_summary quality performance
 
schema\_version yeni sözleşmenin sürümünü açıkça belirtmeli. Mevcut dosyada performans farklı alanlarda saklanıyorsa onları da koru; zorla taşıyarak mevcut işlevi bozma.
 
collection içinde: analysis\_cutoff, analysis\_mode, son başarılı tarama, son tarama sonucu, piyasa/seri kapsamı, kesintiler, toplama ayarları, parser sürümü, zaman dönüşümü bilgisi ve uyumluluk durumu bulunsun.
 
odds\_raw: Yeni sözleşmenin ayrıntılı taraf kayıtları; asıl denetim kaynağı.
 
odds\_summary: Bu kayıtların sürümlü temel hesapları.
 
odds: Mevcut MacRadar okuyucusu için uyumluluk bölümü. Piyasa anahtarları 1X2, OU, ASIAN, KG olsun.
 
Mevcut okuyucunun kullandığı alanlar:
 
- Ortak: event\_id, bookmaker\_key veya bookmaker\_id/bookmaker\_name, captured\_at.
- 1X2: home\_odd, draw\_odd, away\_odd.
- OU: under\_odd, over\_odd, total\_line.
- ASIAN: home\_odd, away\_odd, handicap\_line.
- KG: yes\_odd, no\_odd.
- Kaynakta varsa mevcut capture\_type ve kapanma alanları.

 
Mevcut dosyada captured\_at alanının anlamını önce doğrula ve belgele; sessizce değiştirme. Yeni açık zaman alanları source\_timestamp ve observed\_at olsun.
 
Uyumluluk gruplarına raw\_record\_ids ekle. Böylece her eski biçimli satır ham kayıtlara bağlanabilsin.
 
ASIAN handicap\_line ev takımının işaretli handikapı olarak belgelenmeli. Mevcut okuyucunun bu anlamı desteklediği doğrulanmadan negatif veya belirsiz işareti sessizce dönüştürme.
 
Uyumluluk satırı üretmek için farklı zamanlı geçmiş tarafları sahte eşzamanlı gruba çevirme. Gruplanamayan geçmiş odds\_raw içinde korunsun.
 
Yeni kapsam, bağlam, exchange türü ve zaman kurallarının tamamının eski okuyucu tarafından anlaşıldığını varsayma. Desteklenmeyen kayıtlar için compatibility.warnings ve gerekli MacRadar adaptör değişikliklerini bildir. Sessiz veri kaybı yapma.
 
İndirmede son tarama başarısızsa dosya üretilebilir; collection içinde başarısızlık ve son başarılı veri saati açıkça yer alsın. “Güncel” etiketi verme.
 
Grafikler odds\_raw üzerinden üretilebilsin. Grafik resmi zorunlu olmasın. Dosyaya yorum metni veya maç sonucu tahminini ham veri yerine koyma.
 

12. KABUL TESTLERİ VE TESLİM

 
Gerçek bir maçta dört piyasanın kaynakta görünen kayıtlarını çıktı ile karşılaştır.
 
Ayrıca doğrula:
 
- Erişilebilir ara geçmiş hareketleri korunuyor.
- Açılış, en eski geçmiş ve ilk gözlem ayrılıyor.
- 1X2 tarafları doğru eşleşiyor.
- 2.5, 2.75 ve 3.0 ayrılıyor.
- Asian takım ve işaretleri doğru.
- KG tarafları doğru.
- A → B → A korunuyor.
- Açık → kapalı → açık korunuyor.
- Tekrar takipte ikinci iş ve gereksiz duplicate oluşmuyor.
- Kesinti ile değişmeyen fiyat ayrılıyor.
- Yeniden başlatma sonrasında takip sürüyor.
- Belirsiz zamanlar sahte UTC’ye çevrilmiyor.
- Sonradan alınan geçmiş strict\_as\_of hesabına sızmıyor.
- Ham veriden temel özet yeniden üretilebiliyor.
- Yeni dosyanın mevcut alanları korunuyor.
- Dosya gerçek MacRadar okuyucusunda deneniyor; desteklenmeyen bölümler açıkça bildiriliyor.

 
MacRadar okuyucusuna erişilemiyorsa entegrasyon testini “yapılmadı” diye bildir; dosyanın JSON olarak açılması entegrasyon kanıtı değildir.
 
Teslim et:
 
1. Revize edilmiş çalışan program.
2. Gerçek çekimden üretilmiş bir match-data.json.
3. Şema ve eski alan eşleme belgesi.
4. Dört piyasa için gerçekten erişilebilen geçmişin kısa kapsam raporu.
5. Çalıştırılan kabul testleri ve sonuçları.
6. MacRadar tarafında gerekli adaptör değişiklikleri varsa açık listesi.

 
Çekim testini çalıştırmadan “tamamlandı”, geçmiş doğrulanmadan “eksiksiz” ve okuyucu testi yapılmadan “entegrasyon tamam” deme.

SON TEKNİK EKLER — ÖNCEKİ MADDELERLE BİRLİKTE UYGULA
 
 
1. snapshot\_id bütün tarama turunu tanımlasın. quote\_group\_id ise birlikte alınan karşılıklı fiyat grubunu tanımlasın. Aynı snapshot\_id içindeki bütün şirket ve tarafları eşzamanlı kabul etme. Kaynağın sağladığı source\_group\_id bunlardan ayrı korunsun.
 
2. Tek dosyayla denetim yapılabilmesi için gerekli kaynak kanıt parçalarını JSON içindeki raw\_evidence bölümünde sakla; raw\_evidence\_ref bu bölüme bağlansın. Telefonun yerel dosya yolunu veya tek başına hash değerini MacRadar’ın okuyabileceği kaynak kanıtı sayma. Büyük ham yanıtlar yerelde kalabilir; temel eşleştirmeyi denetleyecek parçalar dosyada bulunmalı.
 
3. captured\_at alanının mevcut anlamını eski gerçek dosya üzerinden doğrula ve uyumluluk belgesine yaz. source\_timestamp, observed\_at ve captured\_at alanlarını sessizce birbirinin yerine kullanma. Yeni zaman, bağlam ve fiyat grubu kurallarını eski MacRadar okuyucusunun desteklediği gerçek entegrasyon testiyle doğrulanmadıkça tam uyumluluk iddia etme.


şimdi oran çekme bölümünü buna göre tekrardan yapacağız bu promptu unutmaman için eğer projeye eklemen gerekiyorsa önce ekle bu promptun her harfini eksiksiz uygulaman gerekli çünkü 