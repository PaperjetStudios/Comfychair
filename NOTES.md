# ComfyChair review notes (2026-10-24)

A review of the whole codebase from the point of view of "run ComfyUI from a tablet on the LAN",
and what was done about each point (branch `tablet-fixes`). There was no XSS to fix: the UI never
uses `innerHTML`, and `h()` only sets text.

## Done
Resync and run state
- **Reconnect resyncs** (`syncWithServer` in `web/app.js`): on every socket (re)open, on waking
  (`visibilitychange`, `pageshow`, `online`) and after a reload. It picks a running job's progress
  and stage strip back up (`/api/jobs` now returns the running job's stages), and shows results that
  landed while the tablet was away.
- **The socket reconnects with backoff**: one socket and one ping timer (it used to leak a timer per
  reconnect). A dead socket is replaced on wake.
- **"Mine" survives reloads**: the runs queued from this device are kept in localStorage.
- **Race fixed**: with an idle queue, ComfyUI could start (or finish) a run before the Generate reply
  arrived, so the run looked like another device's. `adoptGenerations` catches up.
- **Lost runs** (`reconcile_loop` in `app/main.py`): a run that is in neither ComfyUI's queue nor its
  history for 25 s is marked interrupted. Video renders cut off by a restart are marked failed at
  startup.
- **LIVE frame cleared** after Stop or an error, and 15 s after the end if no result came. The preview
  loop sleeps between still frames instead of running at 60 fps.
- **"Finished in Xs" stays up** for 6 s instead of being wiped by the queue-empty message.

Several devices
- **Only your own runs take over the viewer.** Another device's previews are ignored, and its runs
  show as "ComfyUI is busy with another device's run · 16/40".
- **Stop is scoped**: `/api/interrupt` takes a `prompt_id` (interrupt if running, remove if waiting,
  else nothing). It asks first after 30 s. With no run of yours going, it opens the Queue, whose Stop
  asks first and warns when the run is another device's.
- **Partial batch failures** return the runs that were queued, so the tablet follows them.

Tablet use
- **Screen stays on** during runs: the Wake Lock API over HTTPS, else a 2 s silent looping video
  (`web/keepawake.mp4`).
- **Done signals**: a chime (on runs over 15 s, or when the tab is hidden), vibration, ✓ in the tab
  title, and a system notification over HTTPS (through the service worker on Android).
- **Connection banner**: tells "can't reach ComfyChair" apart from "ComfyUI not connected". `api()`
  times out (30 s by default, longer for uploads, generate and LoRA lookups) with a clear message.
- **Back gesture** closes the top sheet, sketch pad, box editor or text popup instead of leaving the
  app. Sketch and boxes ask before discarding changes, and leaving the page with a drawing warns.
- **Undo** (in the toast) for deleting saved settings, snippets and prompt sets, Editor "Clear all"
  and layer delete, and Video clip delete.
- **History** updates only the card that changed; the Board refreshes when you switch project.
- **Touch targets** are bigger on touch screens (trim handles, track buttons, swatches, part-head
  icons, chips, LoRA checkbox, box handle, portrait splitter).
- **Smaller fixes**: zoom resets when the viewer resizes (rotation); the LoRA info sheet no longer
  reopens itself after you close it; timeline preloading stops at 400 MB and streams the rest; the
  snapshot object URL is revoked; ResizeObservers are disconnected; the parent link survives a failed
  Generate; Run again says when it's queued in another project; other tabs' setting changes are picked
  up (`storage` event); a template load failure says so instead of "No templates yet".

Server and setup
- **Optional `DECK_TOKEN`** gate (pages, files, API and websocket), with a `?token=` link that sets a
  cookie for a year.
- **`deploy/make-cert.sh`**: a local CA plus server certificate with openssl (mkcert isn't installed).
- **PWA**: PNG icons (an `apple-touch-icon` for iOS, 192/512 maskable icons) and `web/sw.js`
  (network-first, offline shell only, never caches API or files; HTTPS only).
- **Smaller fixes**: uploads are capped at 200 MB; a bad number gives a 400 instead of a 500; unused
  thumbnails are pruned after 30 days.
- **Tests**: `tests/test_core.py` (wildcards, field parsing, LoRA chains, empty-image drop, autogrow
  renumbering, accel and editsize injection). `dev/mock_comfy.py` now reports its queue like ComfyUI
  does and supports deleting from it.

## Verified
- Unit tests: 18 pass.
- API against the mock on :8191: scoped stop of running, queued and finished runs; lost-run marking
  after a simulated ComfyUI restart (about 36 s); token gate for http and the websocket; 400 on bad
  numbers.
- Headless Chrome, tablet viewport (31 checks): live preview; reload mid-run picks the run back up
  and shows the result; a second device's run doesn't take over; Stop doesn't touch the other
  device's run; the back gesture closes sheets and the sketch (asks with strokes); history adds one
  card without redrawing; your own Stop; the banner when the server goes down and comes back; Undo
  for Editor Clear all. No JS errors.

Housekeeping (second pass)
- **Deleting a generation also deletes ComfyUI's copy** in `ComfyUI/output/`. New outputs record
  where ComfyUI put them; older ones are found by name. Either way the file is only deleted if it's
  the same size as ComfyChair's copy, and never outside the output folder.
- **Old crop files are cleared**: `crop_*.png` in `ComfyUI/input/comfydeck/` that haven't been used
  for 30 days are removed at startup. Replaying a cropped run older than that needs the crop redone.
- **Outputs are streamed to disk** while saving (`comfy.download`) instead of held in memory.
- ComfyUI's folder defaults to `../ComfyUI` next to ComfyChair; `DECK_COMFY_DIR` overrides it, and
  `DECK_COMFY_DIR=""` turns this housekeeping off (the test stack runs that way).

## 3D poser rework (2026-10-25)
How it fits together (`web/figure.js` is the figure, `web/scene.js` the tab):
- **A figure's key** holds `j` (joint turns), `m` (parameters on top: lean, head tilt, legs apart,
  walk/run, squat %…) and `pn` (the name of the pose picked, for the prompt). Each joint's final turn
  is j × the parameters' turns. `readJoint` takes the parameters back out, so IK and the gizmo store
  only `j`. Parameters blend numerically between keys, and a key can carry its own `ease`.
- **Planted on the floor** (`o.ground`): the hips are lifted or lowered so the lowest vertex touches
  the floor, so Up means "off the floor". New figures have it on; older scenes load with it off.
- **Pivot** (`o.pivot`): the gizmo holds a stand-in object at the pivot (hips by default, or feet,
  centre of mass, head, any joint; Centre for photos) and the figure is turned around that point.
  The number boxes still turn it around its origin at the feet.
- **Walk/run** are curves of a step phase. With "Steps follow movement" on (the default), the phase is
  the distance travelled ÷ the stride length (cached per figure in `PATHS`), so feet don't slide.
- **Presets** are Euler degrees plus optional IK targets, solved once on a spare rig. **Pairs** pose
  two figures (`at` places the partner in the first figure's space). **Moves** write keys from the
  playhead. Saved poses go in `SC.poses` (this project) or localStorage `deck.figure.poses` (all
  projects).
- **Prompt from the poses** uses each key's `pn` to write what `<Subject N>` does, in order.
- **Testing**: node can `import('web/figure.js')` directly (three.js runs without a DOM). For
  pictures, a scratch page that calls `drawThumb` for every preset, shot in headless Chrome.

### 3D tab: modules, tabs, modes (2026-10-25)
- `scene.js` is the entry (`init/show/hide/projectChanged/open/addPhoto`) and owns the TabSet (kind
  `scene-tabs`, payload = the scene `SC`, v 1, `upgrade()` is the migrate). `scene-data.js` is the scene,
  keys/sampling and the per-tab undo list (needs nothing else; `hooks` tell the tab to save). `scene-view.js`
  is three.js (meshes, gizmo, photos, free view), `scene-export.js` playback and renders, `scene-ui.js`
  the panel/key sheet/toolbar/modes glue, `scene-pose.js` the figure tabs and prompt.
- First tab is seeded from the old `deck.scene.<project>` localStorage key (left in place). Opening a
  scene from History makes a new tab. A tab switch resets undo.
- **Modes** (`SC.mode`: `edit` | `camera` | `create`, per tab, not an undo step): `scene-modes.js` has
  `registerMode({ key, label, hint, panel, select, stage, view, lanes, frustum, enter, exit })` and
  `addModeSection(key, build)`; `scene-builtin.js` registers the three. Both are re-exported from
  `scene.js`, so a later file can import them from `./scene-modes.js` (no import cycle) or `./scene.js`.
- Modules are imported with `?v=` added by the server only for `from '...'` imports: never use a bare
  `import './x.js'` (it would load unversioned).

## Still open
- **Not tried on a real tablet**: whether the keep-awake video holds the screen on your device,
  notifications (need HTTPS and the CA installed), and the feel of the bigger touch targets.
- **3D poser**: the poses were tuned from their stick-figure pictures. Pairs where bodies touch
  (carry, lap, lying on top, straddle) need checking in 3D. Rotating around the pivot with the
  gizmo hasn't been checked by hand; moving has.

## Restarting the live server (:8190) remotely, without sudo
`comfydeck.service` has `Restart=on-failure`. A plain `kill` (SIGTERM) counts as a clean exit, so
systemd leaves it **stopped**. A SIGKILL counts as a failure, so systemd starts it again after
`RestartSec=5`:

```bash
kill -9 $(systemctl show comfydeck -p MainPID --value)   # restarts in ~5 s
sleep 8; systemctl show comfydeck -p MainPID -p ActiveState; curl -s localhost:8190/api/status
```

If it doesn't come back (`ActiveState` isn't `active`), start it by hand without sudo:
`setsid nohup ./run.sh >> /tmp/comfydeck.log 2>&1 < /dev/null &` from the repo folder. The service
will then fail to start until that process is stopped, so stop it before the next
`systemctl start`. Restart after any `app/*.py` change; `web/` changes are live on reload.

### 3D key sheet (scene-keys.js, keys.js)
- `keys.js` is the DOM-free key maths (move, scale around a frame, copy/paste, ease, snapshot/restore);
  `scene-keys.js` is the sheet (dope sheet, graph, selection, gestures, maximize, sheet height) and the
  bound API (`selectKeys, moveKeys, scaleKeys, copyKeys, pasteKeys, duplicateKeys, deleteKeys, setKeyEase`).
  A drag moves keys live from a snapshot and saves once on letting go: one undo step per gesture.
- A key's `ease` may now be `smooth | linear | in | out | const` (unknown names read as smooth); old files are unchanged.
- Curves (2026-10-28): `ease` can also be `auto | clamp | bezier` (keys.js `CURVES`). A key may carry its own handles
  `ti` / `to` = `[dt, dv]` (frames, channel units; `hb: true` = broken); without them `handleOf` works them out (auto:
  Catmull-Rom slope, a third of the way; clamp: monotone). A segment is a cubic bezier solved in time; only numbers get
  curves (joints and pose names under a curve ease blend smooth). The graph shows the selected keys' handles (drag them;
  an auto key becomes Bezier; Snap rounds to whole frames). The video export (`keyexpr.py`) ignores these names.
