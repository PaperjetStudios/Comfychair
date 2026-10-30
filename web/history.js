// One owner for browser history. Dialogs consume Back before screen navigation does.
const overlays = [];
const FLOOR = { deckNavigation: true };
let skip = 0, back = null, wired = false;

export function initHistory(onBack) {
  back = onBack;
  if (wired) return;
  wired = true;
  history.pushState(FLOOR, '');
  addEventListener('popstate', () => {
    if (skip) { skip--; return; }
    const close = overlays.pop();
    if (close) {
      if (close(true) === false) { overlays.push(close); history.pushState({ deckOverlay: overlays.length }, ''); }
      return;
    }
    history.pushState(FLOOR, '');
    back?.();
  });
}

export function overlayOpened(close) {
  overlays.push(close);
  history.pushState({ deckOverlay: overlays.length }, '');
}
export function overlayClosed(close) {
  const i = overlays.lastIndexOf(close);
  if (i < 0) return;
  overlays.splice(i, 1);
  skip++;
  history.back();
}
