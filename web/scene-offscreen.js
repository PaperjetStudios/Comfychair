// A 3D scene (the 3D tab's SC) built and drawn on its own, for the video tab's compositions: a THREE.Scene
// per Stage and one WebGL renderer shared by all of them, so nothing here touches the 3D panel's scene,
// selection or renderer (it needn't even be open). Layers are built by the panel's own code: makers /
// LOADERS (scene-model.js, scene-import.js; they take a context saying which scene they fill), figure.js
// for people, scene-data.js `sample` for the keys. Loaded lazily by scene-comp.js (three.js is big).
import * as THREE from './vendor/three.module.min.js';
import * as SCENE from './scene.js';   // (its layer types register when it loads; it is not initialised here, so no panel appears)
import * as FIGURE from './figure.js';
import { CAM, EVEN, applyRoll, FPS, OBJ, TYPES, framesFor, makers, namesFor, pathSig, sample, upgrade } from './scene-data.js';
import { LOADERS, RANGE, depthMat, floorMat, geometries, photoScene, rangeMat, setRange, wallMat } from './scene-view.js';
import { applyClay } from './scene-import.js';

export const LOOKS = [['color', 'Color'], ['clay', 'Clay'], ['depth', 'Depth'], ['pose', 'Pose']];
export const ready = typeof SCENE.show;   // (keeps the import above in use: it is for its side effects)

const clay = new THREE.MeshStandardMaterial({ color: 0xb4b4b4, roughness: 0.9 });
const figClay = new THREE.MeshStandardMaterial({ color: 0xb4b4b4, roughness: 0.9, flatShading: true });
const hidden = new THREE.MeshBasicMaterial();   // (a figure's joint dots are never on the camera's layer)
const BG = 0x24272e;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let GL = null, SPARK = null;
function glr() {
  if (!GL) { GL = new THREE.WebGLRenderer({ antialias: true }); GL.setPixelRatio(1); }
  return GL;
}

let nextId = 1;
export class Stage {
  // payload: the scene as saved in a scene-tabs document (a copy is made)
  constructor(payload) {
    const sc = this.sc = upgrade(structuredClone(payload));
    this.id = nextId++; this.version = 0; this.onChange = null;   // version moves when what's drawn could differ
    this.frames = framesFor(sc.seconds); this.dur = this.frames / FPS;
    this.w = sc.width; this.h = sc.height;
    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(3, 6, 4);
    this.scene.add(sun);
    this.camera = new THREE.PerspectiveCamera(45, this.w / this.h, 0.05, 500);
    this.meshes = new Map(); this.room = []; this.waiting = new Set(); this.waiters = []; this.paths = new Map();
    this.range = null; this.look = null; this.spark = null; this.kicked = ''; this.timer = 0;
    this.buildRoom();
    for (const o of sc.objects) { try { this.make(o); } catch (e) { console.error(o.name, e); } }
  }

