MACRADAR — ORAN BÖLÜMÜNDE SAPTANAN EKSİKLERİ TAMAMLA
 
Bu görev mevcut MacRadar APK’sı ve ona hizmet veren backend içindir. Önceden verilen BetExplorer veri sözleşmesi geçerlidir. Bu metin, gerçek indirilen dosyada ve APK ekranlarında saptanan eksiklerin tamamlanmasıdır.
 
Çalışan yeni oran mimarisini inceleyerek düzelt. Başka bir paralel oran sistemi kurma. Performans, giriş ve ilgisiz çalışan bölümlere dokunma. Kullanıcı mevcut APK’dan maç seçip takibe alacak ve mevcut “Maç kartı indir” düğmesinden dosyayı indirecek. Ayrı kart hazırlama aracı oluşturma.
 
A. GÖREVİ UNUTMAMAK İÇİN ÖNCE KALICI KAYDET
 
Kod değiştirmeden:
 
1. Bu metni eksiksiz docs/ODDS\_IMPROVEMENT\_TASK.md içine kaydet.
2. Önceki veri sözleşmesini docs/BETEXPLORER\_ODDS\_DATA\_CONTRACT.md içinde koru.
3. docs/ODDS\_PROGRESS.md içinde her görevi açık/tamamlandı/engelli olarak takip et. Tamamlanan maddelerde değişen dosyalar, çalıştırılan testler ve kanıtları yer alsın.
4. Mevcut AGENTS.md içeriğini koruyarak, bu görevde çalışmaya başlamadan bu üç dosyanın okunması gerektiğini ekle.
5. Dosyaları Git kaydına dahil et.

 
Her yeni oturumda, bağlam özetlenmesinden sonra ve bir sonraki iş grubuna geçmeden bu dosyaları yeniden oku. Göreve ilişkin yeni kullanıcı düzeltmelerini görev dosyasına ekle.
 
Sohbet hafızasını tek kayıt kabul etme. Test kanıtı olmadan bir maddeyi tamamlandı işaretleme. Gerçek bir erişim engeli dışında işi yalnızca plan sunarak bırakma.
 
B. DENETLENEN DOSYADA BULUNAN DURUM
 
İncelenen örnek: Genclerbirligi–Galatasaray event\_id: xnGLmLIO Dosya: MacRadar-xnGLmLIO-1791837203854792.zip
 
Dosyada:
 
- 2.331 ham kayıt var.
- Dört piyasa mevcut.
- 643 taraf serisi var.
- Bütün ham kayıtlarda period=null.
- Bütün ham kayıtlarda status=UNKNOWN ve price\_type=UNKNOWN.
- 896 Asian kaydının tamamında home\_handicap/away\_handicap boş.
- 402 kaynak açılışının yılı doğrulanmadığından source\_timestamp boş.
- Ana analize uygun kayıt sayısı sıfır.
- Bütün since\_start, cutoff\_price ve cutoff\_change özetleri boş.
- Hesaplanmış fiyat grubu/marj çıktısı yok.

 
Bu sayılar o örnek dosyaya aittir; yeni çıktıda aynı sayıları bekleme veya sabitleme.
 
Ham kayıtlar ve kaynak kanıtları mevcut olduğundan, sorunu yalnızca alan ekleyerek çözmüş sayma. Kaynak anlamlarını doğrula ve hesap akışını çalışır hale getir.
 
C. TAKİBE ALMA VE EKRANA GEÇİŞ
 
Bültenden maç takibe alındığında ekran hemen “Takip aktif” ve “oran bulunamadı” gösteriyor; fiyatlar daha sonra aniden geliyor.
 
Portmore–Violette ekranında bu sorun görüldü.
 
Beklenen davranış:
 
