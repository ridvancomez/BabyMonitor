// Ortak SignalR bağlantısı. Sadece signaling içindir; medya buradan geçmez.
// signalr.min.js sayfada bu modülden önce klasik <script> olarak yüklenmelidir (global `signalR`).

const HUB_URL = '/hubs/monitor';

// Çerez geçersiz (PIN değişti ya da süresi doldu): sunucu 401 döner.
// İstemci kütüphanesi negotiate hatasını sarmaladığı için durum kodu mesajdan da kontrol edilir.
function isUnauthorized(err) {
  return err?.statusCode === 401 || String(err?.message ?? err).includes("Status code '401'");
}

function redirectToPin() {
  location.href = '/pin.html?returnUrl=' + encodeURIComponent(location.pathname + location.search);
}

// Bebek monitörü uzun süre açık kalır: vazgeçmeden, en fazla 10 sn aralıkla dene.
const retryPolicy = {
  nextRetryDelayInMilliseconds: (context) => {
    if (isUnauthorized(context.retryReason)) {
      redirectToPin();
      return null;
    }
    return Math.min(10000, 1000 * Math.max(1, context.previousRetryCount));
  }
};

/**
 * Hub bağlantısını oluşturur ve başlatır.
 * @param {object} handlers
 * @param {(state: 'connecting'|'connected'|'reconnecting') => void} handlers.onStateChange
 * @param {() => Promise<void>} handlers.onConnected  İlk bağlantıda ve her yeniden bağlanmada çağrılır.
 *   Yeniden bağlanınca connectionId değişir ve sunucu eski kaydı siler; bu yüzden odaya yeniden katılım burada yapılmalı.
 */
export function createSignaling({ onStateChange = () => {}, onConnected = async () => {} } = {}) {
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(HUB_URL)
    .withAutomaticReconnect(retryPolicy)
    .configureLogging(signalR.LogLevel.Warning)
    .build();

  connection.onreconnecting(() => onStateChange('reconnecting'));
  connection.onreconnected(async () => {
    onStateChange('connected');
    await onConnected();
  });

  let stopRequested = false;

  // İlk bağlantı otomatik yeniden bağlanma kapsamında değil; kendimiz tekrar deneriz.
  async function start() {
    let attempt = 0;
    stopRequested = false;
    onStateChange('connecting');
    for (;;) {
      if (stopRequested) return;
      try {
        await connection.start();
        break;
      } catch (err) {
        if (isUnauthorized(err)) {
          redirectToPin();
          return;
        }
        console.warn('Hub bağlantısı kurulamadı, tekrar denenecek.', err);
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10000, 1000 * attempt)));
      }
    }
    // Bağlanırken durdurulduysa hemen çık.
    if (stopRequested) {
      await connection.stop();
      return;
    }
    onStateChange('connected');
    await onConnected();
  }

  // Bağlantıyı kapatır; sunucu OnDisconnected ile kaydı hemen siler. Süren start() döngüsünü de durdurur.
  async function stop() {
    stopRequested = true;
    await connection.stop();
  }

  return { connection, start, stop };
}
