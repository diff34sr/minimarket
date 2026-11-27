const SCAN_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
const SCAN_COOLDOWN_MS = 1500;
const useCamera = matchMedia('(pointer: coarse)').matches && !!navigator.mediaDevices && 'BarcodeDetector' in window;

let detectorReady;
const getDetector = () => detectorReady ??= (async () => {
  const supported = await BarcodeDetector.getSupportedFormats();
  const formats = SCAN_FORMATS.filter(f => supported.includes(f));
  if (!formats.length) return null;
  const d = new BarcodeDetector({ formats });
  await d.detect(document.createElement('canvas')).catch(() => {});
  return d;
})().catch(() => null);
if (useCamera) getDetector();

const startScanner = async (container, onCode) => {
  const form = document.createElement('form');
  form.innerHTML = '<input class="input" inputmode="numeric" autocomplete="off" placeholder="Código de barras" enterkeyhint="done"><button class="btn primary">Agregar</button>';
  const input = form.querySelector('input');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const code = input.value.trim();
    input.value = '';
    if (code) onCode(code);
  });
  container.append(form);

  let stopped = false, track, video, torch, torchOn = false;
  const release = () => { track?.stop(); track = null; };
  const onVisible = () => {
    if (document.hidden) release();
    else if (!stopped && !track) camera().catch(() => {});
  };
  const stop = () => {
    stopped = true;
    release();
    document.removeEventListener('visibilitychange', onVisible);
    video?.remove();
    torch?.remove();
    form.remove();
  };

  const loop = async detector => {
    const lastSeen = new Map();
    while (!stopped) {
      if (track && video.readyState >= 2) {
        const codes = await detector.detect(video).catch(() => []);
        const now = performance.now();
        for (const { rawValue } of codes) {
          const prev = lastSeen.get(rawValue);
          lastSeen.set(rawValue, now);
          if (stopped || (prev && now - prev < SCAN_COOLDOWN_MS)) continue;
          navigator.vibrate?.(60);
          onCode(rawValue);
        }
      }
      await new Promise(r => requestAnimationFrame(r));
    }
  };

  // Android da la cámara a una sola página: se suelta al quedar en segundo plano para que otra pestaña la pueda usar.
  const camera = async () => {
    const detector = await getDetector();
    if (!detector || stopped) return false;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    if (stopped || document.hidden || track) return stream.getTracks().forEach(t => t.stop()), true;
    track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities?.() ?? {};
    if (caps.focusMode?.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    torchOn = false;
    if (!video) {
      video = Object.assign(document.createElement('video'), { muted: true, playsInline: true });
      container.prepend(video);
      loop(detector);
    }
    if (caps.torch && !torch) {
      torch = Object.assign(document.createElement('button'), { type: 'button', className: 'btn torch', textContent: '🔦' });
      torch.setAttribute('aria-label', 'Linterna');
      torch.onclick = () => track?.applyConstraints({ advanced: [{ torch: (torchOn = !torchOn) }] }).catch(() => {});
      container.prepend(torch);
    }
    video.srcObject = stream;
    await video.play();
    return true;
  };

  if (useCamera) document.addEventListener('visibilitychange', onVisible);
  (useCamera ? camera() : Promise.resolve(false))
    .catch(e => { if (!stopped) toast('Cámara no disponible: ' + e.message, 'error'); return false; })
    .then(ok => { if (!ok && !stopped) input.focus(); });
  return stop;
};

const scanOnce = async () => {
  const s = sheet('<h2>Escanear</h2><div class="scanbox"></div>');
  s.done.then(await startScanner(s.$('.scanbox'), code => s.close(code)));
  return s.done;
};