- Takip isteği kalıcı kaydedilsin; aynı maç için ikinci iş oluşmasın.
- İlk veri gelene kadar “Takip başlatılıyor / Güncel oranlar alınıyor” gösterilsin.
- Her piyasanın yükleme durumu ayrı takip edilsin.
- Güncel fiyatlar geldikçe kullanıcıya gösterilsin.
- Açılış/geçmiş toplama ayrı ilerleme durumu taşısın.
- Bütün geçmişin indirilmesi bitene kadar kullanıcıyı boş ekranda bekletme.
- “Oran bulunamadı” yalnızca başarılı kaynak sorgusu gerçekten boş döndüğünde gösterilsin.
- Başarısız sorgu “veri yok” sayılmasın; hata ve yeniden deneme durumu gösterilsin.
- Bir piyasanın başarısızlığı diğerlerinin görünmesini engellemesin.
- Ekrana geri dönme, yeniden açma ve yenileme durumları aynı kalıcı takip durumuyla tutarlı olsun.
- Eski veri gösteriliyorsa son başarılı gözlem saati görünsün.

 
Backend işi devam ederken UI sonucu uygun şekilde alsın; rastgele sabit bekleme ekleyerek çözme. Yükleme, başarılı-boş, kısmi başarı ve hata durumlarını açıkça ayır.
 
D. BAZI MAÇ VE ŞİRKETLERDE AÇILIŞ ALINMIYOR
 
Sorun yalnızca Boca Juniors–Vasco maçında değil. Bazı maç/şirketlerde açılış geliyor, bazılarında BetExplorer’da bulunduğu halde uygulamada yok deniyor.
 
Kaynakta açılışın bulunması, çekimin başarısız olması, açılışın henüz yüklenmesi, kaydedilip UI’da gösterilmemesi ve gerçekten bulunmaması ayrı durumlar olsun.
 
Araştır:
 
- Geçmiş bağlantısı/locator neden bazı şirketlerde bulunmuyor?
- Farklı kaynak satır yapıları destekleniyor mu?
- Açılış kaydedilip şirket/piyasa/çizgi/bağlam eşleşmesinde kayboluyor mu?
- UI açılışı yanlış veri bölümünden mi arıyor?
- Tek taraflı arşiv kaydı, tam grup oluşmadığı için görünmez mi oluyor?

 
Kaynakta bulunmuş açılışı sırf grup veya zaman doğrulaması eksik diye “açılış yok” olarak gösterme. Açılış fiyatını göster; gerçek belirsizliği ayrıca açıkla.
 
Örnekler:
 
- Boca Juniors–Vasco kaynak ekranında 07.10 03:30, 1.87 açılışı görülüyor; APK Betinasia detayında açılış yok yazıyor. Kaynak görüntüsünde şirket adı görünmediği için aynı şirket/seçim eşleşmesini ayrıca doğrula.
- Genclerbirligi–Galatasaray KG kaynak ekranında 10.10 16:34, 1.65 açılışı görülüyor; APK Bet365 KG detayında açılış yok yazıyor. Aynı bookmaker/seçim olduğunu gerçek kaynak kimlikleriyle doğrula.

 
Ekran görüntülerindeki örnekleri bütün şirketlere genelleme. Gerçek yanıtları kullanarak hatanın nedenini bul.
 
E. AÇILIŞ GÖRÜNÜMÜNÜ DÜZELT
 
1X2 açılışı ev, beraberlik ve deplasman için üç ayrı büyük kart halinde gösteriliyor.
 
Tek açılış kartında 1 / X / 2 sütunlarını göster. Örneğin Megapari ekranındaki 5.68 / 4.52 / 1.58 aynı açılış kartında yer alsın.
 
Tarafların açılış zamanları farklıysa her tarafın zamanını koru; tek ortak zaman uydurma. UI’da tek kart olması, hesapta eşzamanlı üçlü olduğu anlamına gelmez.
 
OU, Asian ve KG’de de aynı çizginin karşılıklı taraflarını tek okunabilir kartta göster. Eksik taraf “—” olsun; fiyat üretme.
 
Aynı açılışın her yeniden çekimde tekrar kart oluşturmasını engelle. Ham denetim ve yeniden gözlem bilgileri korunmalı.
 
Değişmeyen güncel fiyat tekrarlarını da ana hareket listesinde gereksiz çoğaltma. Son doğrulama saatini koru; A→B→A ve durum değişimleri kaybolmasın.
 
F. “KAYNAK SAATİ DOĞRULANMADI” UYARISI
 
Kaynakta tarih/saat görünmesine rağmen genel “Kaynak saati doğrulanmadı” uyarısı çıkıyor.
 
Kaynak zamanı ayrıştırmasını tamamla:
 
- Kaynağın saat ayarını ve dönüşüm kuralını doğrula.
- Arşivde yıl yoksa gerçek kaynak bağlamıyla yıl çözümünü araştır.
- Doğrulanmış çözümün dayanağını dosyaya kaydet.
- Yıl dönüşü ve eski maçlarda yanlış yıl atama.
- Gerçekten çözülemeyen yıl/saat dilimini tahmin ederek kesin zaman üretme.

 
Hamda görünen tarih/saat her durumda korunsun.
 
