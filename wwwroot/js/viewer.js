import { createSignaling } from './signaling.js';
import { createWakeLock } from './wakelock.js';
import { createAudioBoost } from './audio-boost.js';

const statusEl = document.getElementById('status');
const videoEl = document.getElementById('remoteVideo');
const unmuteButton = document.getElementById('unmuteButton');
const gainControl = document.getElementById('gainControl');
const gainSlider = document.getElementById('gainSlider');
const gainValue = document.getElementById('gainValue');


/**
 * Gelen ses istatistiği (inbound-rtp): paket sayısı ve varsa birikimli enerji / anlık seviye.
 * Seviye, iki ölçüm arasındaki enerji farkından hesaplanır (bkz. inboundLevel).
 */
async function getInboundAudioStats() {
  if (!pc) return null;
  const report = await pc.getStats();
  let result = null;
  report.forEach((stat) => {
    if (stat.type === 'inbound-rtp' && (stat.kind === 'audio' || stat.mediaType === 'audio')) {
      result = {
        packets: stat.packetsReceived ?? 0,
        totalAudioEnergy: stat.totalAudioEnergy,
        totalSamplesDuration: stat.totalSamplesDuration,
        audioLevel: stat.audioLevel
      };
    }
  });
  if (!result) return null;
  // Eski Safari seviye/enerjiyi 'track' istatistiğinde verir.
  if (typeof result.totalAudioEnergy !== 'number') {
    report.forEach((stat) => {
      if (stat.type === 'track' && stat.kind === 'audio' && stat.remoteSource) {
        result.totalAudioEnergy = stat.totalAudioEnergy;
        result.totalSamplesDuration = stat.totalSamplesDuration;
        if (typeof result.audioLevel !== 'number') result.audioLevel = stat.audioLevel;
      }
    });
  }
  return result;
}

/** Yayıncının RTP paketlerine yazdığı ses seviyesi (0..1). Yerel çalmadan bağımsız; yoksa null. */
function getSenderLevel() {
  const receiver = pc?.getReceivers().find((r) => r.track?.kind === 'audio');
  const sources = receiver?.getSynchronizationSources?.() ?? [];
  const levels = sources.map((s) => s.audioLevel).filter((level) => typeof level === 'number');
  return levels.length ? Math.max(...levels) : null;
}

const audio = createAudioBoost(videoEl, {
  // Ses durdu (iOS kesintisi vb.) ve tarayıcı dokunuşsuz başlatmıyor: butonu tekrar göster.
  onNeedsGesture() {
    if (videoEl.srcObject) unmuteButton.hidden = false;
  },
  // Web Audio'dan ses çıkmadı; ses <video>'dan (yükseltmesiz) çalıyor.
  onFallback() {
    gainControl.hidden = true;
  },
  getInboundAudioStats,
  getSenderLevel
});

// Aynı Wi-Fi'de STUN/TURN gerekmez.
const RTC_CONFIG = { iceServers: [] };

// Yeniden bağlanmada sunucu eski izleyici kaydını henüz silmemiş olabilir; bu aralıkla tekrar dene.
const REJOIN_RETRY_MS = 3000;

let hasJoinedOnce = false;
// Her yeni bağlantıda artar; eski bağlantıya ait tekrar deneme döngüsünü durdurmak için.
let joinGeneration = 0;

let pc = null;
let broadcasterId = null;
// { fromId, candidate } — offer'dan önce ya da remote description ayarlanmadan gelen adaylar.
let pendingIce = [];

function setStatus(text, tone) {
  statusEl.textContent = text;
  if (tone) statusEl.dataset.tone = tone;
  else delete statusEl.dataset.tone;
}

function closePeer() {
  if (pc) {
    pc.close();
    pc = null;
  }
  broadcasterId = null;
  pendingIce = [];
  audio.setStream(null);
  videoEl.srcObject = null;
  // Görüntü yokken "Sesi Aç" anlamsız; görüntü gelince (hâlâ sessizse) tekrar görünür.
  unmuteButton.hidden = true;
}

async function flushPendingIce() {
  const queued = pendingIce;
  pendingIce = [];
  for (const { fromId, candidate } of queued) {
    if (fromId !== broadcasterId) continue;
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('Bekleyen ICE adayı eklenemedi:', err);
    }
  }
}

const { connection, start } = createSignaling({
  onStateChange(state) {
    if (state === 'connecting') setStatus('Sunucuya bağlanılıyor…');
    if (state === 'reconnecting') setStatus('Sunucu bağlantısı koptu, yeniden bağlanılıyor…', 'error');
  },
  async onConnected() {
    const generation = ++joinGeneration;
    // Yeni connectionId ile katılıyoruz; yayıncı eski bağlantımızı ViewerLeft ile kapattı.
    closePeer();

    if (!hasJoinedOnce) {
      const accepted = await connection.invoke('JoinAsViewer');
      if (accepted) {
        hasJoinedOnce = true;
        setStatus('Yayın bekleniyor…');
      } else {
        // Sunucu ayrıca RoomFull gönderir; bağlantıyı açık tutmaya gerek yok.
        await connection.stop();
      }
      return;
    }

    // Yeniden bağlanma: sunucu eski kaydımızı henüz silmediyse oda dolu görünür; vazgeçme, tekrar dene.
    while (generation === joinGeneration && connection.state === signalR.HubConnectionState.Connected) {
      let accepted;
      try {
        accepted = await connection.invoke('JoinAsViewer');
      } catch (err) {
        console.warn('JoinAsViewer başarısız; bağlantı yeniden kurulunca tekrar denenecek.', err);
        return;
      }
      if (accepted) {
        setStatus('Yayın bekleniyor…');
        return;
      }
      setStatus('Sunucu önceki oturumu kapatıyor, yeniden deneniyor…', 'error');
      await new Promise((resolve) => setTimeout(resolve, REJOIN_RETRY_MS));
    }
  }
});

