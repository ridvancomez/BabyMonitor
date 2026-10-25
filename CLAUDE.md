# CLAUDE.md — BabyMonitor (WebRTC Bebek Kamerası)

## Proje Özeti
Yerel ağda (aynı Wi-Fi) çalışan bebek izleme web uygulaması.
- **Yayıncı (bebek telefonu):** Kamera + mikrofon sürekli açık, kesintisiz yayın yapar.
- **İzleyici (ebeveyn telefonu):** Görüntüyü izler, sesi dinler. En fazla **2 izleyici**.
- Tek yönlü akış: izleyiciler kamera/mikrofon açmaz, geri ses göndermez. Bas-konuş yok.

## Teknoloji
- **Backend:** ASP.NET Core (.NET 8+), minimal hosting
- **Signaling:** SignalR (Hub) — sadece bağlantı kurulumu mesajları
- **Medya:** WebRTC — görüntü/ses peer-to-peer akar, sunucudan geçmez
- **Frontend:** Düz HTML + CSS + vanilla JS (framework yok)
- **SignalR client:** `@microsoft/signalr` (wwwroot/lib altında)
- Veritabanı yok.

## Mimari
```
                    ┌──(SignalR signaling)── ASP.NET Core Hub ──(SignalR)──┐
                    │                                                     │
Yayıncı (bebek) ════ WebRTC #1 (sadece gönderir) ════> İzleyici 1 (ebeveyn)
       ║
       ╚═══════════ WebRTC #2 (sadece gönderir) ════> İzleyici 2
```
- Yayıncı, **her izleyici için ayrı** `RTCPeerConnection` tutar (`Map<connectionId, RTCPeerConnection>`).
- Aynı `MediaStream` track'leri her bağlantıya eklenir.
- Offer'ı **yayıncı** oluşturur. İzleyici sadece answer döner.
- İzleyici tarafı: `addTransceiver('video'|'audio', { direction: 'recvonly' })` gerekmez; offer yayıncıdan geldiği için answer yeterli.

### Hub sözleşmesi (`MonitorHub`)
Tek oda varsayılır (ileride oda kodu eklenebilir).

| Metot (client → server) | Açıklama |
|---|---|
| `JoinAsBroadcaster()` | Yayıncı olarak kaydol. Zaten yayıncı varsa reddet. Bekleyen izleyiciler varsa her biri için yayıncıya `ViewerJoined(viewerId)` |
| `JoinAsViewer()` | İzleyici olarak kaydol. 2 izleyici doluysa `RoomFull` dön. Yayıncı varsa ona `ViewerJoined(viewerId)` |
| `SendOffer(string viewerId, string sdp)` | Yayıncı → belirli izleyiciye `ReceiveOffer(broadcasterId, sdp)` (izleyici ICE hedefini buradan öğrenir) |
| `SendAnswer(string sdp)` | İzleyici → yayıncıya `ReceiveAnswer(viewerId, sdp)` |
| `SendIce(string targetId, string candidate)` | Hedefe `ReceiveIce(fromId, candidate)` |

Bağlantı kopması (`OnDisconnectedAsync`):
- İzleyici düşerse → yayıncıya `ViewerLeft(viewerId)`, yayıncı o bağlantıyı kapatır.
- Yayıncı düşerse → tüm izleyicilere `BroadcasterLeft`.

Durum sunucuda bellekte tutulur (statik/singleton, thread-safe).

## Klasör Yapısı (hedef)
```
BabyMonitor/
├─ Program.cs
├─ Hubs/MonitorHub.cs
├─ Services/RoomState.cs      # yayıncı + izleyici listesi (singleton)
├─ wwwroot/
│  ├─ index.html              # rol seçimi: "Bebek Kamerası" / "İzle"
│  ├─ broadcaster.html
│  ├─ viewer.html
│  ├─ css/app.css
│  ├─ js/signaling.js         # ortak SignalR bağlantısı
│  ├─ js/broadcaster.js
│  ├─ js/viewer.js
│  └─ lib/signalr/
└─ CLAUDE.md
```

