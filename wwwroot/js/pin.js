const form = document.getElementById('pinForm');
const input = document.getElementById('pinInput');
const submitButton = document.getElementById('submitButton');
const statusEl = document.getElementById('status');

function setStatus(text, tone) {
  statusEl.hidden = false;
  statusEl.textContent = text;
  if (tone) statusEl.dataset.tone = tone;
  else delete statusEl.dataset.tone;
}

// Sadece site içi yollara dön (açık yönlendirme olmasın).
function returnUrl() {
  const value = new URLSearchParams(location.search).get('returnUrl');
  if (value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) return value;
  return '/';
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  setStatus('Kontrol ediliyor…');

  try {
    const response = await fetch('/api/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: input.value })
    });

    if (response.ok) {
      location.replace(returnUrl());
      return;
    }

    if (response.status === 429) {
      const seconds = response.headers.get('Retry-After') ?? '60';
      setStatus(`Çok fazla yanlış deneme. ${seconds} sn sonra tekrar dene.`, 'error');
    } else if (response.status === 503) {
      setStatus('Sunucuda PIN ayarlanmamış. Bilgisayardaki konsola bak.', 'error');
    } else {
      setStatus('PIN yanlış.', 'error');
    }
  } catch {
    setStatus('Sunucuya ulaşılamadı.', 'error');
  }

  input.value = '';
  input.focus();
  submitButton.disabled = false;
});
