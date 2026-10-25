// İzleyici ses yükseltme: uzak stream → GainNode → DynamicsCompressorNode → hoparlör.
//
// <video> her zaman muted kalır (ses iki kez çalmasın) ama srcObject olarak stream'e bağlı kalmalı:
// Chrome, uzak WebRTC sesini ancak stream bir media elemanına bağlıyken Web Audio'ya akıtır.
// Web Audio yoksa, başlatılamazsa ya da ses gelirken çıkışı sessiz kalırsa <video> sesi açılır (yükseltmesiz).

const STORAGE_KEY = 'babymonitor.audioGain';
export const MIN_GAIN = 1;
export const MAX_GAIN = 5;
export const DEFAULT_GAIN = 2;

// Web Audio çıkışı bunun altındaysa "hiç ses yok" sayılır (~-100 dBFS). Mikrofon gürültüsü bile bundan yüksektir.
const SILENT_OUTPUT = 1e-5;
// Gelen sesin ortalama (RMS) seviyesi bunun üstündeyse yayıncıdan gerçekten ses geliyor demektir.
const AUDIBLE_INBOUND_LEVEL = 0.001;
// Ses yolu bu uzunlukta pencerelerle sürekli denetlenir.
const CHECK_WINDOW_MS = 3000;
const SAMPLE_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function loadGain() {
  try {
    const value = Number(localStorage.getItem(STORAGE_KEY));
    if (value >= MIN_GAIN && value <= MAX_GAIN) return value;
  } catch {
    // Gizli sekme / engellenmiş depolama: varsayılanı kullan.
  }
  return DEFAULT_GAIN;
}

function saveGain(value) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Kaydedilemezse sadece bu oturumda geçerli olur.
  }
}

/**
 * İki getStats ölçümü arasında gelen sesin ortalama seviyesi (RMS, 0..1).
 * Birikimli enerji yoksa son anlık seviye. Bilinmiyorsa null.
 *
 * Not: Chrome bu seviyeyi sadece ses bir media elemanından SESLİ çalınırken hesaplar; <video> muted iken
 * enerji hep 0 kalır. Tam 0'ı bu yüzden "ölçülmüyor" (null) sayarız.
 */
export function inboundLevel(before, after) {
  if (!after) return null;
  let level = null;
  const hasEnergy = (s) => s && typeof s.totalAudioEnergy === 'number' && typeof s.totalSamplesDuration === 'number';
  if (hasEnergy(before) && hasEnergy(after) && after.totalSamplesDuration > before.totalSamplesDuration) {
    const duration = after.totalSamplesDuration - before.totalSamplesDuration;
    level = Math.sqrt(Math.max(0, after.totalAudioEnergy - before.totalAudioEnergy) / duration);
  } else if (typeof after.audioLevel === 'number') {
    level = after.audioLevel;
  }
  return level === 0 ? null : level;
}

/**
 * @param {HTMLMediaElement} mediaEl  Stream'in bağlı olduğu (muted) eleman.
 * @param {object} callbacks
 * @param {() => void} callbacks.onNeedsGesture  Ses durdu ve yeniden başlatmak için dokunuş gerekiyor.
 * @param {(reason: string) => void} callbacks.onFallback  Web Audio bırakıldı, ses <video>'dan çalıyor.
 * @param {() => Promise<object|null>} callbacks.getInboundAudioStats
 *   Gelen ses istatistiği: { packets, totalAudioEnergy?, totalSamplesDuration?, audioLevel? } ya da null.
 * @param {() => number|null} callbacks.getSenderLevel
 *   Yayıncının paketlere yazdığı anlık ses seviyesi (getSynchronizationSources, 0..1); yoksa null.
 *   Yerel çalmadan bağımsızdır: "yayıncı gerçekten ses gönderiyor mu" sorusunun cevabı.
 */
