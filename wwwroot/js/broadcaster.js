import { createSignaling } from './signaling.js';
import { createWakeLock } from './wakelock.js';
import { createMicMonitor, SILENT_MIC } from './mic-monitor.js';

const statusEl = document.getElementById('status');
const previewEl = document.getElementById('preview');
const viewerCountEl = document.getElementById('viewerCount');
const startButton = document.getElementById('startButton');
const liveControls = document.getElementById('liveControls');
const flipButton = document.getElementById('flipButton');
const stopButton = document.getElementById('stopButton');

// exact kullanma: arka kamerası olmayan cihazda OverconstrainedError verir.
const videoConstraints = (facingMode) => ({ facingMode: { ideal: facingMode } });
// İzleyiciden bebeğe ses gitmiyor: yankı engellemeye gerek yok. Gürültü bastırma bebeğin hafif seslerini de siler.
const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: true };
// Bazı Android cihazlar (ör. Xiaomi) ham seste sessiz veri verir; o zaman 9. aşama öncesi ayarlara dönülür.
const PROCESSED_AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
// Mikrofon ısınma süresi ve ölçüm penceresi.
const MIC_WARMUP_MS = 500;
const MIC_CHECK_MS = 2500;

const micMonitor = createMicMonitor();

const wakeLock = createWakeLock();
let facingMode = 'environment';

// Aynı Wi-Fi'de STUN/TURN gerekmez.
const RTC_CONFIG = { iceServers: [] };

// Yeniden bağlanmada sunucu eski yayıncı kaydını henüz silmemiş olabilir; bu aralıkla tekrar dene.
const REJOIN_RETRY_MS = 3000;

let localStream = null;
let hasJoinedOnce = false;
// Her yeni bağlantıda artar; eski bağlantıya ait tekrar deneme döngüsünü durdurmak için.
let joinGeneration = 0;

/** viewerId → { pc: RTCPeerConnection, pendingIce: RTCIceCandidateInit[] } */
const peers = new Map();

function setStatus(text, tone) {
  statusEl.textContent = text;
  if (tone) statusEl.dataset.tone = tone;
  else delete statusEl.dataset.tone;
}

function renderViewerCount() {
  viewerCountEl.textContent = String(peers.size);
}

function stopLocalStream() {
  if (!localStream) return;
  localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  previewEl.srcObject = null;
}

function setLiveControls(live) {
  startButton.hidden = live;
  startButton.disabled = false;
  liveControls.hidden = !live;
}

// Tarayıcı kamerayı/mikrofonu kendisi kapatırsa (ekran kilidi, başka uygulama) uyar.
// Not: track.stop() ile bizim kapattığımız track'ler 'ended' tetiklemez.
function watchTrack(track) {
  track.addEventListener('ended', () => {
    if (!localStream || !localStream.getTracks().includes(track)) return;
    setStatus(
      'Kamera ya da mikrofon durdu (ekran kilitlenmiş ya da başka bir uygulama kamerayı almış olabilir). ' +
        'Yayını durdurup yeniden başlat.',
      'error'
    );
  });
}

function closePeer(viewerId) {
  const peer = peers.get(viewerId);
  if (!peer) return;
  peer.pc.close();
  peers.delete(viewerId);
  renderViewerCount();
}

function closeAllPeers() {
  for (const viewerId of [...peers.keys()]) closePeer(viewerId);
}

async function flushPendingIce(peer) {
  const queued = peer.pendingIce;
  peer.pendingIce = [];
  for (const candidate of queued) {
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn('Bekleyen ICE adayı eklenemedi:', err);
    }
  }
}