- **Mute** (`item.mute`, saved, `upgrade()` defaults it off): `current()`/`write()` in scene-data.js use values held
  in `MUTED` (not saved) instead of the keys, so a muted layer stays put and moving it writes no keys. Renders set
  `R.real` and use the real keys; Save frame is the picture on screen.
- Tests: `tests/keys.mjs` (run by `tests/test_keys.py`).
- **Editing while it plays** (2026-10-27): nothing that edits stops playback. A gesture is a hold *source*
  (`holdStart/letGo`: 'gizmo', 'orbit', 'tip', 'panel' = any pointer down in `#sceneBody` until a tick after it
  lets go). While a source holds and it plays, `write()` to an animated item (or any item with Record on) goes
  into `HOLD` per channel and `current()` shows it over the keys. When the last source lets go, `commitHolds()`
  keys the held channels at the hold's first frame (While playing ▸ Jump back on release, default on; the
  playhead seeks back there) or the release frame; with REC (`R.record`) it writes `recordInto()` (keys.js)
  every 3 frames over the span held; with Auto key off an animated item gets a TEMP with `play: true` (only its
  changed channels, on every frame) until ◆ Key. `WP` (localStorage `deck.scene.whileplaying`) says what shows
  while playing: gizmo, joint dots, frustum, grid, key sheet follows playhead. Seek during play re-bases the clock.

