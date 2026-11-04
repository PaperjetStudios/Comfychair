// One tab system for every panel. A panel makes a TabSet with a payload adapter and gets: a strip of
// tabs on the bar under the main navigation (layout.js docStrip; create, rename, duplicate, delete with Undo, drag to reorder), each saved as a document of
// its own kind in the project folder (app/store.py), debounced autosave, live updates from other
// devices, and conflict handling. It never touches the panel's UI: it only calls adapter.load/dump.
//
//   const tabs = new TabSet({ kind: 'gen-tabs', host: $('#tab-generate'), scope: 'project', newName: (n) => `Tab ${n}`,
//     adapter: { empty(), load(payload, doc), dump(), migrate?(payload), beforeLeave?() }, seed?(), onSwitch?(doc) });
//   (beforeLeave: awaited before the tab is saved and left, for writes the payload must name first)
//   await tabs.start();   // when the panel first needs its tabs (it also reloads itself on project change)
//   tabs.changed();       // after every edit: marks dirty, saves ~1 s later
//   await tabs.flush();   // save now (before generate/render, on hide); true when saved
//   tabs.active           // { id, name, rev, order } of the tab on show, or null
import { h, api, store, toast, undoToast, openSheet, closeSheet, nameSheet, button, actions, uid, clone } from './ui.js';
import { S, onServer, onProject } from './core.js';
import { keyboardFocus } from './key-focus.js';
import { docStrip } from './layout.js';
import { dropIndex, slideOf } from './tab-order.js';
import { sitsEmpty } from './table-model.js';

const SAVE_DELAY = 1000, DRAG_PX = 6, HOLD_MS = 350, EDGE_PX = 40;
const TIMEOUT = 30000;


export class TabSet {
  constructor(o) {
    Object.assign(this, { scope: 'project', newName: (n) => `Tab ${n}`, ...o });
    this.docs = [];               // list rows: { id, name, order, rev, updated }
    this.active = null;           // the tab on show: { id, name, rev, order }
    this.pid = null;
    this.epoch = 0;               // bumped on (re)load so slow answers for an old project are dropped
    this.dirty = false; this.dirtyGen = 0; this.pendingName = null;
    this.inflight = null; this.timer = 0; this.conflict = null; this.offline = false;
    this.trashedHere = new Set();   // ids this page deleted itself (forget): their going from the list is no news
    this.loading = false; this.drag = null; this.started = false; this.refreshSeq = 0; this.switchSeq = 0;
    this.row = h('div', { class: 'tabrow', role: 'tablist' });
    this.row.setAttribute('aria-label', 'Documents');
    this.row.addEventListener('keydown', (e) => {
      const buttons = [...this.row.querySelectorAll('.tab-switch')], at = buttons.indexOf(e.target);
      if (at < 0 || !keyboardFocus()) return;   // (a tab only clicked leaves the arrows to the player)
      const to = { ArrowLeft: (at - 1 + buttons.length) % buttons.length, ArrowRight: (at + 1) % buttons.length, Home: 0, End: buttons.length - 1 }[e.key];
      if (to == null) return;
      e.preventDefault(); buttons[to].focus(); buttons[to].click();
    });
    // one row, like a browser's: the wheel runs along it
    this.row.addEventListener('wheel', (e) => {
      if (e.deltaX || this.row.scrollWidth <= this.row.clientWidth) return;
      e.preventDefault(); this.row.scrollLeft += e.deltaY;
    }, { passive: false });
    // while a tab is lifted for dragging, the strip must not scroll under the finger
    this.row.addEventListener('touchmove', (e) => { if (this.drag?.started && e.cancelable) e.preventDefault(); }, { passive: false });
    this.state = h('button', { type: 'button', class: 'tabs-state hidden', onclick: () => this.conflict && this.showConflict() });
    this.plus = h('button', { type: 'button', class: 'icon-btn tab-plus', 'aria-label': 'New tab', title: 'New tab', onclick: () => this.create() }, '＋');
    this.mount = h('div', { class: 'tabstrip' }, this.row, this.plus, this.state);
    docStrip(this.host, this.mount, () => this.reveal());
    new ResizeObserver(() => this.reveal()).observe(this.row);   // (a narrower window, a tablet turned)

    onServer('store', (m) => this.onStore(m));
    onServer('ws_open', () => { if (!this.active) this.start(); else { this.refresh(); if (this.dirty) this.flush(); } });
    onProject(() => { if (this.scope !== 'global' && this.started) this.start(); });
    // hidden / closing: save now (small bodies go with keepalive so they survive the page going away)
    document.addEventListener('visibilitychange', () => { if (document.hidden) { this.stash(); this.flush(); } else if (this.started) this.refresh(); });
    addEventListener('pagehide', () => { this.stash(); this.flush(); });
  }