const { connection, start, stop } = createSignaling({
  onStateChange(state) {
    if (state === 'connecting') setStatus('Sunucuya bağlanılıyor…');
    if (state === 'reconnecting') {
      // Eşler arası medya akmaya devam edebilir; bağlantılar yeniden katılımda yenilenir.
      setStatus('Sunucu bağlantısı koptu, yeniden bağlanılıyor…', 'error');
    }
  },
  async onConnected() {
    const generation = ++joinGeneration;
    // Yeni connectionId ile izleyiciler bizi yeni yayıncı olarak görecek; eski bağlantılar geçersiz.
    closeAllPeers();

    if (!hasJoinedOnce) {
      const accepted = await connection.invoke('JoinAsBroadcaster');
      if (accepted) {
        hasJoinedOnce = true;
        setStatus('Yayında', 'ok');
      } else {
        await stopBroadcast('Başka bir cihaz zaten yayın yapıyor.', 'error');
      }
      return;
    }

    // Yeniden bağlanma: kamerayı kapatma, sunucu eski kaydı silene kadar tekrar dene.
    while (generation === joinGeneration && connection.state === signalR.HubConnectionState.Connected) {
      let accepted;
      try {
        accepted = await connection.invoke('JoinAsBroadcaster');
      } catch (err) {
        console.warn('JoinAsBroadcaster başarısız; bağlantı yeniden kurulunca tekrar denenecek.', err);
        return;
      }
      if (accepted) {
        setStatus('Yayında', 'ok');
        return;
      }
      setStatus('Sunucu önceki oturumu kapatıyor, yeniden deneniyor…', 'error');
      await new Promise((resolve) => setTimeout(resolve, REJOIN_RETRY_MS));
    }
  }
});

async function connectPeer(viewerId) {
  if (!localStream) return;
  closePeer(viewerId);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peer = { pc, pendingIce: [] };
  peers.set(viewerId, peer);
  renderViewerCount();

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    connection.invoke('SendIce', viewerId, JSON.stringify(event.candidate)).catch(console.warn);
  };

  // Eşler arası bağlantı kalıcı olarak koptuysa (Wi-Fi değişimi vb.) yeni offer ile yeniden kur.
  // İzleyici yeni offer gelince eski bağlantısını kendisi kapatır.
  pc.onconnectionstatechange = () => {
    if (pc.connectionState !== 'failed' || peers.get(viewerId)?.pc !== pc) return;
    console.warn('İzleyici bağlantısı koptu, yeniden kuruluyor:', viewerId);
    connectPeer(viewerId);
  };

  // Aynı track'ler her izleyici bağlantısına eklenir.
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await connection.invoke('SendOffer', viewerId, pc.localDescription.sdp);
  } catch (err) {
    console.error('Offer gönderilemedi:', err);
    if (peers.get(viewerId)?.pc === pc) closePeer(viewerId);
  }
}

connection.on('ViewerJoined', (viewerId) => connectPeer(viewerId));

connection.on('ReceiveAnswer', async (viewerId, sdp) => {
  const peer = peers.get(viewerId);
  if (!peer) return;
  try {
    await peer.pc.setRemoteDescription({ type: 'answer', sdp });
    await flushPendingIce(peer);
  } catch (err) {
    console.error('Answer uygulanamadı:', err);
  }
});

connection.on('ReceiveIce', async (fromId, candidateJson) => {
  const peer = peers.get(fromId);
  if (!peer) return;
  const candidate = JSON.parse(candidateJson);
  // Remote description gelmeden eklenen aday hata verir; kuyrukta beklet.
  if (!peer.pc.remoteDescription) {
    peer.pendingIce.push(candidate);
    return;
  }
  try {
    await peer.pc.addIceCandidate(candidate);
  } catch (err) {
    console.warn('ICE adayı eklenemedi:', err);
  }
});

connection.on('ViewerLeft', (viewerId) => {
  closePeer(viewerId);
});

startButton.addEventListener('click', async () => {
  startButton.disabled = true;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('Bu tarayıcı kamera erişimine izin vermiyor (HTTPS gerekli).', 'error');
    startButton.disabled = false;
    return;
  }

  // AudioContext dokunuşla aynı görevde oluşturulmalı (await'ten önce).
  micMonitor.prepare();

  setStatus('Kamera ve mikrofon izni isteniyor…');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints(facingMode),
      audio: RAW_AUDIO
    });
  } catch (err) {
    setStatus(`Kamera açılamadı: ${err.name} — ${err.message}`, 'error');
    startButton.disabled = false;
    return;
  }

  localStream.getTracks().forEach(watchTrack);
  micMonitor.setTrack(localStream.getAudioTracks()[0] ?? null);
  previewEl.srcObject = localStream;
  setLiveControls(true);
  wakeLock.enable();
  // Arka planda: ham mikrofon gerçekten ses veriyor mu? Vermiyorsa işlenmiş sese geç.
  verifyMicrophone(localStream);
  // Medya hazır olduktan sonra odaya katıl; izleyicilere boş yayıncı bildirilmesin.
  await start();
});