## Yerel Ağ / HTTPS Kuralları
- Telefonlar `localhost` olmadığından **HTTPS zorunlu** (yayıncıda getUserMedia secure context ister).
- Kestrel LAN'da dinlemeli: `https://0.0.0.0:5001`
- Sertifika: .NET dev sertifikası (telefonda uyarıyı geç) veya mkcert kök sertifikası telefona yüklenir.
- Windows Firewall'da 5001 portu açık olmalı.
- Aynı Wi-Fi'de STUN/TURN gerekmez. `iceServers: []` ile başla.

## Mobil Kuralları
**Yayıncı:**
- `getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true } })`
  - Yankı engelleme / gürültü bastırma kapalı: izleyiciden bebeğe ses gitmiyor; bastırma bebeğin hafif seslerini de siler.
  - Mikrofon öz-denetimi: başlatınca yerel mikrofon Web Audio ile ~3 sn ölçülür; tamamen sessizse `echoCancellation/noiseSuppression: true` ile yeniden açılır ve `replaceTrack` ile tüm bağlantılarda değiştirilir.
  - Bulgu (gerçek cihazda doğrulandı): Xiaomi Mi Note 10 Lite + Chrome, EC/NS kapalıyken mikrofondan sessiz veri veriyor; otomatik işlenmiş moda geçiş sorunu çözüyor.
  - `exact` kullanma: arka kamerası olmayan cihazda `OverconstrainedError` verir; `ideal` ile ön kameraya düşer.
- Yayın bir kullanıcı dokunuşuyla başlar ("Yayını Başlat").
- Ekran açık kalsın: Wake Lock API (destek yoksa sessizce geç). Ekran kilitlenirse yayın durur — kullanıcıya uyarı göster.
- Yerel önizleme `muted` olmalı (yankı olmasın).
- Kamera çevirme: `facingMode` değiştir, `replaceTrack` ile tüm bağlantılarda güncelle.

**İzleyici:**
- `<video autoplay playsinline>` (iOS için `playsinline` şart).
- Ses için izlemeyi bir dokunuşla başlat ("Sesi Aç") — autoplay kısıtları.
- Ses yükseltme (Web Audio): gelen stream → `GainNode` → `DynamicsCompressorNode` → çıkış. "Ses yükseltme" sürgüsü 1x–5x (varsayılan 2x), `localStorage`'da hatırlanır (try/catch).
  - `<video>` her zaman `muted` kalır (ses iki kez çalmasın); ama stream'e bağlı kalır — Chrome uzak WebRTC sesini ancak stream bir media elemanına bağlıyken Web Audio'ya akıtır.
  - `AudioContext` "Sesi Aç" dokunuşunda oluşturulur/resume edilir; arka plandan dönünce yeniden resume denenir.
  - Web Audio yoksa ya da başarısızsa: `<video>` sesi açılır (yükseltmesiz).
  - Otomatik yedek (sürekli, 3 sn pencere): paketler geliyor + yayıncı seviyesi duyulur (`getSynchronizationSources().audioLevel`) + Web Audio çıkışı tamamen sessiz → `<video>` sesine dön, sürgüyü gizle. Yayıncı sessizse karar verilmez.
  - Not: Chrome `getStats` `audioLevel`/`totalAudioEnergy` değerlerini sadece ses bir media elemanından sesli çalınırken ölçer; muted `<video>` iken 0'dır. Bu yüzden "yayıncı ses gönderiyor mu" için RTP seviyesi kullanılır.- Wake Lock burada da faydalı.
- Yayıncı yoksa / düşerse "Yayın bekleniyor…" durumu göster.

## Erişim Koruması (PIN)
Aynı Wi-Fi'deki yabancı cihazların yayını izlemesini engellemek için basit PIN koruması.
- PIN **kullanıcı tarafından belirlenir**; Claude PIN değeri üretmez, koda veya dosyaya gerçek PIN yazmaz.
- Ayar anahtarı: `Security:Pin`
  - `appsettings.json` içinde alan boş bırakılır: `"Security": { "Pin": "" }`
  - Gerçek değer `dotnet user-secrets set "Security:Pin" "<PIN>"` ile verilir (repoya girmez).
  - PIN boşsa uygulama başlarken konsola açık bir uyarı yazar ve tüm girişleri reddeder.
