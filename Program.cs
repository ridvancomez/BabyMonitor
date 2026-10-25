using System.Security.Claims;
using BabyMonitor.Hubs;
using BabyMonitor.Services;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authorization;

// Dağıtılan exe (publish): wwwroot exe'nin yanındadır. Görev Zamanlayıcı farklı bir çalışma klasörüyle
// başlatsa da dosyalar bulunsun diye content root exe klasörü olur. Geliştirmede (dotnet run) varsayılan kalır.
var exeDirectory = AppContext.BaseDirectory;
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = Directory.Exists(Path.Combine(exeDirectory, "wwwroot")) ? exeDirectory : null
});
// Kestrel uç noktası appsettings.json > "Kestrel" bölümünden okunur (https://0.0.0.0:5001).

// PIN user-secrets'tan gelir. Varsayılan olarak sadece Development'ta yüklendiği için diğer ortamlarda da ekle.
if (!builder.Environment.IsDevelopment())
    builder.Configuration.AddUserSecrets<Program>(optional: true, reloadOnChange: true);

// Laptop kurulumu: exe'nin yanındaki düzenlenebilir ayar dosyası (PIN, sertifika yolu/parolası). Opsiyonel; en son eklenir, öncelikli.
builder.Configuration.AddJsonFile(
    Path.Combine(exeDirectory, "appsettings.Local.json"), optional: true, reloadOnChange: true);

builder.Services.AddSignalR();
builder.Services.AddSingleton<RoomState>();
builder.Services.AddSingleton<PinService>();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<UnlockAttemptLimiter>();

builder.Services
    .AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme)
    .AddCookie(options =>
    {
        // Çerez Data Protection ile şifrelenip imzalanır.
        options.Cookie.Name = "BabyMonitor.Auth";
        options.Cookie.HttpOnly = true;
        options.Cookie.SecurePolicy = CookieSecurePolicy.Always;
        options.Cookie.SameSite = SameSiteMode.Strict;
        options.ExpireTimeSpan = TimeSpan.FromDays(90);
        options.LoginPath = AccessPaths.PinPage;
        options.ReturnUrlParameter = "returnUrl";

        options.Events.OnRedirectToLogin = context =>
        {
            // Hub/API istemcileri yönlendirmeyi izleyemez; açık 401 dön.
            if (AccessPaths.IsApiOrHub(context.Request.Path))
                context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            else
                context.Response.Redirect(context.RedirectUri);
            return Task.CompletedTask;
        };

        // PIN değiştiyse (ya da silindiyse) eski çerezler geçersiz.
        options.Events.OnValidatePrincipal = async context =>
        {
            var pins = context.HttpContext.RequestServices.GetRequiredService<PinService>();
            var currentVersion = pins.CurrentVersion;
            var cookieVersion = context.Principal?.FindFirstValue(PinService.VersionClaimType);
            if (currentVersion is null || cookieVersion != currentVersion)
            {
                context.RejectPrincipal();
                await context.HttpContext.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            }
        };
    });

builder.Services.AddAuthorization(options =>
{
    // Varsayılan: her istek (statik dosyalar dahil) çerez ister; sadece PIN sayfası ve onun dosyaları açık.
    options.FallbackPolicy = new AuthorizationPolicyBuilder()
        .RequireAssertion(context =>
            context.User.Identity?.IsAuthenticated == true ||
            (context.Resource is HttpContext http && AccessPaths.IsPublicFile(http.Request.Path)))
        .Build();
});

var app = builder.Build();

if (!app.Services.GetRequiredService<PinService>().IsConfigured)
{
    app.Logger.LogWarning(
        "\n*** UYARI: PIN AYARLANMAMIŞ — tüm girişler reddediliyor. ***\n" +
        "*** Ayarlamak için: dotnet user-secrets set \"{Key}\" \"<PIN>\" ***",
        PinService.ConfigKey);
}

app.UseAuthentication();
// Statik dosyalar yetkilendirmeden sonra: sayfalar da çerezsiz açılmaz.
app.UseAuthorization();

// wwwroot altındaki statik dosyalar; "/" isteği index.html'e yönlenir.
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapPost("/api/unlock", async (UnlockRequest request, HttpContext http, PinService pins, UnlockAttemptLimiter limiter) =>
{
    var version = pins.CurrentVersion;
    if (version is null)
        return Results.Problem("Sunucuda PIN ayarlanmamış.", statusCode: StatusCodes.Status503ServiceUnavailable);

    var clientKey = http.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    if (limiter.GetLockoutRemaining(clientKey) is { } remaining)
        return TooManyAttempts(http, remaining);

    if (!pins.Verify(request.Pin))
    {
        return limiter.RecordFailure(clientKey) is { } lockout
            ? TooManyAttempts(http, lockout)
            : Results.Unauthorized();
    }

    limiter.Reset(clientKey);
    var identity = new ClaimsIdentity(
        [new Claim(PinService.VersionClaimType, version)],
        CookieAuthenticationDefaults.AuthenticationScheme);
    await http.SignInAsync(
        CookieAuthenticationDefaults.AuthenticationScheme,
        new ClaimsPrincipal(identity),
        new AuthenticationProperties { IsPersistent = true });
    return Results.NoContent();
}).AllowAnonymous();

// Sadece signaling; medya WebRTC ile peer-to-peer akar. [Authorize] hub üzerinde.
app.MapHub<MonitorHub>("/hubs/monitor");

try
{
    app.Run();
}
catch (Exception ex)
{
    // Çift tıklamayla açılan pencere hemen kapanmasın; hata okunabilsin (en fazla 60 sn bekler).
    Console.Error.WriteLine();
    Console.Error.WriteLine("*** SUNUCU BAŞLATILAMADI ***");
    Console.Error.WriteLine(ex.Message);
    Console.Error.WriteLine("Sık nedenler: sertifika dosyası/parolası yanlış (appsettings.Local.json) ya da 5001 portu başka bir programda.");
    WaitForKeyOrTimeout(TimeSpan.FromSeconds(60));
    throw;
}

static void WaitForKeyOrTimeout(TimeSpan timeout)
{
    try
    {
        Console.Error.WriteLine("Kapatmak için bir tuşa bas…");
        var until = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < until && !Console.KeyAvailable)
            Thread.Sleep(200);
    }
    catch (InvalidOperationException)
    {
        // Konsol yok (yönlendirilmiş çıktı); beklemeden çık.
    }
}

static IResult TooManyAttempts(HttpContext http, TimeSpan wait)
{
    var seconds = (int)Math.Ceiling(wait.TotalSeconds);
    http.Response.Headers.RetryAfter = seconds.ToString();
    return Results.Json(new { retryAfterSeconds = seconds }, statusCode: StatusCodes.Status429TooManyRequests);
}

record UnlockRequest(string? Pin);