/** Ham mikrofon tamamen sessizse (bazı Android cihazlar) işlenmiş ses ayarlarıyla yeniden aç. */
async function verifyMicrophone(stream) {
  await new Promise((resolve) => setTimeout(resolve, MIC_WARMUP_MS));
  if (localStream !== stream) return;
  const peak = await micMonitor.measure(MIC_CHECK_MS);
  // Yayın durdurulduysa ya da ölçülemiyorsa (Web Audio yok/askıda) karar verme.
  if (localStream !== stream || peak === null || peak >= SILENT_MIC) return;

  console.warn('Ham mikrofon sessiz; yankı engelleme/gürültü bastırma açık ayarlara geçiliyor.');
  const oldTrack = localStream.getAudioTracks()[0];
  // Bazı telefonlar iki ses yakalamayı aynı anda açamaz: önce eskisini kapat.
  oldTrack?.stop();
  let newTrack;
  try {
    const processed = await navigator.mediaDevices.getUserMedia({ audio: PROCESSED_AUDIO });
    newTrack = processed.getAudioTracks()[0];
  } catch (err) {
    setStatus(`Mikrofon açılamadı: ${err.name}. Yayını durdurup yeniden başlat.`, 'error');
    return;
  }
  if (localStream !== stream) {
    newTrack.stop();
    return;
  }

  if (oldTrack) localStream.removeTrack(oldTrack);
  localStream.addTrack(newTrack);
  watchTrack(newTrack);
  micMonitor.setTrack(newTrack);

  // Yeniden offer gerekmeden tüm açık bağlantılarda sesi değiştir.
  await Promise.all(
    [...peers.values()].map(({ pc }) => {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
      return sender?.replaceTrack(newTrack).catch((err) => console.warn('Ses replaceTrack başarısız:', err));
    })
  );
}

/** Hub'dan çık (sunucu yeri hemen boşaltır, izleyicilere BroadcasterLeft gider), bağlantıları ve kamerayı kapat. */
async function stopBroadcast(statusText, tone) {
  // Süren yeniden katılım döngüsünü durdur.
  joinGeneration++;
  hasJoinedOnce = false;
  closeAllPeers();
  await stop();
  micMonitor.setTrack(null);
  stopLocalStream();
  await wakeLock.disable();
  setLiveControls(false);
  setStatus(statusText, tone);
}

stopButton.addEventListener('click', () => stopBroadcast('Yayın durduruldu.'));

flipButton.addEventListener('click', async () => {
  if (!localStream) return;
  flipButton.disabled = true;

  const nextFacing = facingMode === 'environment' ? 'user' : 'environment';
  const oldTrack = localStream.getVideoTracks()[0];
  // Birçok telefon iki kamerayı aynı anda açamaz: önce eskisini kapat.
  oldTrack?.stop();

  let newTrack = null;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(nextFacing) });
    newTrack = stream.getVideoTracks()[0];
    facingMode = nextFacing;
  } catch (err) {
    console.warn('Kamera çevrilemedi:', err);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(facingMode) });
      newTrack = stream.getVideoTracks()[0];
      setStatus(`Kamera çevrilemedi (${err.name}); önceki kamera kullanılıyor.`, 'error');
    } catch (retryErr) {
      setStatus(`Kamera açılamadı: ${retryErr.name}. Yayını durdurup yeniden başlat.`, 'error');
    }
  }

  // Beklerken yayın durdurulduysa yeni track'i bırak.
  if (!localStream) {
    newTrack?.stop();
    flipButton.disabled = false;
    return;
  }

  if (newTrack) {
    if (oldTrack) localStream.removeTrack(oldTrack);
    localStream.addTrack(newTrack);
    watchTrack(newTrack);
    previewEl.srcObject = localStream;

    // Yeniden offer gerekmeden tüm açık bağlantılarda görüntüyü değiştir.
    await Promise.all(
      [...peers.values()].map(({ pc }) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        return sender?.replaceTrack(newTrack).catch((err) => console.warn('replaceTrack başarısız:', err));
      })
    );
  }

  flipButton.disabled = false;
});