### Compositions: 3D scenes as video clips (scene-comp.js, scene-offscreen.js)
- A video clip `{ kind: 'scene', src: { scene: <scene-tabs id>, look: color|clay|depth|pose }, nat: [w, h], dur }` is only a
  link: the scene is read from the store (`scene-comp.js`) and rebuilt when a `store` event for `scene-tabs` arrives (debounced
  300 ms; while the Video tab is hidden it catches up on show). A deleted scene shows a placeholder and a warning on the clip.
  The clip's length follows the scene's unless trimmed; scene time = clip time - at + in.
- `scene-offscreen.js` `Stage(payload)`: its own THREE.Scene, one WebGL renderer shared by all stages. Layers are built by the
  panel's own code (`makers`, `LOADERS`, figure.js); those take an optional context `x = { mine, draw, lib }` for a scene built
  elsewhere. Depth range is measured once per stage. Loaded lazily (three.js) on the first scene clip.
- Export: each scene clip's frames are drawn at export size and rate and uploaded in batches to `POST /api/scene/clip`
  (temp mp4 in `data/tmp/sceneclips`, swept after a day); the render takes it as `src: { clip }`.

## Shared engines (2026-10-28, branch `unify-engines`)
The tabs that did the same job twice now share it:
- **Timeline** (`web/timeline.js`): Video and Sound. Clip lengths, cross-fades, scrub, move/trim with snapping, zoom/fit,
  split, delete with Undo, cross-fade with the previous clip, waveform peaks and media durations. Each tab keeps its own
  state, clip drawing, track heads and playback, and passes what differs (`canDrop`, `fadeGain(…, outOverlap)`). The
  export side shares `videoedit.timeline_items()` and `videoedit.check()`.