connection.on('ReceiveOffer', async (fromId, sdp) => {
  // Bu yayıncıdan offer'dan önce gelmiş adaylar korunur.
  const earlyIce = pendingIce.filter((item) => item.fromId === fromId);
  closePeer();
  pendingIce = earlyIce;
  broadcasterId = fromId;
  setStatus('Yayına bağlanılıyor…');

  pc = new RTCPeerConnection(RTC_CONFIG);
  const currentPc = pc;

  currentPc.onicecandidate = (event) => {
    if (!event.candidate) return;
    connection.invoke('SendIce', fromId, JSON.stringify(event.candidate)).catch(console.warn);
  };

  currentPc.ontrack = (event) => {
    if (videoEl.srcObject !== event.streams[0]) {
      videoEl.srcObject = event.streams[0];
      videoEl.play().catch(() => {});
    }
    // Ses track'i gelince Web Audio'ya bağla (ses açıksa; değilse "Sesi Aç" bağlar).
    audio.setStream(event.streams[0]);
  };

  currentPc.onconnectionstatechange = () => {
    if (currentPc !== pc) return;
    const state = currentPc.connectionState;
    if (state === 'disconnected') {
      // Çoğu zaman kendiliğinden düzelir (kısa Wi-Fi kesintisi).
      setStatus('Görüntü bağlantısı kesildi, bekleniyor…', 'error');
    } else if (state === 'failed') {
      // Yayıncı bunu görüp yeni offer gönderir.
      setStatus('Görüntü bağlantısı koptu, yeniden bağlanılıyor…', 'error');
    } else if (state === 'connected' && videoEl.srcObject && !videoEl.paused) {
      // 'disconnected' sonrası toparlandı; 'playing' tekrar tetiklenmeyebilir.
      setStatus('Canlı', 'ok');
    }
  };

  try {
    await currentPc.setRemoteDescription({ type: 'offer', sdp });
    await flushPendingIce();
    const answer = await currentPc.createAnswer();
    await currentPc.setLocalDescription(answer);
    await connection.invoke('SendAnswer', currentPc.localDescription.sdp);
  } catch (err) {
    console.error('Offer işlenemedi:', err);
    setStatus('Yayına bağlanılamadı.', 'error');
  }
});

connection.on('ReceiveIce', async (fromId, candidateJson) => {
  const candidate = JSON.parse(candidateJson);
  // Önceki yayıncıdan kalan aday: yok say.
  if (pc && fromId !== broadcasterId) return;
  // Offer henüz gelmediyse ya da remote description ayarlanmadıysa kuyrukta beklet.
  if (!pc || !pc.remoteDescription) {
    pendingIce.push({ fromId, candidate });
    return;
  }
  try {
    await pc.addIceCandidate(candidate);
  } catch (err) {
    console.warn('ICE adayı eklenemedi:', err);
  }
});

connection.on('RoomFull', () => {
  // Yeniden katılımdaki geçici ret "Oda dolu" değildir; onConnected tekrar dener.
  if (hasJoinedOnce) return;
  setStatus('Oda dolu: en fazla 2 izleyici bağlanabilir.', 'error');
});

connection.on('BroadcasterLeft', () => {
  closePeer();
  // İzleyici odada kalır; yeni yayıncı gelince sunucu onu bildirir.
  setStatus('Yayıncı ayrıldı. Yayın bekleniyor…', 'error');
});

// Görüntü gerçekten akmaya başlayınca "Canlı".
videoEl.addEventListener('playing', () => {
  setStatus('Canlı', 'ok');
  if (!audio.enabled) unmuteButton.hidden = false;
});

unmuteButton.addEventListener('click', async () => {
  unmuteButton.hidden = true;
  // Bazı tarayıcılar Wake Lock için kullanıcı etkileşimi ister; burada tekrar dene.
  wakeLock.enable();
  // Kullanıcı dokunuşu içinde başlatılmalı (mobil autoplay kısıtı).
  await audio.enable();
  // Web Audio yoksa yükseltme yapılamaz; sürgüyü gizle.
  gainControl.hidden = audio.isFallback;
});

function renderGain(value) {
  gainSlider.value = String(value);
  gainValue.textContent = `${value}x`;
}

gainSlider.addEventListener('input', () => {
  audio.setGain(gainSlider.value);
  renderGain(audio.gain);
});

renderGain(audio.gain);
gainControl.hidden = audio.isFallback;

// İzlerken ekran kapanmasın.
const wakeLock = createWakeLock();
wakeLock.enable();

start();
