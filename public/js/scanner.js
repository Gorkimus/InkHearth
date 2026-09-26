// Camera barcode scanner for the Log-a-book page. Two decode paths:
//   1. native BarcodeDetector (Android Chrome, desktop Chromium) — no deps
//   2. vendored ZXing UMD (public/vendor/) for Safari/Firefox, lazily loaded
//      the first time the scanner opens so the app's initial payload never
//      grows.
// Resolves with the raw barcode string, or null on cancel / camera error
// (a camera error keeps the modal open — manual ISBN entry still works).
import { $ } from './ui.js';
import { openModal, closeModal } from './book-modal.js';

const loadScript = (src) => new Promise((resolve, reject) => {
  if (window.ZXing) return resolve();
  const s = document.createElement('script');
  s.src = src;
  s.onload = resolve;
  s.onerror = () => reject(new Error('scanner library failed to load'));
  document.head.appendChild(s);
});

export function scanBarcode() {
  return new Promise((resolve) => {
    openModal(`
      <div class="scanner">
        <h3 style="margin:0 0 4px">📷 Scan barcode</h3>
        <p class="muted small" style="margin:0 0 10px">Point the camera at the barcode on the
        back of the book (the ISBN lines) — hold it steady inside the frame.</p>
        <div class="scanner-frame">
          <video id="scan-video" playsinline muted autoplay></video>
          <div class="scan-reticle"></div>
        </div>
        <div id="scan-err" class="muted small" style="margin-top:8px"></div>
        <div class="scanner-foot">
          <input id="scan-manual" placeholder="…or type the ISBN" inputmode="numeric" autocomplete="off">
          <button class="btn ghost" id="scan-cancel">Cancel</button>
        </div>
      </div>`, 'scanner-card');

    let stream = null;
    let reader = null; // ZXing reader, when on that path
    let stopped = false;
    let timer = null;

    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      try { reader?.reset(); } catch { /* already dead */ }
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };
    const finish = (code) => {
      if (stopped) return;
      stop();
      obs.disconnect();
      closeModal();
      resolve(code);
    };

    // The modal shell closes itself on backdrop click / Escape — treat that
    // as cancel so the camera never stays on after the modal is gone.
    const obs = new MutationObserver(() => {
      if ($('#modal').classList.contains('hidden')) finish(null);
    });
    obs.observe($('#modal'), { attributes: true, attributeFilter: ['class'] });

    $('#scan-cancel').addEventListener('click', () => finish(null));
    $('#scan-manual').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.value.trim()) finish(e.target.value.trim());
    });

    const video = $('#scan-video');
    const showError = (msg) => { $('#scan-err').textContent = msg; };

    const begin = async () => {
      if ('BarcodeDetector' in window) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1280 } },
          });
        } catch (err) {
          return showError(err.name === 'NotAllowedError'
            ? 'Camera permission denied — allow camera access, or type the ISBN below.'
            : `Camera unavailable: ${err.message}`);
        }
        video.srcObject = stream;
        await video.play().catch(() => { /* autoplay guard; muted+playsinline */ });
        const detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
        const tick = async () => {
          if (stopped) return;
          try {
            const codes = await detector.detect(video);
            if (codes.length && codes[0].rawValue) return finish(codes[0].rawValue);
          } catch { /* a frame before the video is ready — keep looping */ }
          timer = setTimeout(tick, 200);
        };
        tick();
        return;
      }

      // ZXing fallback — owns the camera via its own constraints.
      try {
        await loadScript('/vendor/zxing.min.js');
        reader = new window.ZXing.BrowserMultiFormatReader();
        await reader.decodeFromConstraints(
          { video: { facingMode: 'environment', width: { ideal: 1280 } } },
          video,
          (result) => { if (result && !stopped) finish(result.getText()); },
        );
      } catch (err) {
        showError(err.message === 'scanner library failed to load'
          ? 'Scanner failed to load — type the ISBN below.'
          : err.name === 'NotAllowedError'
            ? 'Camera permission denied — allow camera access, or type the ISBN below.'
            : `Camera unavailable: ${err.message}`);
      }
    };
    begin();
  });
}
