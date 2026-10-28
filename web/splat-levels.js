// Splat preview levels: which of a splat layer's files the 3D view loads, and which a render loads. Pure (node
// tests import it). A splat layer may carry levels: [{ k: 'light' | 'medium' | 'dense' | 'full', url, n }],
// lightest first (POST /api/scene/splat or /api/scene/splat/levels); without them it has only its url.
// The preview level is a choice per device (a tablet wants Light, a desktop Dense), not part of the scene.
export const LEVELS = [['light', 'Light', 150000], ['medium', 'Medium', 300000], ['dense', 'Dense', 600000], ['full', 'Full', Infinity]];
const RANK = Object.fromEntries(LEVELS.map(([k], i) => [k, i]));
export const levelName = (k) => (LEVELS.find(([v]) => v === k) || [])[1] || k;

// the densest level no denser than `want`, else the lightest there is; null when the layer has no levels
export function levelFor(o, want) {
  const lv = Array.isArray(o?.levels) ? o.levels.filter((v) => v && v.url && v.k in RANK) : [];
  if (!lv.length) return null;
  lv.sort((a, b) => RANK[a.k] - RANK[b.k]);
  const fit = lv.filter((v) => RANK[v.k] <= (RANK[want] ?? 0));
  return fit.length ? fit[fit.length - 1] : lv[0];
}
// what the view loads at preview level `want`
export const previewUrl = (o, want) => levelFor(o, want)?.url || o.url;
// what a render loads: the full set, or the densest level kept
export const renderUrl = (o) => levelFor(o, 'full')?.url || o.url;
// the file name Spark reads the format from
export const fileOf = (url) => decodeURIComponent(String(url).split(/[?#]/)[0].split('/').pop() || '');

// "150k", "1.2M"
export function countLabel(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

// ---- per-device choices (localStorage; `ls` is passed in by tests) ----
const KEY = 'deck.scene.splatLevel', SHARP = 'deck.scene.splatSharp', MAKE = 'deck.scene.splatMake';
const get = (ls, k, d) => { try { const v = ls?.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const put = (ls, k, v) => { try { ls?.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const local = () => (typeof localStorage === 'undefined' ? null : localStorage);
export const defaultLevel = (coarse) => (coarse ? 'light' : 'dense');
export const previewLevel = (coarse, ls = local()) => { const v = get(ls, KEY, null); return v in RANK ? v : defaultLevel(coarse); };
export const setPreviewLevel = (k, ls = local()) => { if (k in RANK) put(ls, KEY, k); };
// "Sharp": a touch screen draws splats at its full pixel ratio too (off: 1x while a splat is in view)
export const sharpOn = (ls = local()) => get(ls, SHARP, false) === true;
export const setSharp = (on, ls = local()) => put(ls, SHARP, !!on);
// the Photo as a splat sheet's last choices
export function makeChoices(coarse, ls = local()) {
  const v = get(ls, MAKE, {}) || {};
  return { preview: v.preview in RANK ? v.preview : defaultLevel(coarse), keepFull: v.keepFull !== false };
}
export const setMakeChoices = (c, ls = local()) => put(ls, MAKE, { preview: c.preview, keepFull: !!c.keepFull });