Uyarı gerçek belirsizliği söylemeli: “Kaynak yılı doğrulanamadı” veya “Kaynak saat dilimi doğrulanamadı”. Saat açıkça okunuyorken bütünüyle saat yokmuş gibi davranma.
 
G. KAPALI FİYATLAR AÇIK GÖSTERİLİYOR
 
Genclerbirligi–Galatasaray KG ekranında BetExplorer Rainbet ve Stake fiyatlarını üstü çizili gösteriyor; APK bunları normal açık fiyat gibi gösteriyor.
 
Kaynağın kapalı/inaktif fiyat işaretini gerçek HTML/veri ve kaynak davranışıyla doğrula. Sadece fiyatın bulunmasına bakarak OPEN deme.
 
Düzeltme:
 
- Durum taraf bazında saklansın.
- Kaynağın kapalı fiyatı APK’da görünür biçimde kapalı gösterilsin.
- Son bilinen fiyat geçmişte korunsun; güncel açık fiyat diye kullanılmasın.
- Açık→kapalı→açık geçişleri saklansın.
- Kapanma ham veri, uyumluluk alanları, özet ve grafiğe tutarlı yansısın.
- Eksik sayfa yüklemesini veya satırın kaybolmasını otomatik CLOSED sayma.

 
Bu kontrol yalnızca KG’ye değil dört piyasaya uygulanmalı.
 
H. DÖNEM, FİYAT TÜRÜ VE ASIAN İŞARETİ
 
Bütün kayıtları UNKNOWN/null bırakıp işi tamamlandı sayma. Ancak kanıtsız true/OPEN/FULL\_TIME\_90 atamak da çözüm değildir.
 
- Ana piyasaların normal süre 90 dakika + duraklama süresi kapsamını doğrula.
- Sportsbook ve exchange ayrımını kaynak kimliği/işaretleriyle doğrula.
- Exchange back/lay belirsizse onu ayrı tut.
- Asian çizgisinin ev takımına ait işaretini kaynak açıklaması, takım sırası ve gerçek tabloyla doğrula.
- home\_handicap ve away\_handicap doğru doldurulsun.
- İşareti oran büyüklüğünden çıkarma.
- Kaynak çizgisi ile yorumlanmış işaretli çizgi ayrı korunabilsin.

 
Tek bir örneği doğrulamakla bütün farklı kaynak biçimlerinin desteklendiğini iddia etme.
 
I. İNDİRME ÖNCESİ GÜNCELLEME SIRASI
 
Örnek dosyada güncel fiyatlar önce alınıyor, geçmiş taraması yaklaşık altı dakika sürüyor. Sonrasında dosya hazırlanıyor. En yeni güncel gözlem 373 saniyelik olduğu için 300 saniye sınırını aşıyor.
 
İndirme akışı:
 
1. Erişilebilir geçmişi uzlaştır.
2. Ardından son güncel fiyat ve durum taramasını yap.
3. Kesimi belirle.
4. Aynı veri görüntüsünden ham kayıtları ve hesapları dışa aktar.

 
Son tarama başarısızsa eski veriyi gizleme; son başarılı zamanı ve güncelleme başarısızlığını bildir.
 
Kaynağın son fiyat değişim saati ile bizim fiyatın hâlâ sunulduğunu doğruladığımız zaman farklıdır. Dün değişmiş bir fiyat, şimdi kaynakta yeniden görülmüşse sırf değişim tarihi eski diye otomatik kullanılamaz sayılmamalı.
 
Buna karşılık yeni gözlem yapılmadan eski kayda yeni observed\_at yazma.
 
Geçmiş hareket uygunluğu ile kesimdeki güncel fiyat uygunluğunu ayrı değerlendir. Eski açılışları güncel fiyat eskilik sınırı nedeniyle hareket hesabından topluca dışlama.
 
J. FİYAT GRUPLARI VE HESAPLAR
 
Aynı gerçek tablo satırında birlikte gözlenen karşılıklı fiyatların kaynak son-değişim zamanları farklı olabilir. Bu tek başına grup kullanılamaz demek değildir.
 