export function createAudioBoost(
  mediaEl,
  {
    onNeedsGesture = () => {},
    onFallback = () => {},
    getInboundAudioStats = async () => null,
    getSenderLevel = () => null
  } = {}
) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  let ctx = null;
  let gainNode = null;
  let analyser = null;
  let levelBuffer = null;
  let source = null;
  let sourceStream = null;
  let gain = loadGain();
  let enabled = false;
  // Web Audio kullanılamıyor: ses doğrudan <video> üzerinden.
  let fallback = !AudioContextClass;
  let fallbackReason = fallback ? 'Web Audio desteklenmiyor' : '';
  let monitorGeneration = 0;
  // Denetim penceresindeki tepe seviyeler.
  let windowPeak = 0;
  let windowSenderPeak = null;

  // Kısa sesleri (ör. tek bir hıçkırık) kaçırmamak için sık örnekle, tepeyi tut.
  setInterval(() => {
    const sender = getSenderLevel();
    if (typeof sender === 'number') windowSenderPeak = Math.max(windowSenderPeak ?? 0, sender);
    if (fallback || !source) return;
    windowPeak = Math.max(windowPeak, readOutputLevel() ?? 0);
  }, SAMPLE_MS);

  /** Web Audio çıkışının anlık tepe seviyesi (0..1+); ölçülemiyorsa null. */
  function readOutputLevel() {
    if (!analyser) return null;
    let peak = 0;
    if (analyser.getFloatTimeDomainData) {
      analyser.getFloatTimeDomainData(levelBuffer);
      for (const value of levelBuffer) peak = Math.max(peak, Math.abs(value));
    } else {
      // Eski Safari: sadece byte verisi (128 = sıfır).
      const bytes = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(bytes);
      for (const value of bytes) peak = Math.max(peak, Math.abs(value - 128) / 128);
    }
    return peak;
  }

  function buildGraph() {
    ctx = new AudioContextClass();
    gainNode = ctx.createGain();
    gainNode.gain.value = gain;

    // Yükseltilmiş sesin patlamaması için sınırlayıcı gibi çalışır.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 8;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;

    gainNode.connect(compressor);
    compressor.connect(ctx.destination);

    // Doğrulama/tanı için çıkış seviyesi (hoparlöre bağlı değil; yan kol).
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    levelBuffer = new Float32Array(analyser.fftSize);
    compressor.connect(analyser);

    // iOS: telefon görüşmesi / arka plan sonrası 'interrupted' ya da 'suspended' olabilir.
    ctx.onstatechange = () => {
      if (enabled && ctx.state !== 'running' && ctx.state !== 'closed') tryResume();
    };
  }

  /**
   * Ses yolu denetimi (3 sn'lik pencerelerle, sürekli): paketler geliyor, yayıncı gerçekten ses gönderiyor,
   * ama Web Audio çıkışı tamamen sessizse Web Audio bozuktur → <video> sesine dön.
   * Yayıncı sessizse (seviye ~0) karar verilmez; oda sessizken yanlışlıkla yedeğe geçilmez.
   */
  async function monitorFlow() {
    const generation = ++monitorGeneration;
    const isCurrent = () => generation === monitorGeneration && enabled && !fallback;

    while (isCurrent()) {
      const before = await getInboundAudioStats();
      windowPeak = 0;
      windowSenderPeak = null;
      await sleep(CHECK_WINDOW_MS);
      if (!isCurrent()) return;
      const after = await getInboundAudioStats();
      if (!isCurrent()) return;

      // Arka planda askıya alınmışsa karar verme (onNeedsGesture ayrıca ele alır).
      if (ctx.state !== 'running' || !source) continue;

      const packetsFlowing = !!before && !!after && after.packets > before.packets;
      // Önce yayıncının bildirdiği seviye; yoksa getStats (Chrome muted <video>'da ölçmez → null).
      const incoming = windowSenderPeak ?? inboundLevel(before, after);
      // Hiçbir seviye bilinmiyorsa sadece paketlere güven.
      const incomingAudible = incoming === null || incoming > AUDIBLE_INBOUND_LEVEL;

      if (packetsFlowing && incomingAudible && windowPeak < SILENT_OUTPUT) {
        console.warn('Ses denetimi: Web Audio çıkışı sessiz, yayıncıdan ses geliyor.', { incoming, windowPeak });
        enableFallback('Web Audio çıkışı sessiz, yayıncıdan ses geliyor');
        return;
      }
    }
  }

  function detach() {
    if (source) {
      source.disconnect();
      source = null;
    }
    sourceStream = null;
  }

  function attach(stream) {
    if (!ctx || fallback) return;
    if (stream && stream === sourceStream) return;
    detach();
    if (!stream || stream.getAudioTracks().length === 0) return;
    source = ctx.createMediaStreamSource(stream);
    source.connect(gainNode);
    sourceStream = stream;
  }

  async function tryResume() {
    if (!ctx) return;
    try {
      await ctx.resume();
    } catch {
      // Yok say; aşağıda durum kontrol edilir.
    }
    if (enabled && ctx.state !== 'running') onNeedsGesture();
  }

  function enableFallback(reason) {
    const wasFallback = fallback;
    fallback = true;
    fallbackReason = reason;
    detach();
    mediaEl.muted = false;
    mediaEl.play().catch(() => {});
    if (!wasFallback) {
      console.warn('Ses <video> üzerinden çalınıyor (yükseltmesiz):', reason);
      onFallback(reason);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && enabled && ctx && ctx.state !== 'running') tryResume();
  });

  return {
    get enabled() {
      return enabled;
    },
    /** Web Audio kullanılamıyorsa true: yükseltme sürgüsü anlamsız. */
    get isFallback() {
      return fallback;
    },
    get gain() {
      return gain;
    },

    /** "Sesi Aç" dokunuşunda çağrılmalı (kullanıcı etkileşimi içinde). */
    async enable() {
      enabled = true;
      if (fallback) {
        enableFallback(fallbackReason);
        return;
      }
      try {
        // iOS: sessiz (zil) anahtarı Web Audio'yu susturur; 'playback' oturumu bunu önler (Safari 16.4+).
        if (navigator.audioSession) {
          try {
            navigator.audioSession.type = 'playback';
          } catch {
            // Desteklenmiyorsa geç.
          }
        }
        if (!ctx) buildGraph();
        // resume() dokunuşla aynı görevde çağrılmalı (iOS); await'ten önce başlat.
        const resuming = ctx.resume();
        attach(mediaEl.srcObject);
        mediaEl.muted = true;
        await resuming;
        if (ctx.state !== 'running') throw new Error(`AudioContext durumu: ${ctx.state}`);
      } catch (err) {
        enableFallback(`Web Audio başlatılamadı: ${err.message ?? err}`);
        return;
      }
      monitorFlow();
    },

    /** Gelen stream değişince (yeni bağlantı) ya da kapanınca (null) çağrılır. */
    setStream(stream) {
      if (!stream) {
        detach();
        return;
      }
      if (enabled && !fallback) attach(stream);
    },

    setGain(value) {
      gain = Math.min(MAX_GAIN, Math.max(MIN_GAIN, Number(value) || DEFAULT_GAIN));
      saveGain(gain);
      if (gainNode) gainNode.gain.setTargetAtTime(gain, ctx.currentTime, 0.05);
    }
  };
}
