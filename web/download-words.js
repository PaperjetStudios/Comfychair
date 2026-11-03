// What a download's row says, with no page behind it (web/downloads.js shows it, tests/download_words.test.mjs checks it).
import { fmtDur } from './run-state.js';

const size = (n) => {
  if (!n) return '0 MB';
  return n >= 1e9 ? `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`;
};

// "1.2 of 6.1 GB · 12 MB/s · 4m left" for one on its way
export function progressWords(d) {
  if (d.stopping) return 'Stopping…';
  if (!d.got) return 'Starting…';
  return [
    d.total ? `${size(d.got)} of ${size(d.total)}` : size(d.got),
    d.speed ? `${size(d.speed)}/s` : null,
    d.speed && d.total > d.got ? `${fmtDur((d.total - d.got) / d.speed)} left` : null,
  ].filter(Boolean).join(' · ');
}

// "Done · 2.3 GB · 3 Nov, 14:03" for one in the history
const WORDS = { done: 'Done', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted: the app stopped during it' };
export function historyWords(e) {
  const when = e.finished ? new Date(e.finished * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  const what = e.gone ? 'Done, file since deleted' : e.skipped ? 'Already there' : WORDS[e.state] || e.state;
  return [what, e.state === 'done' && e.size ? size(e.size) : null, when].filter(Boolean).join(' · ');
}
