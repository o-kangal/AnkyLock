import type { Messages } from './en.js';

// The site's Turkish text; the keys and parameters follow en.ts.
export const tr: Messages = {
  'meta.description':
    'AnkyLock, geliştiriciler için yerel öncelikli, uçtan uca şifreli bir karalama defteri ve not uygulaması. Notlar cihazınızda şifrelenir; sizden başka kimse okuyamaz.',
  'meta.downloadTitle': 'AnkyLock’u indirin',
  'meta.downloadDescription': 'AnkyLock’u Linux için AppImage, .deb veya .rpm paketi olarak, SHA-256 özetleriyle indirin.',

  'nav.skip': 'İçeriğe geç',
  'nav.back': 'Ana sayfa',
  'nav.home': 'AnkyLock ana sayfa',
  'nav.download': 'İndir',
  'nav.github': 'GitHub',
  'nav.openApp': 'AnkyLock’a git',
  'nav.main': 'Ana menü',

  'logo.toggle': 'Logonun kilidini aç veya kilitle',

  'hero.title': 'Yalnızca sizin okuyabildiğiniz notlar.',
  'hero.lead':
    'AnkyLock, geliştiriciler için yerel öncelikli, uçtan uca şifreli bir karalama defteri ve not uygulaması. Notlarınız cihazınızda, yalnızca parolanızın üretebildiği bir anahtarla şifrelenir.',
  'hero.download': 'İndir',
  'hero.github': 'GitHub’da incele',
  'hero.note': 'Ücretsiz ve açık kaynak. Bizde hesap yok, takip yok.',

  'features.title': 'Neler yapar',
  'features.scratchpad.title': 'Kendini kaydeden bir karalama defteri',
  'features.scratchpad.text': 'Bir sekme açın ve yazın. Her sekme siz yazarken kaydedilir, ilk satırı da başlığı olur.',
  'features.organize.title': 'Klasörler, kategoriler, Arşiv ve Çöp Kutusu',
  'features.organize.text': 'Üç seviyeye kadar klasörler, kendi kategorileriniz ve 28 gün sonra kendini boşaltan bir Çöp Kutusu.',
  'features.sync.title': 'Kendi Google Drive’ınız üzerinden eşitleme',
  'features.sync.text':
    'Her kasa, şifrelenmiş olarak Drive’ınızdaki gizli bir uygulama klasörüne yedeklenir. Diğer cihazlarınız birkaç dakika içinde birleştirir; iki cihazda aynı anda yapılan düzenlemelerin ikisi de korunur.',
  'features.offline.title': 'Çevrimdışı çalışır',
  'features.offline.text': 'Her şey önce cihazınızda durur. Eşitleme ve yedekleme arka planda çalışır, yazmanızı hiç bekletmez.',
  'features.vaults.title': 'Ayrı kasalar',
  'features.vaults.text': 'İş ve kişisel notlarınızı ayrı tutun; her kasanın kendi parolası ve anahtarı olur.',
  'features.export.title': 'Notlarınız, dosyalarınız',
  'features.export.text':
    'Bir notu, bir klasörü ya da bütün bir kasayı istediğiniz an düz metin olarak dışa aktarın; isterseniz AES-256 korumalı bir zip içinde.',
  'features.editor.title': 'Kod ve hızlı notlar için',
  'features.editor.text':
    'JetBrains Mono ile bir kod editörü: Tab ile girinti, satır kaydırma ve tıklanabilir linkler. Açık ve koyu tema, Türkçe ve İngilizce.',
  'features.screenshot': 'Koyu temada AnkyLock çalışma alanı: solda klasörler, editörde açık bir not.',

  'how.title': 'Nasıl çalışır',
  'how.lead': 'Şifreleme, hiçbir şey kaydedilmeden ya da gönderilmeden önce cihazınızda yapılır.',
  'how.passphrase.title': 'Parolanız',
  'how.passphrase.text': 'Bir kasa oluştururken siz seçersiniz. Hiçbir yerde saklanmaz, hiçbir yere gönderilmez.',
  'how.key.title': 'Anahtarınız',
  'how.key.text':
    'Kasa anahtarını her kilit açılışında cihazınız paroladan üretir (PBKDF2-SHA-256, 600.000 tekrar). Anahtar yalnızca bellekte durur.',
  'how.encrypt.title': 'Cihazınızda şifrelenir',
  'how.encrypt.text': 'Notlar, başlıklar ve klasör adları, kaydedilmeden ya da cihazdan çıkmadan önce AES-256-GCM ile şifrelenir.',
  'how.drive.title': 'Google Drive yalnızca şifreli veri tutar',
  'how.drive.text': 'Drive’ınız okuyamadığı şifreli dosyaları saklar. Yeni bir cihaz onları yalnızca parolanızla açabilir.',

  'promise.title': 'AnkyLock’un sözleri',
  'promise.nobody': 'Notlarınızı sizden başka kimse okuyamaz: ne Google, ne bir aktarıcı sunucu (relay), ne de biz.',
  'promise.key': 'Anahtarınız cihazınızdan hiç çıkmaz ve hiçbir zaman Google hesabınızdan türetilmez.',
  'promise.tracking': 'Bizde hesap yok; analiz, reklam ve takip aracı yok.',
  'promise.open': 'Verinize dokunan her şey açık kaynak, AGPL-3.0 lisansıyla.',
  'limits.title': 'Neleri yapmaz',
  'limits.recovery':
    'Unutulan bir parolayı geri getiremez. Bilerek bir sıfırlama linki yok: parola olmadan notlar kilitli kalır.',
  'limits.device': 'Kilidi açık bir cihazı kötü amaçlı yazılımlara karşı, notlarınızı da parolanızı bilen birine karşı koruyamaz.',
  'limits.metadata':
    'Notlarınızda ne yazdığını gizler, var olduklarını değil: Google şifreli yedeklerinizin boyutunu ve zamanlamasını görür.',
  'limits.more': 'Tehdit modelini ve güvenlik incelemesini okuyun',

  'open.title': 'Açık kaynak',
  'open.text':
    'AnkyLock, GNU AGPL-3.0 lisanslı özgür bir yazılım. Kodu okuyun, kendiniz derleyin ya da bir güvenlik sorununu gizlice bildirin.',
  'open.source': 'Kaynak kodu',
  'open.threatModel': 'Tehdit modeli',
  'open.review': 'Güvenlik incelemesi',
  'open.report': 'Güvenlik açığı bildirin',

  'download.title': 'AnkyLock’u indirin',
  'download.lead': 'Linux için masaüstü uygulaması. Tarayıcıyı mı tercih edersiniz? AnkyLock, hiçbir şey kurmadan web’de de çalışır.',
  'download.version': 'Sürüm {version}, {date} tarihinde yayımlandı.',
  'download.none': 'İlk sürüm yolda. O zamana kadar web uygulamasını kullanabilir ya da AnkyLock’u kaynak kodundan derleyebilirsiniz.',
  'download.buildFromSource': 'Kaynak kodundan derleyin',
  'download.button': 'İndir',
  'download.file': '{file} dosyasını indir',
  'download.checksum': 'SHA-256',
  'download.appimage.text': 'Çoğu dağıtımda kurulum gerektirmeden çalışır ve kendini günceller.',
  'download.deb.text': 'Debian, Ubuntu, Linux Mint ve Debian tabanlı diğer dağıtımlar için.',
  'download.rpm.text': 'Fedora, openSUSE ve RPM tabanlı diğer dağıtımlar için.',
  'download.install': 'Kurulum',
  'download.install.appimage': 'AppImage dosyasını çalıştırılabilir yapın, sonra çalıştırın:',
  'download.install.deb': 'Paketi apt ile kurun:',
  'download.install.rpm': 'Paketi dnf ile kurun (openSUSE’de zypper ile):',
  'download.verify.title': 'İndirdiğiniz dosyayı doğrulayın',
  'download.verify.text':
    'Dosyanın SHA-256 özetini yukarıdakiyle karşılaştırın ya da dosyanın bu depodan GitHub Actions ile derlendiğini GitHub CLI ile kontrol edin:',
  'download.other.title': 'Windows ve macOS',
  'download.other.text': 'Daha sonra gelecek. O zamana kadar kaynak kodundan derleyebilirsiniz; README nasıl yapılacağını anlatıyor.',

  'notFound.title': 'Sayfa bulunamadı',
  'notFound.text': 'Bu adreste bir şey yok. Taşınmış olabilir ya da link yanlış yazılmış olabilir.',
  'notFound.home': 'Ana sayfaya git',

  'footer.privacy': 'Gizlilik',
  'footer.terms': 'Kullanım şartları',
  'footer.license': 'AGPL-3.0',
  'footer.englishOnly': '(İngilizce)',
  'footer.language': 'Dil',
  'footer.theme': 'Tema',

  'theme.system': 'Sistem',
  'theme.light': 'Açık',
  'theme.dark': 'Koyu',
};
