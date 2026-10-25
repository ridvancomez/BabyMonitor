# BabyMonitor

Yerel ağda (aynı Wi-Fi) çalışan, WebRTC tabanlı bebek izleme web uygulaması. Bebek tarafındaki telefon kamera/mikrofonu sürekli yayınlar; en fazla 2 ebeveyn telefonu aynı anda izleyebilir. Medya (görüntü/ses) sunucudan geçmez — doğrudan peer-to-peer akar; sunucu sadece WebRTC bağlantı kurulumunu (signaling) yönetir.

## Teknoloji Stack

- ASP.NET Core (.NET 8+, minimal hosting)
- SignalR — sadece signaling (offer/answer/ICE mesajları)
- WebRTC — peer-to-peer görüntü/ses akışı
- Vanilla JS + HTML/CSS (framework yok)

## Mimari

```
                    ┌──(SignalR signaling)── ASP.NET Core Hub ──(SignalR)──┐
                    │                                                     │
Yayıncı (bebek) ════ WebRTC #1 (sadece gönderir) ════> İzleyici 1 (ebeveyn)
       ║
       ╚═══════════ WebRTC #2 (sadece gönderir) ════> İzleyici 2
```

Yayıncı her izleyici için ayrı bir `RTCPeerConnection` tutar; offer'ı yayıncı oluşturur, izleyici sadece answer döner.

### MonitorHub (SignalR sözleşmesi)

| Metot | Açıklama |
|---|---|
| `JoinAsBroadcaster()` | Yayıncı olarak kaydolur |
| `JoinAsViewer()` | İzleyici olarak kaydolur (2 izleyici limiti) |
| `SendOffer` / `SendAnswer` / `SendIce` | WebRTC signaling mesajları |

## Güvenlik

- Erişim, kullanıcı tarafından belirlenen bir PIN ile korunur (`dotnet user-secrets` üzerinden verilir, repoda tutulmaz).
- PIN doğrulandıktan sonra imzalı, `HttpOnly`/`Secure`/`SameSite=Strict` bir çerez verilir; `MonitorHub` bu çerez olmadan erişilemez.
- PIN karşılaştırması sabit zamanlı yapılır; başarısız denemelerde kısa süreli bekletme uygulanır.

## Yerel Ağ / HTTPS

Telefonlar `localhost` olmadığı için HTTPS zorunlu (getUserMedia secure context ister). Kestrel LAN'da dinler, aynı Wi-Fi'de STUN/TURN gerekmez.

## Kurulum

```bash
git clone https://github.com/ridvancomez/BabyMonitor.git
cd BabyMonitor
dotnet restore
dotnet user-secrets set "Security:Pin" "<PIN>"
dotnet run
```

Taşınabilir dağıtım için: `dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o publish`

## Durum

🚧 Aktif geliştirme aşamasında.
