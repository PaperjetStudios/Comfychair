// Shared focus and background isolation for sheets and full-screen editors.
const scopes = [];
const baseline = new Map();
const selector = 'button, [href], input, select, textarea, [tabindex]';
const focusable = (el) => [...el.querySelectorAll(selector)].filter((n) => !n.disabled && n.tabIndex >= 0 && !n.closest('[inert]') && n.getClientRects().length);
function isolate() {
  const top = scopes.at(-1);
  for (const el of document.body.children) {
    if (!baseline.has(el)) baseline.set(el, el.inert);
    el.inert = top ? !(el === top.el || el.contains(top.el) || top.exclude.includes(el)) : baseline.get(el);
  }
  if (!top) baseline.clear();
}

export function modalFocus(el, { exclude = [] } = {}) {
  const previous = document.activeElement;
  const scope = {
    el, exclude,
    focus() { (focusable(el)[0] || el).focus({ preventScroll: true }); },
  };
  el.tabIndex = -1;
  scopes.push(scope);
  isolate();
  scope.focus();
  return {
    focus: scope.focus,
    close() {
      const at = scopes.indexOf(scope);
      if (at < 0) return;
      const top = at === scopes.length - 1;
      scopes.splice(at, 1);
      isolate();
      if (top) {
        if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true });
        else scopes.at(-1)?.focus();
      }
    },
  };
}

document.addEventListener('focusin', (e) => {
  const scope = scopes.at(-1);
  if (scope && !scope.el.contains(e.target)) scope.focus();
});
document.addEventListener('keydown', (e) => {
  const scope = scopes.at(-1);
  if (!scope || e.key !== 'Tab') return;
  const items = focusable(scope.el), at = items.indexOf(document.activeElement);
  if (!items.length || (e.shiftKey ? at <= 0 : at < 0 || at === items.length - 1)) {
    e.preventDefault(); (e.shiftKey ? items.at(-1) : items[0])?.focus();
  }
}, true);