Birlikte gözlenen güncel grupları, geçmiş taraflardan yeniden kurulmuş gruplardan ayır. “Bütün taraflar aynı saniyede değişmiş olmalı” şartıyla geçerli güncel tabloları topluca reddetme.
 
Kaynakta birlikte sunulma, fiyatların açık olması, gözlem zamanı, dönem ve taraf eşleşmesi doğrulansın. Son-değişim zamanları ve farklılıkları yine korunsun.
 
Doğrulanmış ham kayıtlardan:
 
- Başlangıç ve son uygun fiyat.
- Fiyat değişimi.
- Gözlenen min/maks.
- Hareket ve yön değişimi sayısı.
- Uygun fiyat gruplarında overround ve normalize fiyat payı.
- Veri olan pencerelerde şirket karşılaştırması.

 
hesaplarını çalıştır.
 
Eksik pencereler null kalabilir. Fakat kaynak doğrulama ve zaman politikası hataları nedeniyle bütün hesapların boş kalmasını başarı sayma.
 
Her sayı ham record\_id değerlerine bağlansın. Özet hamdan yeniden üretilebilsin.
 
K. ARA HAREKETLERİN SINANMASI
 
İncelenen dosyada arşiv yanıtları yalnızca birer açılış satırı içeriyor. Üç güncel gözlem turunda da fiyat değişmemiş.
 
Bu örnek ara hareket toplamanın çalıştığını kanıtlamaz; bozuk olduğunu da tek başına kanıtlamaz.
 
BetExplorer’da gerçekten birden fazla değişim gösteren başka bir seri bul:
 
- Kaynak değişim listesini kaydet.
- Çıktıdaki bütün erişilebilir değişimleri karşılaştır.
- A→B→A yolunun korunduğunu doğrula.

 
Kaynakta bulunmayan hareketi üretme. Açılış+son fiyatı tam geçmiş diye etiketleme.
 
L. EKLENTİ SINIRI
 
Telefon programı kalite ve zaman kurallarını doğru dışa aktarsın. MacRadar Analiz eklentisinin motorunu bu telefon görevi içinde değiştirme.
 
Mevcut eklenti okuyucusu yeni main\_analysis\_eligible, bağlam ve durum alanlarını tam uygulamıyor; bu ayrıca eklenti tarafında düzeltilecek.
 
Uyumluluk sorununu gidermek için telefonun kalite bayraklarını silme, Asian işaretini değiştirerek eski okuyucuya uydurma veya uygun olmayan veriyi uygun ilan etme.
 
M. TAMAMLAMA TESTLERİ
 
Gerçek uygulama akışından doğrula:
 
- Bültenden takibe alma sırasında yanlış “oran yok” mesajı çıkmıyor.
- Güncel veriler aşamalı geliyor; geçmişin durumu ayrı görünüyor.
- Tekrar basma/geri dönme ikinci takip işi oluşturmuyor.
- Bazı şirketlerde açılışın kaybolması çözülüyor.
- Açılışlar tek kartta, taraf zamanları korunarak gösteriliyor.
- Zaman uyarıları gerçek belirsizliği açıklıyor.
- Rainbet/Stake kapanma örneği ve yeniden açılma doğru işleniyor.
- KG açılışı gerçek kaynakla eşleşiyor.
- Asian işaretleri ve normal süre kapsamı doğrulanıyor.
- İndirme öncesi son güncel tarama doğru sırada.
- Geçmiş hareketler sırf eski diye dışlanmıyor.
- Geçerli güncel gruplar farklı son-değişim saatleri yüzünden reddedilmiyor.
- Hesaplar elle kontrol edilen örneklerle uyuşuyor.
- Değişim içeren gerçek arşiv örneği kayıpsız aktarılıyor.
- Servis yeniden başlatılınca takip devam ediyor.
- Mevcut “Maç kartı indir” düğmesinden çıkan gerçek dosya denetleniyor.
- Performans ve ilgisiz çalışan bölümler bozulmuyor.

 
Her madde için çalıştırılan kontrol ve kanıtı ODDS\_PROGRESS.md içine yaz.
 
APK derlenmesini, dosya varlığını veya syntax kontrolünü çalışan çekim testi yerine sunma. Eksik kalan işi açıkça bildir. Görev ve test kanıtlarını Git’e kaydet.
 
Revize edilmiş mevcut APK’yı teslim et; kullanıcı maç kartını uygulamadan indirecek.
