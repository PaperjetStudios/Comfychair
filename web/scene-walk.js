import * as THREE from './vendor/three.module.min.js';
import { store, toast } from './ui.js';

// ---------------------------------------------------------------------------
// Camera walk, as in Unreal's viewport: hold the right mouse button on the 3D view and the mouse looks around from where the
// camera stands, W A S D (or the arrow keys) walk it forward, back and sideways along where it looks, Q goes down and E up,
// Shift is faster, and the wheel sets the speed. It moves the camera the view is showing (the shot camera, or the free
// view's) through its own orbit controls, so the move is kept and keyed exactly as an orbit is. Shift + right mouse still
// pans, and a camera that can't be moved now (a cut's camera, a held gizmo) is left alone.
// ---------------------------------------------------------------------------
const MOVE = { KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1], KeyD: [1, 1], ArrowRight: [1, 1], KeyA: [1, -1], ArrowLeft: [1, -1],
  KeyE: [2, 1], KeyQ: [2, -1] };   // [axis (0 forward, 1 right, 2 up), sign]
const UP = new THREE.Vector3(0, 1, 0);
const BASE = 3;   // metres a second at speed 1

export function wireWalk({ canvas, cam, ctl }) {
  const keys = new Set();
  let on = false, pid = null, raf = 0, t0 = 0, speed = +store.get('deck.scene.walkspeed', 1) || 1;
  const d = new THREE.Vector3(), r = new THREE.Vector3(), mv = new THREE.Vector3();

  const step = (now) => {
    raf = on ? requestAnimationFrame(step) : 0;
    const dt = Math.min(0.1, (now - t0) / 1000); t0 = now;
    if (!keys.size) return;
    const c = cam(), o = ctl();
    d.copy(o.target).sub(c.position);
    const len = d.length() || 1;
    d.divideScalar(len);
    r.crossVectors(d, UP).normalize();
    mv.set(0, 0, 0);
    for (const code of keys) {
      const [axis, s] = MOVE[code];
      if (axis === 0) mv.addScaledVector(d, s); else if (axis === 1) mv.addScaledVector(r, s); else mv.y += s;
    }
    if (!mv.lengthSq()) return;
    mv.normalize().multiplyScalar(BASE * speed * (keys.has('Shift') ? 3 : 1) * dt);
    c.position.add(mv); o.target.add(mv);
    o.update();
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 2 || e.shiftKey || on || !ctl().enabled) return;
    e.stopImmediatePropagation(); e.preventDefault();
    on = true; pid = e.pointerId;
    try { canvas.setPointerCapture(pid); } catch { /* the pointer is gone */ }
    ctl().dispatchEvent({ type: 'start' });   // (the orbit's own start / end: held while it plays, kept and keyed on letting go)
    canvas.style.cursor = 'crosshair';
    if (!store.get('deck.scene.walkhint', false)) { store.set('deck.scene.walkhint', true); toast('Camera walk: mouse looks, W A S D or arrows move, Q down, E up, Shift faster, wheel sets speed'); }
    t0 = performance.now(); raf = requestAnimationFrame(step);
  }, true);

  canvas.addEventListener('pointermove', (e) => {
    if (!on || e.pointerId !== pid) return;
    e.stopImmediatePropagation();
    const c = cam(), o = ctl();
    d.copy(o.target).sub(c.position);
    const len = d.length() || 1;
    d.divideScalar(len).applyAxisAngle(UP, -e.movementX * 0.003);
    r.crossVectors(d, UP).normalize();
    const turned = d.clone().applyAxisAngle(r, -e.movementY * 0.003);
    if (Math.abs(turned.y) < 0.985) d.copy(turned);   // (not quite straight up or down)
    o.target.copy(c.position).addScaledVector(d, len);
    o.update();
  }, true);

  const end = (e) => {
    if (!on || (e && e.pointerId !== pid)) return;
    on = false; keys.clear();
    cancelAnimationFrame(raf); raf = 0;
    canvas.style.cursor = '';
    try { canvas.releasePointerCapture(pid); } catch { /* already released */ }
    ctl().dispatchEvent({ type: 'end' });
  };
  canvas.addEventListener('pointerup', (e) => { if (on && e.button === 2) { e.stopImmediatePropagation(); end(e); } }, true);
  canvas.addEventListener('pointercancel', end, true);
  addEventListener('blur', () => end());

  canvas.addEventListener('wheel', (e) => {
    if (!on) return;
    e.preventDefault(); e.stopImmediatePropagation();
    speed = Math.min(20, Math.max(0.1, speed * Math.exp(-e.deltaY * 0.002)));
    store.set('deck.scene.walkspeed', speed);
  }, { capture: true, passive: false });

  // while walking, these keys are the walk's, ahead of the tab's own (W is Move, Q the gizmo axes, the arrows a frame)
  addEventListener('keydown', (e) => {
    if (!on) return;
    if (e.key === 'Shift') { keys.add('Shift'); return; }
    if (!MOVE[e.code]) return;
    e.preventDefault(); e.stopImmediatePropagation();
    keys.add(e.code);
  }, true);
  addEventListener('keyup', (e) => { keys.delete(e.key === 'Shift' ? 'Shift' : e.code); }, true);
}