- **Runs** (`web/make.js`): every template run (Generate, VFX, clip effects, Sound makers, 3D motion, Run again) goes
  through `queueRun`; `waitGen`, `runAndWait`, the role-based field lookup (`ROLES`, `valuesByRole`) and
  `adoptGenerations` live there. `face: { kind, state }` is kept as `params.__face` (VFX: Replay & edit reopens it there).
- **Lineage** (`app/main.py lineage`): a run's parent, when the caller names none, is the first input that came from an
  output (clip, then picture, then sound). Pictures sent in from an output remember it in `input_origins` (a cropped
  copy keeps it). Generate's `S.pendingParent` is gone.
- **Inputs**: `vfield.js clipInput` is the clip field Generate and VFX show; `media.js bareSource / clipUrl / clipLabel`
  are the one way to read a clip or sound source. `gizmo.js snapNearest` is the Editor's and the Video gizmo's snap.
- **Controls** (`web/ui.js`): `toggle`, `textArea`, `seedField`, `sizeSelect`, `colorField`, `chip` / `chips`,
  `pickButtons` + `imageInput` (and `vfield.js clipInput`, `media.js soundInput`), `rangeField` with `pctFmt` / `panFmt`.
  `timeline.js clipSoundFields` is a clip's level, pan and fades; `vfx.js loraChoice` / `keyRangeFields` the one-LoRA
  picker and the colour key's sliders; `gizmo.js gzChip` a gizmo bar button. A new control goes in one of these first.
- **Players** (`web/playback.js`): `transport` (the bar), `playKeys` (Space, arrows, Home / End, plus the tab's own;
  `f` is full screen everywhere) and `fmtTime`. `layout.js zoomPan` is the pinch / wheel / double-tap zoom.
- **Takes**: `media.js outputCard` draws a run (History, VFX, Sound makers); `useas.js resultActions` is the row under a
  picked take. `compare.js wipeLine` / `sideTag` are the wipe's line and labels in Compare and VFX. Every TabSet
  strip is `.tab-strip`.
- Still separate on purpose: the 3D tab's play bar (it carries Auto key, REC and the key sheet), the Board's tiles
  (pin / mark / select), and the wipe *gestures* in VFX (its canvas also takes points, paths and boxes).
- Module cycles: `make.js` ↔ `run.js` ↔ `generate.js` import each other. Keep top-level code in them free of the others'
  `const`s (read them inside functions), or a load order change throws "before initialization".
- **Keyframes** (`web/keys.js`, `web/keyed.js`, `app/keyexpr.py`): one engine. `keys.js` is the key maths (`sampleKeys`,
  `putKey`, `removeKey`, `nextKey`, plus the 3D sheet's moves); the 3D tab keeps its own key sheet UI on top of it.
  `keyed.js keyedRange` is a slider with ◀ ◆ ▶ (After Effects style: ◆ starts animating a property, then any change keys it).
  - Video clips: `it.chans[ch]` in the clip's **source time** (seconds), so moving/trimming keeps the animation on the picture;
    scale, rotation, position, opacity and level. Splits deep-copy the keys (a still's second half shifts them). The export
    writes each channel as a per-frame ffmpeg expression (`keyexpr.expr`; `videoedit._keyed_scale` / `_place_keyed`).
  - Editor layers: `E.anim = { len, fps }`, `E.t` the playhead; `l.chans` in edit time. `l.x / y / scale / opacity` always
    hold the pose at the playhead (`poseAt`), and `persistEditor` keys whatever an animated property moved (`keyPose`), so
    drags, nudges, align and arrange key without knowing about it. An animation keeps a fixed canvas and exports as a clip:
    frames → `scene-comp.js framesToClip` (`/api/scene/clip`, shared with the 3D compositions) → `/api/video/render`.
- **Kinds** (`web/kinds.js`, `app/imageprep.py KINDS`): one table of what each kind is called, its icon and its facts
  (`factsOf`), `cardPicture` / `kindTile` for every card. `main.py fill_facts` keeps size, length, fps and frames on each
  output. Where a kind can go is `useas.js openUseAs` (by kind).
- **Full screen** (`layout.js fullScreen(tab)`): every tab; the side panel pulls out from the right edge (`.pull-tab`).
- **Side panels**: `layout.js sideNav` scrolls to a section (nothing sticky); sections go add/list → selected → how it's made
  → guides → output.
- **HTTPS / PWA**: `deploy/tailscale-https.sh [port] [https-port]`; `DECK_NAME` names a second copy's app (manifest + title).