  // A document this page is about to delete itself (a table frame's, table-frames.js trashDoc): when it drops out of the
  // list, say nothing and fetch nothing. unforget(id): the delete failed, or an Undo restored it.
  forget(id) { if (id) this.trashedHere.add(id); }
  unforget(id) { this.trashedHere.delete(id); }
  // On a project whose tables own the documents, no document open: the panel's engine shows an empty one (not the last
  // project's or the deleted frame's content). The adapter takes the empty payload with id null.
  clearPanel() {
    if (this.active || !this.ownedByTables) return;
    this.setDirty(false);
    this.apply(this.adapter.empty(), { id: null, name: '', rev: 0, order: 0 });
  }

  // true when this project's tables own the documents, so this set makes none of its own
  get ownedByTables() { return this.scope !== 'global' && sitsEmpty(this.kind, S.projects?.find((p) => p.id === this.pid)); }

  // ---- addressing ----
  get qs() { return this.scope === 'global' ? '?scope=global' : this.pid != null ? `?project_id=${this.pid}` : ''; }
  url(id = '', tail = '') { return `/api/store/${this.kind}${id ? `/${id}` : ''}${tail}${this.qs}`; }
  get key() { return `${this.scope === 'global' ? 'g' : this.pid ?? 'none'}`; }
  bakKey(id) { return `deck.tabbak.${this.kind}.${this.key}.${id}`; }
  migrate(p) { return this.adapter.migrate ? this.adapter.migrate(p || {}) : (p || {}); }

