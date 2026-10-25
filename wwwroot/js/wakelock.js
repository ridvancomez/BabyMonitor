// Ekranı açık tutar (Wake Lock API). Destek yoksa ya da reddedilirse sessizce geçer.
// Sayfa arka plana gidince tarayıcı kilidi bırakır; görünür olunca yeniden alınır.

export function createWakeLock() {
  let sentinel = null;
  let wanted = false;

  async function acquire() {
    if (!wanted || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
    if (sentinel && !sentinel.released) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
      });
    } catch {
      // Destek yok / izin yok / düşük pil modu: sessizce geç.
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') acquire();
  });

  return {
    async enable() {
      wanted = true;
      await acquire();
    },
    async disable() {
      wanted = false;
      const current = sentinel;
      sentinel = null;
      if (current) {
        try {
          await current.release();
        } catch {
          // Zaten bırakılmış olabilir.
        }
      }
    }
  };
}
