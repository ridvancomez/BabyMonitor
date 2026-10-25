// Yayıncı mikrofon ölçer: yerel ses track'inin seviyesini Web Audio ile ölçer (hoparlöre bağlanmaz).
// Bazı Android cihazlar ham ses (echoCancellation/noiseSuppression kapalı) istenince sessiz veri verir;
// bunu yakalamak için kullanılır.

const SAMPLE_MS = 100;
// Bunun altı "tamamen sessiz" (dijital sıfır). Gerçek bir odada ham mikrofon hep bundan gürültülüdür.
export const SILENT_MIC = 1e-5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMicMonitor() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  let ctx = null;
  let analyser = null;
  let buffer = null;
  let source = null;

  function read() {
    analyser.getFloatTimeDomainData(buffer);
    let peak = 0;
    for (const value of buffer) peak = Math.max(peak, Math.abs(value));
    return peak;
  }

  // Eski Safari'de float veri yok: ölçme, karar verme.
  const measurable = () => !!source && ctx.state === 'running' && !!analyser.getFloatTimeDomainData;

  return {
    /** "Yayını Başlat" dokunuşunda, await'ten önce çağır (AudioContext kullanıcı etkileşimi ister). */
    prepare() {
      if (!AudioContextClass || ctx) {
        ctx?.resume().catch(() => {});
        return;
      }
      ctx = new AudioContextClass();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      buffer = new Float32Array(analyser.fftSize);
      ctx.resume().catch(() => {});
    },

    /** Ölçülecek ses track'i (null: ölçmeyi bırak). */
    setTrack(track) {
      if (source) {
        source.disconnect();
        source = null;
      }
      if (!ctx || !track) return;
      source = ctx.createMediaStreamSource(new MediaStream([track]));
      source.connect(analyser);
    },

    /** Belirtilen süre boyunca tepe seviye. Ölçülemiyorsa (Web Audio yok / askıda) null: karar verme. */
    async measure(ms) {
      if (!ctx || !measurable()) return null;
      let peak = 0;
      const until = performance.now() + ms;
      while (performance.now() < until) {
        await sleep(SAMPLE_MS);
        if (!measurable()) return null;
        peak = Math.max(peak, read());
      }
      return peak;
    }
  };
}