  // ---- starting / project switch ----
  // Load (or reload, for the current project) the list and open the remembered tab. Flushes the old
  // project's tab first, to the old project's folder (this.pid is only replaced after).
  start() {
    const pid = this.scope === 'global' ? null : (S.project ?? null);
    if (this.starting && this.requestedPid === pid) return this.starting;
    this.requestedPid = pid;
    const pending = this.load();
    this.starting = pending;
    pending.finally(() => { if (this.starting === pending) this.starting = null; });
    return pending;
  }
  async ready() {
    if (this.starting) await this.starting;
    else if (!this.active) await this.start();
    if (!this.active) throw new Error('This document has not loaded. Retry before editing.');
  }
  // Block every editor surface until its saved document is ready, including project switches.
  gate(message = null) {
    const { host } = this;
    if (!message) {
      for (const [el, inert] of this.blocked || []) el.inert = inert;
      this.blocked = null; this.loadStatus?.remove();
      host.removeAttribute('aria-busy');
      return;
    }
    if (!this.loadStatus) this.loadStatus = h('div', { class: 'document-loading', role: 'status', 'aria-live': 'polite' });
    if (!this.blocked) this.blocked = new Map();
    const surfaces = [...host.children, this.mount];
    if (host.id === 'tab-generate') surfaces.push(document.querySelector('.actionbar'));
    for (const el of surfaces) if (el && el !== this.loadStatus && !this.blocked.has(el)) { this.blocked.set(el, el.inert); el.inert = true; }
    host.setAttribute('aria-busy', 'true');
    this.loadStatus.replaceChildren(h('span', {}, message), this.offline ? button('Retry', () => this.start()) : null);
    host.append(this.loadStatus);
  }
  async load() {
    this.started = true;
    const ep = ++this.epoch;
    this.setOffline(false); this.gate('Loading document…');
    await this.flush();
    if (ep !== this.epoch) return;
    clearTimeout(this.timer);
    this.pid = this.scope === 'global' ? null : (S.project ?? null);
    this.active = null; this.conflict = null; this.pendingName = null; this.setDirty(false);
    this.docs = []; this.render();
    try {
      let list = await api(this.url(), { busy: false });
      if (ep !== this.epoch) return;
      this.docs = list;
      let doc;
      if (!list.length && this.ownedByTables) {
        this.setOffline(false); this.render(); this.gate(); this.clearPanel();
        return;
      }
      if (!list.length) {
        // first run here: 'main' is a fixed id so two devices seeding at once end up with one tab
        doc = await this.create1({ id: 'main', name: this.newName(1), payload: (this.seed && this.seed()) || this.adapter.empty() });
        if (ep !== this.epoch) return;
      } else {
        const want = store.get(`deck.tab.${this.kind}.${this.key}`, null);
        const id = list.some((d) => d.id === want) ? want : list[0].id;
        doc = await api(this.url(id), { busy: false });
        if (ep !== this.epoch) return;
      }
      this.setOffline(false);
      this.open(doc);
      this.gate();
    } catch (e) {
      if (ep !== this.epoch) return;
      this.setOffline(true);   // ws_open retries start() once the server is back
      this.render();
      this.gate(`Could not load document: ${e.message}`);
    }
  }

  // ---- showing a tab ----
  open(doc) {
    this.active = { id: doc.id, name: doc.name, rev: doc.rev, order: doc.order };
    this.upsert(doc);
    let payload = this.migrate(doc.payload), restored = false;
    // unsaved edits kept from an offline stretch, if the server's copy hasn't moved since
    const bak = store.get(this.bakKey(doc.id), null);
    if (bak && bak.rev === doc.rev && bak.payload) { payload = this.migrate(bak.payload); restored = true; }
    this.pendingName = restored && bak.name && bak.name !== doc.name ? bak.name : null;
    if (this.pendingName) this.active.name = this.pendingName;
    this.apply(payload, doc);
    this.conflict = null;
    this.setDirty(restored);
    if (restored) this.timer = setTimeout(() => this.flush(), SAVE_DELAY);
    store.set(`deck.tab.${this.kind}.${this.key}`, doc.id);
    this.render();
    this.onSwitch?.(doc);
  }
  apply(payload, doc) {
    this.loading = true;   // the panel's load() may fire its own change events; they aren't edits
    try { this.adapter.load(payload, doc); } catch (e) { console.error(e); toast(`Couldn't show this tab: ${e.message}`, true); }
    finally { this.loading = false; }
  }
  upsert(m) {
    const row = { id: m.id, name: m.name, order: m.order, rev: m.rev, updated: m.updated };
    const i = this.docs.findIndex((d) => d.id === m.id);
    if (i < 0) this.docs.push(row); else this.docs[i] = row;
    this.docs.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
  }
  // leave the current tab: save it; a pending conflict blocks leaving (it would be lost)
  async leave() {
    try { await this.adapter.beforeLeave?.(); } catch (e) { console.warn(e); }   // the panel's own last writes (the Editor's paint files)
    await this.flush();
    if (this.conflict) { toast('Resolve the conflict on this tab first', true); this.showConflict(); return false; }
    return true;
  }
  async switchTo(id) {
    if (this.active?.id === id) return;
    const seq = ++this.switchSeq, ep = this.epoch;
    if (!(await this.leave()) || seq !== this.switchSeq || ep !== this.epoch) return;
    try {
      const doc = await api(this.url(id), { busy: false });
      if (seq !== this.switchSeq || ep !== this.epoch) return;
      this.open(doc);
    } catch (e) { toast(`Couldn't open the tab: ${e.message}`, true); this.refresh(); }
  }

