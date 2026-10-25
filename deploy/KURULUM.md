# Bebek Monitörü — Laptop Kurulumu

Bu klasör, .NET veya Visual Studio kurulu olmayan bir Windows 10/11 (64 bit) bilgisayarda çalışır.
Laptop ve telefonlar **aynı Wi-Fi ağında** olmalı.

Klasörde olması gerekenler:

| Dosya | Ne işe yarar |
|---|---|
| `BabyMonitor.exe` | Sunucu (tek dosya) |
| `wwwroot\` | Web sayfaları |
| `appsettings.json` | Temel ayarlar (dokunma) |
| `appsettings.Local.example.json` | Kendi ayar dosyan için şablon |
| `babymonitor.pfx` | HTTPS sertifikası (ana bilgisayarda `tools\export-cert.ps1` ile üretilir) |
| `otomatik-baslat-kur.ps1` / `otomatik-baslat-kaldir.ps1` | Oturum açılınca otomatik başlatma |

---

## 1. Klasörü kopyala

Klasörün tamamını laptopta kalıcı bir yere kopyala, örneğin:

```
C:\BabyMonitor
```

`C:\Program Files` altına koyma (dosyaları düzenlemek yönetici izni ister).

Klasörü zip olarak indirdiysen, açmadan önce zip'e sağ tık > **Özellikler** > **Engellemeyi kaldır**.

## 2. Sertifikayı kontrol et

`babymonitor.pfx` klasörde olmalı. Yoksa ana bilgisayarda proje klasöründe şunu çalıştır ve oluşan dosyayı bu klasöre kopyala:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\export-cert.ps1
```

Orada belirlediğin parolayı bir sonraki adımda kullanacaksın.

## 3. Ayar dosyasını oluştur ve doldur

`appsettings.Local.example.json` dosyasını aynı klasöre **`appsettings.Local.json`** adıyla kopyala ve Not Defteri ile aç:

```json
{
  "Security": {
    "Pin": "<telefonlarda gireceğin PIN>"
  },
  "Kestrel": {
    "Endpoints": {
      "Https": {
        "Certificate": {
          "Path": "babymonitor.pfx",
          "Password": "<export-cert.ps1'de belirlediğin parola>"
        }
      }
    }
  }
}
```

- PIN boş kalırsa sunucu açılır ama **hiçbir girişe izin vermez**.
- PIN'i değiştirirsen telefonlardaki eski girişler geçersiz olur; PIN'i yeniden girmen gerekir.
- Bu dosyayı kimseyle paylaşma.

## 4. Güvenlik duvarında 5001 portunu aç

**Yönetici olarak** açılmış PowerShell'de (Başlat > "PowerShell" > sağ tık > Yönetici olarak çalıştır):

```powershell
New-NetFirewallRule -DisplayName "BabyMonitor 5001" -Direction Inbound -Protocol TCP -LocalPort 5001 -Action Allow -Profile Private
```

## 5. Wi-Fi ağını "Özel" yap

Güvenlik duvarı kuralı sadece **Özel** ağlarda geçerli.

- **Ayarlar** > **Ağ ve İnternet** > **Wi-Fi** > bağlı ağın özellikleri > **Ağ profili türü: Özel**

veya yönetici PowerShell'de:

```powershell
Get-NetConnectionProfile                                   # ağ adını (InterfaceAlias) gör
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private
```

## 6. Uyku modunu kapat

Laptop uyursa yayın kesilir. Yönetici PowerShell'de:

```powershell
powercfg /change standby-timeout-ac 0      # prizdeyken asla uyuma
powercfg /change hibernate-timeout-ac 0    # prizdeyken asla hazırda bekleme
```

