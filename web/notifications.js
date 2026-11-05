import { h, store } from './ui.js';
import { templateName } from './core.js';
import { runTime, fmtDur } from './run-state.js';

let audioCtx = null;
export function notifyPrepare() {
  try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch { /* no audio */ }
  if (window.Notification && isSecureContext && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
function chime(ok = true) {
  if (!audioCtx || store.get('deck.chime', true) === false) return;
  const t = audioCtx.currentTime;
  (ok ? [660, 880] : [440, 330]).forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = f; o.type = 'sine';
    g.gain.setValueAtTime(0.0001, t + i * 0.16);
    g.gain.exponentialRampToValueAtTime(0.25, t + i * 0.16 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.16 + 0.3);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.32);
  });
}
export const BASE_TITLE = document.title;
export function notifyDone(g) {
  const ok = g.status === 'done';
  const took = runTime(g);
  if (took == null || took > 15 || document.hidden) chime(ok);  // quick image runs stay quiet while you watch
  try { navigator.vibrate?.(ok ? 60 : [80, 60, 80]); } catch { /* not supported */ }
  if (document.hidden) {
    document.title = `${ok ? '✓ Done' : '✕ Failed'} · ${BASE_TITLE}`;
    if (window.Notification && Notification.permission === 'granted') {
      const title = ok ? `#${g.id} is done` : `#${g.id} failed`;
      const opts = { body: ok ? `${templateName(g.template)}${took ? ` · ${fmtDur(took)}` : ''}` : (g.error || ''), tag: 'comfydeck', icon: 'icon-192.png' };
      // Android only shows notifications through the service worker
      (navigator.serviceWorker?.controller ? navigator.serviceWorker.ready.then((r) => r.showNotification(title, opts))
        : Promise.resolve().then(() => new Notification(title, opts))).catch(() => { /* not allowed here */ });
    }
  }
}


let wakeLock = null, wakeVideo = null;
export async function keepAwake(on) {
  if (on && navigator.wakeLock && isSecureContext) {
    try {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
      return;
    } catch { /* fall back to the video */ }
  }
  if (on) {
    if (!wakeVideo) {
      wakeVideo = h('video', { src: 'keepawake.mp4', muted: true, loop: true, playsInline: true, class: 'keep-awake', 'aria-hidden': 'true' });
      wakeVideo.setAttribute('playsinline', '');
      document.body.append(wakeVideo);
    }
    wakeVideo.play().catch(() => { /* not from a tap; the next Generate tries again */ });
  } else {
    try { if (wakeLock) await wakeLock.release(); } catch { /* already gone */ }
    wakeLock = null;
    if (wakeVideo) wakeVideo.pause();
  }
}