- Akış:
  - PIN'i olmayan istek → `pin.html` sayfasına yönlendirilir.
  - `POST /api/unlock` ile PIN doğrulanır → başarılıysa uzun ömürlü (ör. 90 gün) `HttpOnly`, `Secure`, `SameSite=Strict` çerez verilir.
  - Çerez imzalı olmalı (ASP.NET Core Data Protection / Cookie Authentication kullan, elle token üretme).
  - `MonitorHub` `[Authorize]` ile korunur; çerezi olmayan SignalR'a bağlanamaz.
  - PIN karşılaştırması sabit zamanlı yapılır (`CryptographicOperations.FixedTimeEquals`).
  - Basit deneme sınırı: aynı IP'den art arda 5 yanlış denemede 1 dakika bekletme.
- Kayıtlı cihaz listesi / cihaz silme **yok** (kapsam dışı). PIN değişince eski çerezler geçersiz olmalı (çereze PIN'in hash'inden türetilmiş bir sürüm değeri koy, doğrulamada karşılaştır).

## Geliştirme Aşamaları
1. [x] Boş ASP.NET Core projesi, statik dosyalar, HTTPS + LAN dinleme
2. [x] `RoomState` + `MonitorHub` (roller, 2 izleyici limiti, kopma durumları)
3. [x] Rol seçim sayfası + yayıncıda kamera/mikrofon önizleme
4. [x] WebRTC akışı: yayıncı → 1 izleyici
5. [x] Çoklu izleyici (2 bağlantı), izleyici giriş/çıkışları
6. [x] PIN koruması (yukarıdaki "Erişim Koruması" bölümü)
7. [x] Mobil cilalama: Wake Lock, kamera çevirme, yeniden bağlanma, durum mesajları, "Ana ekrana ekle" için manifest, Yayını Durdur butonu (hub'dan çık, kamerayı kapat, yeri hemen boşalt)
8. [x] Dağıtım paketi: .NET kurulu olmayan Windows laptop için tek exe (aşağıdaki "Dağıtım" bölümü)
9. [x] Mikrofon hassasiyeti: yayıncıda ses işleme ayarları, izleyicide Web Audio ile ses yükseltme sürgüsü ("Mobil Kuralları")

## Dağıtım (başka Windows laptop)
- Yayın: `dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o publish`
- `publish/` klasörü taşınır; laptopta .NET/VS gerekmez.
- Ayarlar: exe'nin yanındaki **opsiyonel** `appsettings.Local.json` (exe'ye gömülmez, düzenlenebilir). `Security:Pin` ve sertifika (`Kestrel:Endpoints:Https:Certificate`) buraya yazılır.
  - Repoda ve publish'te sadece şablon: `appsettings.Local.example.json`. Gerçek `appsettings.Local.json` asla publish'e kopyalanmaz.
- Sertifika: dev sertifikası parolalı `.pfx` olarak dışa aktarılır (`tools/export-cert.ps1`, parolayı kullanıcı girer). `.pfx` ve parolası repoya girmez.
- Content root, exe'nin yanında `wwwroot` varsa exe klasörüdür (Görev Zamanlayıcı başka çalışma klasörüyle başlatsa da çalışır).
- Kurulum belgeleri ve scriptler `deploy/` altında tutulur, publish sırasında klasörün köküne kopyalanır: `KURULUM.md`, `otomatik-baslat-kur.ps1`, `otomatik-baslat-kaldir.ps1`.
- Geliştirme akışı değişmez: bu bilgisayarda `dotnet run` + user-secrets + dev sertifikası.

## Çalışma Tercihleri (Claude için)
- Arayüz ve yorum dili Türkçe; kod isimlendirmesi İngilizce.
- Adım adım ilerle; her seferinde sadece istenen aşamaya odaklan.
- Mevcut çalışan kodu baştan yazma; sadece gereken eklemeleri/değişiklikleri göster.
- Medyayı asla SignalR üzerinden gönderme — SignalR sadece signaling içindir.
- Harici JS framework veya ek NuGet paketi eklemeden önce sor.