  // ---- editing / saving ----
  changed() {
    if (this.loading || !this.active) return;
    this.dirtyGen++;
    this.setDirty(true);
    clearTimeout(this.timer);
    if (!this.conflict) this.timer = setTimeout(() => this.flush(), SAVE_DELAY);
  }
  setDirty(on) {
    this.dirty = on;
    this.row.querySelector('.tabchip.on .tab-dot')?.classList.toggle('on', on);
  }
  setOffline(on) {
    this.offline = on;
    this.showState();
  }
  showState() {
    const t = this.conflict ? 'Changed elsewhere · resolve' : this.offline ? 'Offline · not saved yet' : '';
    this.state.textContent = t;
    this.state.classList.toggle('hidden', !t);
    this.state.classList.toggle('conflict', !!this.conflict);
  }
  // a synchronous local copy of unsaved edits: the network save may not survive the page going away
  // (the copy is applied on the next load if the server's tab hasn't moved on, and dropped after a save)
  stash() {
    if (!this.dirty || !this.active || this.conflict || this.loading) return;
    store.set(this.bakKey(this.active.id), { rev: this.active.rev, name: this.pendingName ?? this.active.name, payload: this.adapter.dump() });
  }
  // true when everything is saved. One save in flight at a time; edits made meanwhile go in the next one.
  async flush() {
    clearTimeout(this.timer);
    for (;;) {
      if (this.inflight) { await this.inflight.catch(() => {}); continue; }
      if (!this.dirty || !this.active) return true;
      if (this.conflict) return false;
      const p = this.save();
      this.inflight = p;
      let ok;
      try { ok = await p; } finally { if (this.inflight === p) this.inflight = null; }
      if (!ok) return false;
    }
  }
  async put(id, body) {
    const s = JSON.stringify(body), ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const r = await fetch(this.url(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: s, signal: ctl.signal, keepalive: s.length < 60000 });
      let data = null; try { data = await r.json(); } catch { /* not JSON */ }
      return { ok: r.ok, status: r.status, data };
    } catch { return { net: true }; } finally { clearTimeout(t); }
  }
  async save() {
    const tab = this.active, ep = this.epoch, gen = this.dirtyGen, name = this.pendingName;
    const payload = this.adapter.dump();
    const r = await this.put(tab.id, { rev: tab.rev, payload, ...(name != null ? { name } : {}) });
    if (ep !== this.epoch || this.active !== tab) return true;   // switched away meanwhile (flush came first, so nothing is lost)
    if (r.net || (!r.ok && r.status !== 409)) {
      // keep the edits locally too, so a reload while offline doesn't lose them
      store.set(this.bakKey(tab.id), { rev: tab.rev, name: this.pendingName ?? tab.name, payload });
      this.setOffline(true);
      return false;
    }
    if (r.status === 409 && r.data?.error && !r.data?.doc) { toast(r.data.error, true); return false; }   // (a refusal with a reason, not a changed document)
    if (r.status === 409) { this.showConflict(r.data?.doc ?? null); return false; }
    this.setOffline(false);
    tab.rev = r.data.rev; tab.name = r.data.name;
    this.upsert(r.data);
    try { localStorage.removeItem(this.bakKey(tab.id)); } catch { /* storage unavailable */ }
    if (this.pendingName === name) this.pendingName = null;
    if (this.dirtyGen === gen && this.pendingName == null) this.setDirty(false);
    else { this.setDirty(true); this.timer = setTimeout(() => this.flush(), SAVE_DELAY); }
    return true;
  }

  // ---- conflicts: the server's copy moved on (another device saved, or deleted it) ----
  showConflict(doc = this.conflict?.doc ?? null) {
    this.conflict = { doc }; clearTimeout(this.timer); this.showState();
    const tab = this.active;
    if (!doc) {
      openSheet(h('h3', {}, 'This tab was deleted elsewhere'), h('p', { class: 'hint sheet-hint' }, `"${tab.name}" no longer exists on the server. Your unsaved changes are still here.`),
        actions(button('Keep as new tab', async () => {
          closeSheet();
          const r = await this.put(tab.id, { rev: 0, name: tab.name, order: tab.order, payload: this.adapter.dump() });
          if (!r.ok) { toast('Couldn\'t save the tab', true); return; }
          this.conflict = null; tab.rev = r.data.rev; this.upsert(r.data); this.setDirty(false); this.showState();
        }, { cls: 'primary' }), button('Discard my changes', () => { closeSheet(); this.dropActive(); }, { cls: 'ghost danger' })));
      return;
    }
    openSheet(h('h3', {}, 'Changed on another device'), h('p', { class: 'hint sheet-hint' }, `"${doc.name}" was saved somewhere else while you were editing it.`),
      actions(button('Load theirs', () => {
        closeSheet();
        this.conflict = null; this.pendingName = null;
        Object.assign(tab, { rev: doc.rev, name: doc.name, order: doc.order }); this.upsert(doc);
        this.apply(this.migrate(doc.payload), doc);
        this.setDirty(false); this.render(); this.onSwitch?.(doc);
      }), button('Keep mine', () => {
        closeSheet();
        tab.rev = doc.rev; this.conflict = null; this.showState(); this.flush();
      }, { cls: 'primary' })));
  }

  // ---- list refresh / live updates ----
  onStore(m) {
    if (m.kind !== this.kind || !this.started) return;
    if (this.scope === 'global' ? m.scope !== 'global' : m.scope !== 'project' || (m.project_id ?? null) !== this.pid) return;
    clearTimeout(this.rt); this.rt = setTimeout(() => this.refresh(), 150);
  }
  async refresh() {
    if (!this.started || !this.epoch) return;
    const seq = ++this.refreshSeq, ep = this.epoch;
    let list;
    try { list = await api(this.url(), { busy: false }); } catch { return; }
    if (seq !== this.refreshSeq || ep !== this.epoch) return;   // a newer answer is on its way
    const a = this.active, was = a ? this.docs.findIndex((d) => d.id === a.id) : -1;   // where it sat, to pick its neighbour
    this.docs = list;
    if (a) {
      const me = list.find((d) => d.id === a.id);
      if (!me) await this.vanished(a, ep, was);
      else {
        if (me.name !== a.name && this.pendingName == null) a.name = me.name;
        a.order = me.order;
        // changed elsewhere: pick it up quietly unless we have edits of our own (the 409 path covers those)
        if (me.rev > a.rev && !this.dirty && !this.inflight && !this.conflict) {
          try {
            const doc = await api(this.url(a.id), { busy: false });
            if (ep === this.epoch && this.active === a && !this.dirty && !this.inflight && doc.rev > a.rev) {
              Object.assign(a, { rev: doc.rev, name: doc.name, order: doc.order });
              this.apply(this.migrate(doc.payload), doc); this.onSwitch?.(doc);
            }
          } catch { /* next update will do */ }
        }
      }
    }
    this.render();
  }
  // the active tab isn't in the list: check it's really gone (the list may predate a create of ours)
  async vanished(a, ep, was) {
    if (this.trashedHere.delete(a.id)) {   // our own delete (a table frame going): nothing to check, nothing to say
      if (ep === this.epoch && this.active === a) await this.dropActive(true, was);
      return;
    }
    try { await api(this.url(a.id), { busy: false }); return; } catch (e) { if (!/not found/i.test(e.message)) return; }
    if (ep !== this.epoch || this.active !== a) return;
    if (this.dirty || this.inflight) { if (!this.conflict) this.showConflict(null); return; }
    toast(`"${a.name}" was deleted on another device`);
    this.dropActive(true, was);
  }
  // the active tab is gone: show its neighbour (or a fresh blank one), without deleting anything
  async dropActive(quiet = false, was = this.docs.findIndex((d) => d.id === this.active.id)) {
    const i = Math.max(0, was);
    this.docs = this.docs.filter((d) => d.id !== this.active.id);
    this.active = null; this.conflict = null; this.pendingName = null; this.setDirty(false);
    const ep = this.epoch;
    try {
      let doc;
      if (this.docs.length) doc = await api(this.url(this.docs[Math.min(i, this.docs.length - 1)].id), { busy: false });
      else if (this.ownedByTables) { this.render(); this.clearPanel(); return; }
      else doc = await this.create1({ name: this.newName(1), payload: this.adapter.empty() });
      if (ep === this.epoch) this.open(doc);
    } catch (e) { if (!quiet) toast(e.message, true); this.render(); }
  }

  // ---- create / rename / duplicate / delete ----
  freeName(base) {
    const names = new Set(this.docs.map((d) => d.name));
    for (let n = this.docs.length + 1; ; n++) { const s = base(n); if (!names.has(s)) return s; }
  }
  // PUT a new document; if the id already exists (two devices seeding at once) use the server's copy
  async create1({ id = uid() + uid(), name, payload, order }) {
    const r = await this.put(id, { rev: 0, name, payload, ...(order != null ? { order } : {}) });
    if (r.net) throw new Error('Can\'t reach ComfyChair (is the server running and on this network?)');
    if (r.ok) { this.upsert(r.data); return r.data; }
    if (r.status === 409 && r.data?.doc) { this.upsert(r.data.doc); return r.data.doc; }
    throw new Error(r.data?.detail || r.data?.error || `Couldn't create the tab (${r.status})`);
  }
  async create() {
    if (!(await this.leave())) return;
    try { this.open(await this.create1({ name: this.freeName(this.newName), payload: this.adapter.empty() })); } catch (e) { toast(e.message, true); }
  }
  // a new tab from a payload, named after the one on show
  async createFrom(payload, suffix) {
    const a = this.active;
    if (!(await this.leave())) return;
    try { this.open(await this.create1({ name: `${a?.name || 'Tab'} ${suffix}`.slice(0, 120), payload, ...(a ? { order: a.order + 0.5 } : {}) })); } catch (e) { toast(e.message, true); }
  }
  async duplicate() {
    if (!(await this.leave())) return;
    const a = this.active;
    try {
      if (this.kind === 'tables') {   // (a table owns copies of its documents: the server makes the copy, a copied payload would be refused)
        const r = await fetch(this.url(a.id, '/duplicate'), { method: 'POST' });
        let data = null; try { data = await r.json(); } catch { /* not JSON */ }
        if (!r.ok) throw new Error(data?.error || data?.detail || `Couldn't duplicate the table (${r.status})`);
        this.upsert(data); this.open(data);
        return;
      }
      this.open(await this.create1({ name: `${a.name} copy`.slice(0, 120), payload: clone(this.adapter.dump()), order: a.order + 0.5 }));
    } catch (e) { toast(e.message, true); }
  }
  // rename(name) sets the open tab's name and saves it. rename() asks for the name first.
  async rename(name) {
    const a = this.active;
    if (!a) return false;
    if (name === undefined) {
      nameSheet({ title: 'Rename tab', placeholder: a.name, saveLabel: 'Rename', save: async (n) => {
        if (!n) throw new Error('Type a name');
        await this.rename(n);
      } });
      return false;
    }
    this.pendingName = String(name).slice(0, 120); a.name = this.pendingName;
    this.setDirty(true); this.render();
    return this.flush();
  }
  async remove() {
    const a = this.active;
    if (!a) return;
    clearTimeout(this.timer);
    while (this.inflight) await this.inflight.catch(() => {});   // let a running save land first, or it would recreate the file
    this.conflict = null; this.pendingName = null; this.setDirty(false);
    const idx = this.docs.findIndex((d) => d.id === a.id), ep = this.epoch;
    try {
      // never leave zero tabs: the blank one exists before the old one goes
      const fresh = this.docs.length <= 1 && !this.ownedByTables ? await this.create1({ name: this.newName(1), payload: this.adapter.empty() }) : null;
      try { await api(this.url(a.id), { method: 'DELETE', busy: false }); } catch (e) { if (!/not found/i.test(e.message)) throw e; }
      try { localStorage.removeItem(this.bakKey(a.id)); } catch { /* storage unavailable */ }
      this.docs = this.docs.filter((d) => d.id !== a.id);
      const next = fresh || (this.docs.length ? await api(this.url(this.docs[Math.min(idx, this.docs.length - 1)].id), { busy: false }) : null);
      if (ep !== this.epoch) return;
      if (next) this.open(next); else { this.active = null; this.render(); this.clearPanel(); }
      undoToast(`Deleted "${a.name}"`, async () => {
        try {
          if (ep !== this.epoch || !(await this.leave())) return;
          const doc = await api(this.url(a.id, '/restore'), { method: 'POST', busy: false });
          this.upsert(doc); this.open(doc);
        } catch (e) { toast(e.message, true); }
      });
    } catch (e) { toast(e.message, true); this.refresh(); }
  }
  menu() {
    const a = this.active;
    openSheet(h('h3', {}, a.name), h('div', { class: 'tab-menu' },
      button('Rename', () => this.rename(), { cls: 'ghost' }),
      button('Duplicate', () => { closeSheet(); this.duplicate(); }, { cls: 'ghost' }),
      button('Delete', () => { closeSheet(); this.remove(); }, { cls: 'ghost danger' })));
  }

  // ---- the strip ----
  render() {
    if (this.drag?.started) { this.drag.stale = true; return; }
    const a = this.active;
    const focused = this.row.contains(document.activeElement);
    this.row.replaceChildren(...this.docs.map((d) => {
      const on = a?.id === d.id;
      return h('div', { class: 'tabchip' + (on ? ' on' : ''), 'data-id': d.id, role: 'presentation',
        onpointerdown: (e) => this.dragStart(e, d.id) },
      h('button', { type: 'button', class: 'tab-switch', role: 'tab', 'aria-selected': String(on), tabIndex: on ? 0 : -1,
        onclick: () => { if (!this.justDragged) this.switchTo(d.id); } },
        h('span', { class: 'tab-name' }, on ? a.name : d.name),
        on ? h('span', { class: 'tab-dot' + (this.dirty ? ' on' : '') }) : null),
      on ? h('button', { type: 'button', class: 'tab-more', 'aria-label': 'Tab options', onclick: (e) => { e.stopPropagation(); this.menu(); } }, '⋯') : null);
    }));
    this.reveal();
    this.showState();
    if (focused) this.row.querySelector('.tabchip.on .tab-switch')?.focus({ preventScroll: true });
  }
  // keep the open tab in view by scrolling the strip itself: scrollIntoView also scrolls every scrolling ancestor
  reveal() {
    const on = this.row.querySelector('.tabchip.on');
    if (!on) return;
    const r = this.row, left = on.offsetLeft;
    if (left < r.scrollLeft) r.scrollLeft = left;
    else if (left + on.offsetWidth > r.scrollLeft + r.clientWidth) r.scrollLeft = left + on.offsetWidth - r.clientWidth;
  }

  // Drag to reorder. Mouse: after moving a few pixels. Touch: after holding still for a moment (a
  // plain swipe scrolls the strip). The chips don't move in the DOM while dragging (that would drop
  // pointer capture); they slide with transforms and the new order is applied on release.
  dragStart(e, id) {
    if (e.button > 0 || e.target.closest('.tab-more') || this.drag) return;
    const chip = e.currentTarget, touch = e.pointerType !== 'mouse';
    const d = this.drag = { id, chip, x0: e.clientX, y0: e.clientY, pid: e.pointerId, touch, started: false, lastX: e.clientX, lastY: e.clientY, from: -1, to: -1 };
    const move = (ev) => {
      if (ev.pointerId !== d.pid) return;
      d.lastX = ev.clientX; d.lastY = ev.clientY;
      if (!d.started) {
        const dist = Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0);
        if (touch) { if (dist > 10) cancel(); }   // a swipe before the hold: let the strip scroll
        else if (dist > DRAG_PX) lift();
        return;
      }
      ev.preventDefault();
    };
    const lift = () => {
      clearTimeout(d.hold);
      const chips = [...this.row.children];
      d.chips = chips;
      d.from = chips.indexOf(chip); d.to = d.from;
      d.rects = chips.map((c) => ({ left: c.offsetLeft, top: c.offsetTop, w: c.offsetWidth, h: c.offsetHeight }));
      d.scroll0 = this.row.scrollLeft;
      d.started = true;
      try { chip.setPointerCapture(d.pid); } catch { /* pointer gone */ }
      chips.forEach((c) => c.classList.add('shifting'));
      chip.classList.add('lift');
      if (navigator.userActivation?.hasBeenActive) try { navigator.vibrate?.(8); } catch { /* no haptics */ }   // (an unprompted vibrate is logged as an error)
      d.raf = requestAnimationFrame(tick);
    };
    // each frame: auto-scroll near the strip's edges, then place the lifted chip and slide the others
    const tick = () => {
      if (!d.started) return;
      const r = this.row.getBoundingClientRect();
      if (d.lastX < r.left + EDGE_PX) this.row.scrollLeft -= Math.ceil((EDGE_PX - (d.lastX - r.left)) / 4);
      else if (d.lastX > r.right - EDGE_PX) this.row.scrollLeft += Math.ceil((EDGE_PX - (r.right - d.lastX)) / 4);
      const dx = d.lastX - d.x0 + (this.row.scrollLeft - d.scroll0), dy = 0;   // (one row: it only slides along)
      const me = d.rects[d.from], to = dropIndex(d.rects, d.from, me.left + me.w / 2 + dx, me.top + me.h / 2);
      d.to = to;
      d.chips.forEach((c, i) => {
        if (i === d.from) { c.style.transform = `translate(${dx}px, ${dy}px)`; return; }
        const by = slideOf(d.rects, d.from, to, i);
        c.style.transform = by ? `translate(${by[0]}px, ${by[1]}px)` : '';
      });
      d.raf = requestAnimationFrame(tick);
    };
    const cancel = () => { clearTimeout(d.hold); cleanup(); };
    const cleanup = () => {
      cancelAnimationFrame(d.raf); clearTimeout(d.hold);
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      if (d.started) d.chips.forEach((c) => { c.style.transform = ''; c.classList.remove('shifting', 'lift'); });
      this.drag = null;
    };
    const up = (ev) => {
      if (ev.pointerId !== d.pid) return;
      const was = d.started, from = d.from, to = d.to, stale = d.stale;
      cleanup();
      if (!was) return;
      this.justDragged = true; setTimeout(() => { this.justDragged = false; }, 0);   // the click that follows a drag isn't a tap
      if (ev.type === 'pointercancel') { if (stale) this.render(); return; }
      if (from !== to) this.reorder(from, to); else if (stale) this.render();
    };
    addEventListener('pointermove', move, { passive: false });
    addEventListener('pointerup', up); addEventListener('pointercancel', up);
    if (touch) d.hold = setTimeout(() => { lift(); }, HOLD_MS);
  }
  async reorder(from, to) {
    const [m] = this.docs.splice(from, 1);
    this.docs.splice(to, 0, m);
    this.docs.forEach((x, i) => { x.order = i; });
    if (this.active) this.active.order = this.docs.find((x) => x.id === this.active.id)?.order ?? this.active.order;
    this.render();
    try { await api(this.url('reorder'), { method: 'POST', body: { ids: this.docs.map((x) => x.id) }, busy: false }); }
    catch (e) { toast(`Couldn't save the tab order: ${e.message}`, true); this.refresh(); }
  }
}