Kapağı kapatınca uyumasın istiyorsan (prizdeyken):

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
```

Laptopu prize takılı tut. Ekranın kapanması sorun değil; sadece uyku sorun.

## 7. Çalıştır

`BabyMonitor.exe`'ye çift tıkla. Siyah bir konsol penceresi açılır ve şuna benzer bir satır görünür:

```
Now listening on: https://0.0.0.0:5001
```

- **"Windows kişisel bilgisayarınızı korudu"** uyarısı çıkarsa: **Ek bilgi** > **Yine de çalıştır**.
- **Güvenlik duvarı izni** sorulursa: **Özel ağlar** işaretli olsun, **İzin ver**.
- Pencere **açık kalmalı**; kapatırsan sunucu durur.
- Pencerede `*** SUNUCU BAŞLATILAMADI ***` yazıyorsa aşağıdaki "Sorun giderme" bölümüne bak.

## 8. Telefondan bağlan

1. Laptopun IP adresini bul (PowerShell ya da Komut İstemi):
   ```
   ipconfig
   ```
   Wi-Fi bölümündeki **IPv4 Adresi**'ni not et (ör. `192.168.1.50`).
2. Telefonda tarayıcıda aç: `https://192.168.1.50:5001`
3. Sertifika uyarısı çıkar (sertifika bu ağa özel, tanınmıyor):
   - Chrome (Android): **Gelişmiş** > **… sitesine ilerle**
   - Safari (iPhone): **Ayrıntıları Göster** > **bu web sitesini ziyaret et**
4. PIN'i gir. Telefon 90 gün hatırlar.
5. Bebek telefonunda **Bebek Kamerası** > **Yayını Başlat**; ebeveyn telefonunda **İzle**.
6. İstersen tarayıcı menüsünden **Ana ekrana ekle**. (iPhone'da ana ekrandan açılan uygulama PIN'i bir kez daha ister.)

> **İpucu:** Laptopun IP adresi değişebilir. Modem arayüzünde laptop için "sabit IP / DHCP rezervasyonu" yaparsan adres hep aynı kalır.

## 9. (İsteğe bağlı) Oturum açılınca otomatik başlat

Klasörde **yönetici** PowerShell açıp:

```powershell
cd C:\BabyMonitor
powershell -ExecutionPolicy Bypass -File .\otomatik-baslat-kur.ps1
```

Artık laptopa oturum açınca sunucu kendiliğinden başlar (konsol penceresi açılır, kapatma).
Hemen başlatmak için: `Start-ScheduledTask -TaskName BabyMonitor`

Kaldırmak için (görevi siler, çalışan sunucuyu kapatır):

```powershell
powershell -ExecutionPolicy Bypass -File .\otomatik-baslat-kaldir.ps1
```

> Otomatik başlatma **oturum açılınca** çalışır. Laptop yeniden başlarsa oturum açman gerekir
> (Windows'ta otomatik oturum açma ayrı bir ayardır).

---

## Sorun giderme

| Belirti | Çözüm |
|---|---|
| Konsolda `PIN AYARLANMAMIŞ` uyarısı | `appsettings.Local.json` yok, adı yanlış ya da `Pin` boş. Adın `.json.txt` olmadığından emin ol (Dosya Gezgini > Görünüm > Dosya adı uzantıları). |
| `SUNUCU BAŞLATILAMADI` + parola / sertifika hatası | `babymonitor.pfx` klasörde değil ya da `Password` yanlış. |
| `SUNUCU BAŞLATILAMADI` + adres kullanımda | 5001'i başka bir program kullanıyor ya da sunucu zaten açık (otomatik başlatma). |
| Telefonda sayfa hiç açılmıyor | Aynı Wi-Fi'de misin? Adım 4 ve 5'i kontrol et. IP değişmiş olabilir (`ipconfig`). |
| "Çok fazla yanlış deneme" | Art arda 5 yanlış PIN: 1 dakika bekle. |
| Görüntü var, ses yok | İzleyicide **Sesi Aç**'a dokun. |

## Güncelleme

Yeni sürümde klasördeki dosyaları değiştir; **`appsettings.Local.json` ve `babymonitor.pfx`'i koru**.
Önce sunucuyu kapat (pencereyi kapat ya da `otomatik-baslat-kaldir.ps1`).

## Sertifikanın süresi

Sertifikanın bitiş tarihi `export-cert.ps1` çalışınca yazılır. Süresi dolunca ana bilgisayarda
yeniden dışa aktar ve `babymonitor.pfx`'i değiştir (parola değişirse `appsettings.Local.json`'u da güncelle).
