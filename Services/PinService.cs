using System.Security.Cryptography;
using System.Text;

namespace BabyMonitor.Services;

/// <summary>
/// PIN doğrulama ve çerez sürümü. PIN her çağrıda yapılandırmadan okunur;
/// user-secrets değişince yeniden başlatmadan geçerli olur.
/// </summary>
public sealed class PinService
{
    public const string ConfigKey = "Security:Pin";
    public const string VersionClaimType = "pin_version";

    private readonly IConfiguration _configuration;

    public PinService(IConfiguration configuration)
    {
        _configuration = configuration;
    }

    private string? CurrentPin
    {
        get
        {
            var pin = _configuration[ConfigKey];
            return string.IsNullOrEmpty(pin) ? null : pin;
        }
    }

    public bool IsConfigured => CurrentPin is not null;

    /// <summary>
    /// Geçerli PIN'den türetilen sürüm değeri; çereze yazılır. PIN değişince eski çerezler geçersiz olur.
    /// PIN ayarlı değilse null.
    /// </summary>
    public string? CurrentVersion
    {
        get
        {
            var pin = CurrentPin;
            if (pin is null)
                return null;
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes("BabyMonitor.PinVersion:" + pin));
            return Convert.ToHexString(hash, 0, 16);
        }
    }

    public bool Verify(string? candidate)
    {
        var pin = CurrentPin;
        if (pin is null || candidate is null)
            return false;

        // Sabit uzunluklu hash'ler karşılaştırılır; PIN uzunluğu da zamanlamadan sızmaz.
        var expected = SHA256.HashData(Encoding.UTF8.GetBytes(pin));
        var actual = SHA256.HashData(Encoding.UTF8.GetBytes(candidate));
        return CryptographicOperations.FixedTimeEquals(expected, actual);
    }
}

/// <summary>Çerez olmadan erişilebilen yollar.</summary>
public static class AccessPaths
{
    public const string PinPage = "/pin.html";

    private static readonly HashSet<string> PublicFiles = new(StringComparer.OrdinalIgnoreCase)
    {
        PinPage,
        "/js/pin.js",
        "/css/app.css",
        // "Ana ekrana ekle": tarayıcı manifest'i ve ikonları çerezsiz ister.
        "/manifest.json",
        "/icons/icon-192.png",
        "/icons/icon-512.png",
        "/icons/apple-touch-icon.png"
    };

    public static bool IsPublicFile(PathString path) =>
        path.HasValue && PublicFiles.Contains(path.Value!);

    /// <summary>Tarayıcı sayfası değil; yetkisizse yönlendirme yerine 401 döner.</summary>
    public static bool IsApiOrHub(PathString path) =>
        path.StartsWithSegments("/api") || path.StartsWithSegments("/hubs");
}