  buildRoom() {
    const rm = this.sc.room;
    if (!rm || rm.hidden) return;
    const { w, d, h } = rm, add = (g, mat = wallMat) => { const m = new THREE.Mesh(g, mat); this.room.push(m); this.scene.add(m); };
    add(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), floorMat);
    if (!rm.walls) return;
    add(new THREE.PlaneGeometry(w, h).translate(0, h / 2, -d / 2));
    add(new THREE.PlaneGeometry(d, h).rotateY(Math.PI / 2).translate(-w / 2, h / 2, 0));
    add(new THREE.PlaneGeometry(d, h).rotateY(-Math.PI / 2).translate(w / 2, h / 2, 0));
    if (rm.ceiling) add(new THREE.PlaneGeometry(w, d).rotateX(Math.PI / 2).translate(0, h, 0));
  }

  // a layer's three.js object, as the panel's makeObject builds it (without selection, gizmo or picking)
  make(o) {
    const x = { mine: (_, g) => this.meshes.get(o.id) === g, draw: () => this.loaded(o.id), lib: () => this.sparkLib() };
    let m;
    if (o.type === 'figure') {
      const rig = FIGURE.buildFigure(figClay, hidden, o.body);
      m = rig.root; m.userData.rig = rig;
    } else if (o.type === 'photo') {
      m = new THREE.Group(); this.waiting.add(o.id);
      photoScene(o.url).then((src) => { if (x.mine(o, m)) m.add(src.clone()); }).catch(() => {}).finally(() => this.loaded(o.id));
    } else if (makers[o.type]) {
      m = makers[o.type](o, x);
      if (o.ref || o.type === 'backdrop') this.waiting.add(o.id);   // (an object layer fills itself in once its library entry arrives)
    } else if (LOADERS[o.type]) {
      m = new THREE.Group(); this.waiting.add(o.id); LOADERS[o.type](o, m, x);
    } else m = new THREE.Mesh(geometries()[TYPES[o.type].geo || o.type], clay);
    m.visible = !o.hidden;
    this.scene.add(m); this.meshes.set(o.id, m);
  }

  async sparkLib() {
    const lib = await (SPARK ||= import('./vendor/spark.module.js'));
    if (!this.spark) { this.spark = new lib.SparkRenderer({ renderer: glr() }); this.scene.add(this.spark); }
    return lib;
  }

  // a layer that loads on its own time has arrived (or failed)
  loaded(id) {
    this.waiting.delete(id);
    const look = this.look; this.look = null;
    if (look) this.setLook(look);   // (what just loaded gets the look on show)
    this.version++;
    if (!this.waiting.size) { for (const r of this.waiters.splice(0)) r(); }
    this.onChange?.();
  }
  // resolves once every imported layer has loaded (or after `ms`: a failed one never says so)
  whenReady(ms = 20000) {
    if (!this.waiting.size) return Promise.resolve();
    return new Promise((res) => { this.waiters.push(res); setTimeout(res, ms); });
  }
  get loading() { return this.waiting.size > 0; }
  get hasSplat() { return [...this.meshes.values()].some((m) => m.userData.splat); }

  // ---- the look: what each layer is drawn with ----
  setLook(look) {
    if (this.look === look) return;
    this.look = look;
    const proxy = look === 'depth' || look === 'clay';   // a splat can't be clayed or depth-drawn: its box stands in
    this.scene.overrideMaterial = look === 'depth' ? depthMat : null;
    this.scene.background = new THREE.Color(look === 'depth' ? 0x000000 : BG);
    for (const o of this.sc.objects) {
      const m = this.meshes.get(o.id);
      if (!m) continue;
      if (m.userData.colorOnly) m.visible = look === 'color' && !o.hidden;   // footage and track points: colour only
      if (m.userData.model) applyClay(m, look === 'clay' || !!o.clay);
      if (m.userData.own) m.material = look === 'clay' ? clay : m.userData.own;   // an object layer keeps its colour except in clay
      const sp = m.userData.splat;
      if (sp) for (const c of m.children) c.visible = c === sp.proxy ? proxy : !proxy;
    }
    if (this.spark) this.spark.visible = !proxy;
  }

  // ---- the scene at frame f (24 per second; between frames is fine), as the panel's pose() sets it
  // up for a render: the real keys, no mute ----
  pose(f) {
    f = Math.max(0, f);
    const r = THREE.MathUtils.degToRad;
    for (const o of this.sc.objects) {
      const m = this.meshes.get(o.id);
      if (!m) continue;
      const v = sample(o, namesFor(o), f);
      m.position.set(v.x, v.y, v.z);
      m.rotation.set(r(v.rx), r(v.ry), r(v.rz));
      if (EVEN.has(o.type)) m.scale.setScalar(Math.max(0.01, v.sy));
      else m.scale.set(Math.max(0.01, v.sx), Math.max(0.01, v.sy), Math.max(0.01, v.sz));
      if (m.userData.rig) { FIGURE.applyPose(m.userData.rig, v.j, this.stepped(o, v.m, f), o.ground); FIGURE.setHidden(m.userData.rig, o.hide); }
      m.userData.atFrame?.(f);
    }
    const c = sample(this.sc.camera, CAM, f);
    this.camera.position.set(c.px, c.py, c.pz);
    this.camera.lookAt(c.tx, c.ty, c.tz);
    applyRoll(this.camera, c.roll);
    this.camera.fov = c.fov;
    this.camera.updateProjectionMatrix(); this.camera.updateMatrixWorld();
  }
  // a walk or run steps with the distance covered (scene-view.js travelled/stepped, for this scene)
  travelled(o, f) {
    const sig = pathSig(o);
    let p = this.paths.get(o);
    if (!p || p.sig !== sig) {
      const d = [0];
      let prev = sample(o, OBJ, 0);
      for (let i = 1; i < this.frames; i++) { const v = sample(o, OBJ, i); d.push(d[i - 1] + Math.hypot(v.x - prev.x, v.z - prev.z)); prev = v; }
      p = { sig, d }; this.paths.set(o, p);
    }
    const i = Math.min(Math.floor(f), p.d.length - 1), j = Math.min(i + 1, p.d.length - 1);
    return p.d[i] + (p.d[j] - p.d[i]) * Math.min(1, f - i);
  }
  stepped(o, m, f) {
    if (!m || !(m.walk || m.run) || o.stepsFollow === false) return m;
    return { ...m, phase: this.travelled(o, f) / (FIGURE.strideLength(m) * sample(o, OBJ, f).sy) };
  }

  // ---- drawing ----
  // frame f drawn over the whole of canvas cv (its size is the render size)
  draw(look, f, cv) {
    const W = cv.width, H = cv.height;
    this.setLook(look);
    const range = look === 'depth' ? this.depthRange() : null;   // (measured first: it poses the scene through the whole clip)
    this.pose(f);
    this.camera.aspect = W / H; this.camera.updateProjectionMatrix();
    if (look === 'pose') return this.drawPose(cv);
    const gl = glr();
    if (gl.domElement.width !== W || gl.domElement.height !== H) gl.setSize(W, H, false);
    if (range) setRange(range);
    gl.render(this.scene, this.camera);
    cv.getContext('2d').drawImage(gl.domElement, 0, 0);
    if (look === 'color' && this.hasSplat) this.kick(`${f}|${W}`);
  }
  // the people as OpenPose stick figures (the panel's Pose video)
  drawPose(cv) {
    const W = cv.width, H = cv.height;
    const people = this.sc.objects.filter((o) => o.type === 'figure' && !o.hidden).map((o) => {
      const k = FIGURE.keypoints(this.meshes.get(o.id).userData.rig, o.hide);
      const pts = k.map((p) => {
        if (!p) return null;
        const v = p.project(this.camera);
        return v.z > 1 || v.z < -1 ? null : [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H];
      });
      pts.cut = k.cut;
      return pts;
    });
    FIGURE.drawPose(cv.getContext('2d'), people, W, H);
  }

  // A SparkRenderer sorts its splats on its own time, so a splat scene needs a few more draws after a
  // change before it looks right: they come as onChange calls (the key stops them repeating themselves)
  kick(key) {
    if (this.kicked === key) return;
    this.kicked = key; clearTimeout(this.timer);
    let n = 0;
    const go = () => { this.version++; this.onChange?.(); if (++n < 4) this.timer = setTimeout(go, 120 * n); };
    this.timer = setTimeout(go, 80);
  }
  // for an export: the splat sort needs time between a camera move and the picture
  async settle() { if (this.hasSplat) await sleep(140); }

  // near and far of the whole clip, measured once (as scene-export.js measureRange does, on every few frames)
  depthRange() {
    if (this.range) return this.range;
    const W = 128, H = Math.max(8, Math.round(128 * this.h / this.w)), gl = glr();
    const rt = new THREE.WebGLRenderTarget(W, H), buf = new Uint8Array(W * H * 4);
    const bg = this.scene.background, over = this.scene.overrideMaterial;
    this.scene.background = null; this.scene.overrideMaterial = rangeMat;
    gl.setClearColor(0x000000, 0);
    const step = Math.max(1, Math.ceil(this.frames / 48));
    let near = Infinity, far = 0;
    for (let f = 0; f < this.frames + step - 1; f += step) {
      this.pose(Math.min(f, this.frames - 1));
      this.camera.aspect = this.w / this.h; this.camera.updateProjectionMatrix();
      gl.setRenderTarget(rt); gl.clear(); gl.render(this.scene, this.camera);
      gl.readRenderTargetPixels(rt, 0, 0, W, H, buf);
      for (let i = 0; i < buf.length; i += 4) {
        if (buf[i + 3] < 128) continue;
        const z = (buf[i] / 255 + buf[i + 1] / 65025 + buf[i + 2] / 16581375) * RANGE;
        if (z < near) near = z;
        if (z > far) far = z;
      }
    }
    gl.setRenderTarget(null); gl.setClearColor(0x000000, 1); rt.dispose();
    this.scene.background = bg; this.scene.overrideMaterial = over;
    this.range = isFinite(near) ? [Math.max(0.05, near * 0.97), far * 1.03] : [0.3, 10];
    return this.range;
  }

  dispose() {
    clearTimeout(this.timer); this.onChange = null;
    for (const m of this.meshes.values()) {
      m.userData.dispose?.();
      if (m.userData.model) m.traverse((c) => { if (c.isMesh) { c.geometry.dispose(); } });
    }
    this.spark?.dispose?.();
    this.scene.clear(); this.meshes.clear();
  }
}
