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
- **Gizmo axes** (2026-10-28, `R.orient`, localStorage `deck.scene.orient`; toolbar button after Move / Rotate / Scale,
  key **Q** cycles World → Local → View). The maths is `web/gizmo-orient.js` (no three.js, node-tested by
  `tests/gizmo_orient.test.mjs`). The gizmo always holds a stand-in (`pivot` for an object, `camProxy` for the shot
  camera in the director view, `ikTarget` for a hand or foot) turned like the axes: the object's own turn in World /
  Local (World uses TransformControls' world space), the camera on show (`activeCamera()`) in View, with space
  `local`. The thing keeps its turn relative to the stand-in (`pivotRel` / `camRel`, taken when it is placed) and is
  put back each frame as `follow()`: stand-in turn × rel, its pivot point under the stand-in. In View, Move goes along
  screen right / up / toward you and Rotate turns about those; **Scale always uses the object's own axes** (a
  screen-axis stretch of a turned box would shear it). The stand-in is put back after every drag (`placeHandle`, the
  smoothGizmo `end`) and, in View, whenever either orbit moves (`followView`). Joint turns keep their own (local)
  axes; a hand / foot IK target moves on the view's axes in View, else the world's. The View Z arrow is hidden by
  TransformControls when it points straight at you (object near the middle of the view): move in depth with Local
  or World, or with the object off-centre.
  - **Grid snap** on turned axes (Local, View): the move goes in whole grid steps along those axes from where the drag
    started (`snapAlong`, in `gizmo.js smoothGizmo`), not onto the floor grid; World snaps onto the floor grid as before.
  - **Pivot at the view centre** (toolbar, crosshair-in-frame icon): the stand-in pivot goes where the ray through the
    middle of the view hits the selected object (a splat aims at its stand-in box, `userData.pickProxy`); with no hit,
    on that ray as far out as the current pivot. In the director view with the camera's gizmo, it pivots the shot
    camera around what the free view's centre looks at. Held in `tmpPivot` (scene-view.js, the thing's own space), not
    saved: it goes on Reset pivot (shown only while it is in use), another selection, or a new Pivot in the panel.
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
- **Offset layer** (`item.off`, scene-data.js, panel in scene-offset.js): slides / turns / scales a whole animation (a mocap
  move) around `off.pv` without touching its keys; joint offsets turn a limb in its parent's frame on every frame. Its own
  sparse keys (`off.chans`, rows under "Offset" in the sheet, track kind `off`). `current()` shows it; `rawCurrent()` is key
  space. `write()` takes it back out, or with `R.offEdit === item.id` the gizmo writes the offset (`writeOffset`).
  `bakeOffset` keys it in at every frame that has a key. Compositions (`scene-offscreen.js`) apply it too.
- **Reduce keys** (`keys.js reduceKeys`, sheet tool + popover in scene-keys.js, `RD` per device): greedy, error-bounded at
  every old key's frame (cm for places and sizes, ° for turns / joints / lens, a parameter in % of its range). Kept keys
  become Fitted (the default: Bezier, one slope per key fitted by least squares to the old keys, handles at thirds;
  `fitHandles`, refitted at every greedy step so the tolerance holds for the fitted curve), Auto clamped or Linear
  (joints always linear: curves don't apply to turns). Moves ▸ "Fewer keys" reduces a motion import as it lands.
- `web/icons.js icon(name)`: line icons for new buttons (no emoji).
- **Cameras** (2026-10-28): `SC.camera` is the *active* camera (the view, renders, `scene-offscreen.js` compositions all
  look through it), `SC.cams` the others (`camsOf()`, `setActiveCam()`; `upgrade()` gives older scenes `cams: []`).
  Others show in the key sheet (`L.other`: they key there, but tapping them selects the active camera). Camera panel ▸
  Cameras: rename, New camera, Make active, Delete.
  In the director view the others are drawn as grey outlines with their names (scene-view.js `OTHERS`, `syncOthers`,
  never rendered); a tap on an outline or its name (`otherCamAt`, pen 18 px / finger 28 px) makes that camera active.
- **Shots** (2026-10-29): `SC.camera` is the camera you edit. `liveCam(f)` (`scene-data.js`) is the camera the picture and
  renders use; `shownCam` (`scene-view.js`) is that, unless you are looking through the camera you edit (Camera mode, or
  the camera layer selected, and not playing) and **Cut** on the toolbar is on (`R.viewCut`, `deck.scene.viewcut`). A drag
  does nothing while another camera is on show. Cuts are a step row on the key sheet (`SC.cuts`, kind `cut`, ease always
  constant). `SC.renderShots` is `take` (one clip) or `each` (one video per shot). The words are `web/shot-words.js`,
  shared with the Story tab. An older scene has no cuts: the active camera throughout.
- **Mocap with its camera** (Moves ▸ From video ▸ With its camera): the clip is also tracked (`/api/track`, Simple) and
  `applyWithCamera` (scene-motion.js) adds "Mocap camera" (`sceneFromTrack`, lens from the capture's `focal` px when
  saved, else 35 mm) + its footage backdrop (`at` = start frame), makes it active, and puts the body in the world through
  it (`motion.js toWorld`, using `space` from `app/motion.py`: how the server normalised the camera-space capture).
  Only turning cameras (pan / tilt / roll / zoom) are solved. `Deck Save Body Motion` now also saves `focal` (ComfyUI
  must restart to load that).
- **Match its proportions** (Moves ▸ where it goes): `motion.js matchProportions` measures the capture (median bone
  lengths) and sets the figure's size (sy) and its legs / arms / torso / shoulders / hips / neck shape % (`figure.js
  shapeFor`, shapeFactors inverted; neck only half way, a capture's head is rough); the keys then take the clip's metres
  (`toKeys` `scale: 1`, `hipY` from `hipsHeight`). Tested by building a shaped figure from the result and comparing lengths.
- **Mocap clean-up** (2026-10-29): `app/motion.py clean` is opt-in (`read()` still only normalises, so `space` undoes
  that). Steady (One Euro) and Keep bone lengths run in that normalised frame. Plant feet and the ground run after the
  body is in the world (`POST /api/motion/clean`, scene-motion.js `planted`), so a pan is not planted in camera space.
  Defaults on for sam3d-body. `Deck Save Body Motion` also writes hands, face and `cam_t` when the 70 MHR points are
  there (right hand 21–41, left 42–62: wrist last in each block, fingers thumb→pinky as tip, first, second, third joint;
  the file stores wrist, then knuckle→tip). `run_hand_refinement` is on in `deck-mocap.json`. The video sheet has a
  Person number (0 is the first); the template already uses the native SAM 3D Body nodes, so there is no second
  template. Hands aim the wrist and put about half the twist on the elbow; finger curl is the angle between segments
  (`motion.js fingerPose`). Three real clips were not checked: ComfyUI was not running.
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

### Splats: preview levels, size, trim, placement (2026-10-28)
- **Levels** (`app/sceneasset.py make_levels`, `web/splat-levels.js`): `<base>_light/_medium/_dense.ply` (150k/300k/600k, only
  the ones lighter than the full set; Gaussians grown by (n/keep)^¼, at most 1.4) beside `<base>_full.ply` (photo splats) or
  the imported file. The layer keeps `levels: [{k, url, n}]`; the view loads the level picked on this device
  (`deck.scene.splatLevel`, default Light on touch, Dense otherwise), renders (`x.full`: Render colour video, the Video tab's
  export of a colour scene clip) load the full set. `POST /api/scene/splat/levels {url, trim?}` makes them for older
  splats and imports. `o.box` never changes with the level, so nothing moves. Sharp (`deck.scene.splatSharp`) lets a touch
  screen draw splats at full pixel ratio (scene-view.js `fit`).
- **Size and trim** (`web/splat-shape.js`): a Spark `objectModifier` on each SplatMesh scales every Gaussian (`o.grow`,
  renders only with `o.growRenders`) and zeroes the opacity outside `o.trim` (`{on, c, r, near, renders}` in file units).
  Uniforms only change, so it is live. Cut the previews asks the server for levels of only what the trim keeps
  (`<base>_t<tag>_<level>.ply`; `o.trim.made` / `kept`). The full set is never cut: renders trim it with the modifier.
- **Placement**: a photo's splat or MoGe mesh stands centred on the floor at the origin; `o.view.pos` is the photo's camera
  in the object's space (`standShift` / `photoShift`) and `lookThrough` uses it. Without `o.view` (older layers, or Place
  at the camera instead, `deck.scene.placeAtCamera`) the object's origin is the photo's camera. Re-centre converts one.
- Headless Chrome here is SwiftShader: a 825k splat takes ~6 s a draw, so render tests use a ~120k one.

### Real size (2026-10-28; `web/scene-scale.js`, maths in `web/scale-math.js`, node-tested)
- Scene units are metres. **Real size** in every object's panel (`placeProps` → `scaleProps`) is its world box at the
  playhead (`worldBox`: a splat's proxy box, a figure's rig meshes, else every shown layer-0 mesh), scale and fit included.
- **View helpers** (one group in the scene; a pass hook hides it for every render, the depth view and depth passes;
  `passHooks` now get `(pass, forRender)`): a 1.8 m outline person (the Person shape's profile) beside the selection,
  toggled by the person button on the view's bar (`deck.scene.refPerson`); faint "n m" sprites every metre along the
  grid's middle lines; the measure tool's dots and line.
- **Measure…**: the next two taps on the canvas (window capture, like the trim's Pick the centre) hit the selected
  object: a mesh by raycast, a splat by its nearest sampled Gaussian along the ray (`pickAlong`), else its proxy box.
  The sheet's presets (Person 1.7 / Door 2 / Table 0.75 / Car 4.5) or Custom rescale it about its base (`rescale`:
  the world box's floor middle stays put; `write` + `changed`, so one undo step and keyed at the playhead when animated).
- **Calibrate from a person** (photo meshes and photo splats with `o.image`): `POST /api/scene/person {image}` runs
  `look/person_worker.py` (DWPose's YOLOX-L, tight boxes, CPU) in ComfyUI's venv; 409 while ComfyUI's queue is busy,
  503 without the venv or `yolox_l.onnx`. The layer's points in the photo camera's space (MoGe vertices, or the splat's
  sampled centres; `o.fov` vertical, the picture's aspect from the reply) give the person's depth: a low quantile of the
  points that project into the middle strip of their box. Head and feet are the box's top and bottom at that depth, and
  the layer rescales about its base so they are the height picked (1.7 m default, `deck.scene.personH`). No person or no
  detector: a sheet offers Measure instead.
- **Imports** (`fitOf` in scene-import.js): glTF comes in at its size (metres), FBX by its `UnitScaleFactor` (cm per
  unit; three's FBXLoader leaves it in `userData`). OBJ, splats and anything over 50 m or under 5 cm ask "About how
  tall is it?"; dismissed, the old usable-size fit. `o.fit` is still saved per layer, so older scenes don't change.
  Even-scaled layers now clamp at ×0.0001 (was ×0.01) so a cm or mm file can be at true size.

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
  - Editor painting (`web/paint.js`): a painted layer's `l.img` becomes a canvas (it answers `naturalWidth` like the
    image did, so drawing and hit-testing don't change). Its pixels are saved to `POST /api/paint`, named after their
    content (`comfydeck/paint/<sha1>.png`, kept only in `data/inputs/paint/`, out of ComfyUI and the input galleries),
    1.5 s after the last stroke and before the tab is left (`TabSet` `adapter.beforeLeave`); the layer then names that
    file. `l.label` keeps the name shown. Undo keeps per-stroke pixel patches in memory (lost on reload). Old paint
    files are never deleted yet.
- **Kinds** (`web/kinds.js`, `app/imageprep.py KINDS`): one table of what each kind is called, its icon and its facts
  (`factsOf`), `cardPicture` / `kindTile` for every card. `main.py fill_facts` keeps size, length, fps and frames on each
  output. Where a kind can go is `useas.js openUseAs` (by kind).
- **Full screen** (`layout.js fullScreen(tab)`): every tab; the side panel pulls out from the right edge (`.pull-tab`).
- **Side panels**: `layout.js sideNav` scrolls to a section (nothing sticky); sections go add/list → selected → how it's made
  → guides → output.
- **HTTPS / PWA**: `deploy/tailscale-https.sh [port] [https-port]`; `DECK_NAME` names a second copy's app (manifest + title).

## Editor engine, turned layers, the Story canvas (2026-10-28)
- **One engine, several hosts**: `web/editor-engine.js createEditor(cfg)` is the Editor's layer stack (state `E`, view,
  animation, pointer, panel sections) and `web/paint.js createPaint(ctx)` its painter (tool, selection, stroke, undo,
  strip), one of each per canvas. `editor.js` is the Editor tab's host (edit tabs, stills, picker source, `addToEditor`);
  `story.js` mounts a second one on the Story tab's canvas view. cfg: `{ canvas, empty, size?, anim?, panel,
  panelParts(eng) | renderPanel(eng), active(), onChange(), docId(), name(), initial }`; the engine gives `load(payload)`,
  `dump()`, `compose(canvas)`, `addImage(name, o)`, `frame()`, `loading()`, `paint` and the panel's sections.
- **Turned layers** (`web/layer-geom.js`, node tests in `tests/layer_geom.test.mjs`): `l.rotation` (degrees, about the
  kept part's centre), `l.flipX` / `l.flipY`; `l.x/y` stay the unturned top-left. `layerMatrix(l)` maps image px to
  canvas px; drawing, hit tests (`insideLayer`), painting (`toLayer` = `canvasToImage`), crop (`cropKeepingPlace` keeps
  the image still while the pivot moves), snapping, fit, arrange and align use it or `bounds(l)`. Saved only when set.
  `rotation` is an animatable channel. PhotoCraft gets a turned layer baked into a picture of its box.
- **Story canvas**: a shot's composition is `s.comp` (an editor payload); its flattened picture is saved through
  `/api/paint` as `s.canvas` (paint files named by story-tabs are kept by `prune_paint`). Characters are the
  `characters` store kind (`web/characters.js`), mentions and prompt lines in `web/cast.js` (node tests).

### 3D objects from photos (2026-10-29; dev/make_3d_object_templates.py)
- **Built, not typed by hand.** `dev/ui_to_api.py` converts a ComfyUI UI workflow to API format against a live
  `/object_info` (widget order, `control_after_generate`, image-upload widgets, dynamic combos), and
  `dev/make_3d_object_templates.py` turns ComfyUI's official `3d_pixal3d_trellis2_image_to_model.json` into the three
  templates. Re-run both when ComfyUI's workflow changes.
- **Branches are pruned.** ComfyUI evaluates every node a prompt links, and the official workflow switches at run time
  (both a Pixal3D and a TRELLIS.2 5 GB UNET). The generator resolves each `ComfySwitchNode` to one side, then keeps only
  the save node's ancestors.
- Preview nodes pass their picture on: the generator hands their link to the node that showed it and drops them, so a run
  saves only the model.
- **Dropped:** `RemeshMesh`, `DecimateMesh`, `GetMeshInfo` and the AO/normal bakes (dynamic-combo widgets do not map
  one-to-one to API inputs). The mesh goes `VoxelToMesh → MeshSmoothNormals → UnwrapMesh → BakeTextureFromVoxel →
  ApplyTextureToMesh → MeshSmoothNormals → MeshToFile3D`, so a model has base colour, metal and roughness but no baked
  AO or normal map.
- **Fields.** `@1 Front`; `@2 Cut out` (`ComfySwitchNode` between the picture's own mask and BiRefNet); `@3 Detail (steps)`
  and `@6 Seed` are `PrimitiveInt`s linked into all four samplers' `steps`/`seed` (a widget input takes a link);
  `@4 Texture resolution` is the `PrimitiveInt` behind `UnwrapMesh.resolution` and `BakeTextureFromVoxel.texture_size`;
  `@5 Texture` is a `LazySwitchKJ` (KJNodes, `{"lazy": true}`) choosing the textured mesh or the plain smoothed one, so
  with it off the texture stage and bake do not run.
- **Multi-view.** Four `LoadImage → RemoveBackground → ImageCropToMask` (1024², pad 1.1: the rig's framing) into
  `Pixal3DMultiViewConditioning` at fov 20. Each view's two preprocessing nodes carry `_meta.deck_drop` +
  `deck_follow_on`, so an empty view takes its chain with it and the conditioning's optional input unplugs.
- **The sheet's views.** `/api/generations/{id}/to-input` takes a frame **index** (`frame: 96`) as well as `first`/`last`
  (`imageprep.frame_from_video` selects frame n); `scene-import.js` takes the object sheet's frames 4, 54, 96, 120 as
  front, left, back, right. Which side comes first on a real sheet has not been checked with a GPU.
- **Where a GLB goes.** `useas.js` sends a `template === '3d photo'` GLB to `addPhoto` (MoGe's camera and picture) and any
  other GLB to `scene-import.js addModel`: a `model` layer at the world's middle, fitted like an import (glTF metres, so
  no height question), selected.

### Rigged models (2026-10-29; web/scene-rig.js, web/rig-map.js)
- **One kind of layer, the figure's values.** `rigged` is in `TYPES`/`EVEN` (scene-data.js) and `isPosable(o)` covers it,
  so `namesFor` gives it `FIG` and every pose, Pair, Move, IK, Hands and mocap path works unchanged. The places that
  checked `type === 'figure'` one by one now use `isPosable` where the behaviour is a posable body's (keys.js `kindOf`,
  the pose render, pairs, prompts, mocap targets, the pivot). `paint()` leaves a rigged layer's own materials alone.
- **A hidden figure rig drives the skin.** `makeRigged` builds a `figure.js` rig in the layer's group (its volumes set
  invisible, its joint dots kept) and the view poses it like any figure. `group.userData.atFrame` then copies each mapped
  bone's turn: `bone.local = parentWorld⁻¹ · (figureJointWorld · restQ[bone])`, parents first with
  `updateWorldMatrix(false, false)`. `restQ` is `figureBindWorld⁻¹ · modelBindWorld`, measured once against a spare rig in
  `BIND` (the layer's own rig may already be posed when the file arrives). The hips bone also takes the figure hips'
  rise and fall (in its parent's space), so a crouch or a jump moves the model.
- **The map** (`rig-map.js`, node-tested): names first (Mixamo `mixamorig:LeftArm`, Rigify `DEF-spine`, case, prefixes and
  separators cleaned off), then each remaining body joint takes the nearest free bone by where it sits, in the layer's
  metres (the model is scaled to the hidden figure's height, feet on the floor, centred). Fingers map by name only.
- **Where the model comes from.** `ComfyUI-UniRig` (installed here) gives `MIAAutoRig` (people) and `UniRigAutoRig`
  (anything); both return a *path* to an FBX, which is not a file output. `comfy_nodes/deck_rigsave` (`DeckSaveRig`) copies
  that file into the output folder and lists it, so the run's outputs hold the rigged model. `templates/deck-autorig-human`
  and `-any` load the mesh with `UniRigLoadMesh`, which reads ComfyUI's **input** folder: `POST /api/scene/mesh
  {generation, index}` copies a run's GLB there and returns the `file_path` the template's `@1 Model` field takes.
- **The mesh list is built at startup.** `UniRigLoadMesh`'s `file_path` options are read from ComfyUI's
  `input/3d` (and the input root) when the class is imported, and `/prompt` validates against that list, so a mesh
  written there after startup is rejected. `POST /api/scene/mesh` copies a run's GLB into `input/3d` and `rigRun`
  says so (restart ComfyUI once) when the template's field does not list it. Fixing this properly needs a loader that
  takes a path, inside UniRig's isolated comfy-env (its `TRIMESH` type does not cross environments).
- **Checked:** a synthetic skinned GLB (a 3-bone box) takes the figure's poses exactly — the Spine bone ends at the
  figure's own quaternion and the mesh bends. A **real Make It Animatable run** (13 min on the CPU) proves the whole
  path: `DeckSaveRig` saved the FBX, the 3D tab loaded it, and **47 Mixamo bones** drove it. `norm()` had to learn that
  FBXLoader drops the colon (`mixamorigHips`). The first test looked spiky only because its input was a torn MoGe photo
  mesh; with a proper character mesh the model stands in T-pose and folds correctly when a strong pose (`Touch toes`)
  is applied. No FBX→GLB conversion is needed.
- **Not built yet:** Fit joints / Re-skin (4.4). The compositions (`scene-offscreen.js`) still build figures themselves,
  so a rigged layer in a Video composition falls back to a plain object until that path learns the type.

### Generic bone keys, phase 5 groundwork (2026-10-29; scene-data.js `b.` channels)
- A joint's turn (`j.<name>`) and a bone's (`b.<name>`) are the same kind of value, so the channel code now asks
  `isQuatCh(ch)` instead of testing for `j.` in each place: `baseOf`, `valOf`, `keyChans`, `sampleChan` (both slerp),
  `sample` (both give a bag by name), `bakeBase` and the playback `overlay`. A layer's values decide which bag it has:
  `namesFor` gives a `skinned` layer `BONE = [...OBJ, 'b']`; figures and rigged models keep `FIG`; everything else `OBJ`.
- `tests/skin_channels.test.mjs`: two bone keys slerp to a unit quaternion, `sample()` returns the bone bag, `bakeBase`
  writes `base.b`, and a whole-item key never touches a bone channel.
- **This is groundwork, not a feature yet:** no UI creates a `skinned` layer, and the key sheet has no bone rows. Next
  for Phase 5 is `web/scene-skin.js` (load a generic skinned GLB/FBX, drive its bones from `b.` at `pose(f)`), bone dots
  with CCD IK (`web/ik.js`), and the refine-skeleton tools.

### Skinned models (2026-10-29; web/scene-skin.js, `b.` channels)
- **The layer.** `skinned` (scene-data.js TYPES/EVEN) holds `OBJ + b` (`BONE`); `makers.skinned` loads a GLB/FBX,
  fits it to a usable size (`scale-math.importFit`, glTF metres, FBX's own unit) and stands it on the floor at the
  middle. It keeps `group.userData.skin = { order (parents first), rest (bind local quats), skinned }` and an `atFrame`
  that applies only the bones that have a `b.` value, so an unkeyed bone keeps the bind pose. The bone list is saved as
  `o.bones` so the panel still lists them while the file loads.
- **Authoring.** The **Bones** panel picks a bone, turns it by three slider degrees composed onto what the bone has at
  the playhead, and writes it with `write(o, BONE, { b: { bone: q } })` — the base turn when the layer has no keys, a key
  at the playhead once it has (Auto key off: held until ◆ Key). **Key every bone** writes the whole skeleton then
  `addKey(..., only b.*)` so it keys bones and not the layer transform; **Put it back** writes the saved bind turn.
- **Bone dots.** A skinned layer gets a dot per bone (a 0.035 m sphere on layer 1, so it is picked but never rendered
  out) placed in the layer's space each frame (`apply` converts the bones' world positions through the layer's inverse
  matrix). `scene-view.js` draws them for the selected layer (`userData.dots`), highlights the picked one, and
  `boneDotAt()` picks them with the figure dots' reach and depth rules; `scene.js` wires `setBonePick(onBonePick)`, and
  picking sets the panel's bone (`SK.bone`) and the layer's `userData.pickedBone`.
- **CCD** (`web/ik.js`, node-tested): `reach(bones, target)` turns a root→end chain from the end backwards, composing a
  world-space swing per bone and converting it to a local turn (a rootless bone takes the world turn); it stops on the
  tolerance or the iteration cap and returns `{bones: [{name, q}], distance, iterations}` — the `q`s are what gets keyed
  as `b.<bone>`. `error()` and `chainTo()` are there for the drag.
- **The drag.** A pointer down on a selected layer's dot disables the orbit, makes a camera-facing plane through the
  bone and holds a `bonedrag` (for playback); `pointermove` intersects that plane and `scene-skin.onBoneDrag` takes the
  chain (`ik.chainTo`), solves it (`ik.reach`, 8 passes) and writes `b.<bone>` for the playhead; letting go saves once
  (one undo step). `setBoneDrag({move, end})` is wired in scene.js.
- **Mirror** (`rig-map.js oppositeBone` + `mirrorChans`, node-tested): every `b.` channel swaps to the other side's bone
  (Mixamo Left/Right, `.L/.R`, `_L/-L`, or a lowercase limb name; never `root`) with its turn mirrored by `figure.js`'s
  `mirrorQ` (x same, y and z flipped); a centre bone mirrors in place. Frames, eases and non-bone channels are kept. The
  panel's **Mirror the bones** applies it and saves once.
- **Rename and forget** (5.3, in the Bones panel): `renameBone` sets `bone.name` (the three.js skeleton), the layer's
  saved `o.bones`, the `b.<name>` channel keys and `base.b`, and the dot's `userData.joint`; a name already taken is
  refused. `forgetBone` deletes that one bone's channel and resting turn and puts the bone back to `skin.rest`'s bind
  turn (its weights are untouched).
- **Add / delete + re-skin** (`web/reskin.js`, node-tested): adding a bone under the picked one (half way to its first
  child) or deleting one (children keep their world place; a root can't go) rebuilds `s.order`, the layer's `o.bones`,
  the bone dots and the channels, then re-weights every skinned mesh: `weightsFor` gives each vertex the nearest four bone
  points with a 1/d⁴ falloff (normalised), `skeletonFrom` takes the inverses of the bones' current world matrices as the
  new bind, and `reskinMesh` writes `skinIndex`/`skinWeight` and rebinds. It is a simple nearest-bone skin, not a
  heat-diffusion one, so an edited skeleton can look rough.
- **Renames survive a reload**: the file keeps its own bone names, so `attach` puts the layer's saved `o.bones` names back
  by index after loading (a file with a different bone count leaves them alone).
- **Not built yet:** a key-sheet row per bone chain — the sheet shows the layer row only.

### World mocap, phase 6 findings (2026-10-29)
- **No ComfyUI node exists for GEM-X.** `billwuhao/ComfyUI_gemmax` is a translation pack (GemmaX2), unrelated to NVlabs'
  motion model. So the plan's `comfy_nodes/deck_gemx` is still the route.
- **GEM-X itself is pip-installable** (`pip install -e '.[video,hand]'`, `gem-infer motion-video`), but needs Python
  3.10+, **torch 2.10**, SOMA 0.3.3 plus its assets, the nvidia/GEM-X body checkpoints, a YOLOX detector, and (for
  practical speed) CUDA. This checkout is CPU-only inside this session, and GEM-X's `requirements.txt` pulls torch,
  warp-lang, chumpy and more, so it is not installed here.
- Its Body Motion output is SOMA parameters plus camera-space and world-space joints; the saver still has to map SOMA's
  **77** joints onto the SMPL 22 + hands + face (`{fps, frames, hands, face, cam_t}`, the Phase 2 format). The 77 joint
  order is in SOMA's own package/docs, not in GEM-X's README; read it when installing rather than guessing.
- **What is already ready for it:** `app/motion.py read` + `/api/motion/clean` (feet/ground), `applyWithCamera` (Mocap
  camera + backdrop, a body that stays put under a pan), and the Phase 2 hand/face extras. The world path still needs
  the camera's **position** keys and the sheet's **Camera in the clip: Still / Panning / Moving** choice.

### Open-H3-Regenerate in H3 Upscale (2026-10-29; app/h3upscale.py `regen`, `web/run.js`)
- **The mode.** `build(..., regen={lora, has_turbo, quality}, size=...)` puts a `LoraLoaderModelOnly` last in the run's
  model chain (`up_guide` reads `["up_lora", 0]`), and uses its own `REGEN_SIGMAS`: Standard `0.7, 0.494118, 0`,
  Enhanced `0.8, 0.666667, 0` (`regen_sigmas()`); the plain upscaler's `sigmas()`/`LADDER` is untouched.
- **Turbo.** `drop_turbo()` walks the guider's model chain and, when the refiner file is a **merge** (`has_turbo`), hands
  each user of the turbo LoRA that node's own model input and deletes it. A refiner-only file (Kijai) keeps the run's
  turbo. `regen_loras(oi)` finds LoRAs with `regenerate` in the name and marks a merge (`refiner`/`rank_384` means only).
- **1080P.** `fit_1080p(w, h)` fits the frame's aspect inside 1920×1080 on a 32-pixel grid, capped at 2.5×; `build` takes
  the exact `size`, so the upscaler's `target dimensions` mode gets it.
- **Endpoint.** `GET /api/h3/regen` says whether a Regenerate LoRA is installed (`{available, loras, reason}`);
  `POST /api/h3/upscale` takes `regen: {quality, lora, target: "1080p"|"scale"}`, validates the LoRA against that list
  and the quality before queueing, and records `regen` in the run's params (template `h3 regenerate`).
- **Sheet.** `openH3Upscale` is async (it asks `/api/h3/regen` first), shows **Upscale / Regenerate** only when a LoRA
  exists (otherwise the reason), and in Regenerate shows Target `1.5× / 1080P`, Strength `Standard / Enhanced`, a refiner
  picker when there are several, and whether the chosen file has Turbo inside.
- **Tests:** `tests/test_h3upscale.py` (11): the LoRA node and guide link, turbo dropped only for a merge (no dangling
  links), exact sigmas and titles, the 1080P fit, `regen_loras`'s merge/refiner marking, and the unchanged Upscale graph.
- **Not done here:** a real Regenerate run (the 5.6 GB LoRA was still downloading, and a CPU H3 pass at 1080P is not a
  test); Phase 7.3's `deck-h3-refine` group (its sampler graph is not the upscale shape, so it needs its own wiring).

### Regenerate in deck-h3-refine (2026-10-29)
- The refine graph's sigmas come from `BasicScheduler` (`@7 Strength`, denoise/steps), not the upscale builder, so the
  template carries its own switch: `rglora` (`@8 Regenerate LoRA`, a `LoraLoaderModelOnly` between the turbo LoRA and
  the ControlNet apply), `rgon` (`@9 Regenerate`, a `PrimitiveBoolean`, off), `rgsig` (`ManualSigmas` at the Standard
  `0.7000, 0.4941, 0.0000`) and `rgsw` (`ComfySwitchNode`: off → `BasicScheduler`, on → `rgsig`), with the sampler's
  `sigmas` reading `rgsw`. An empty refiner stack is bypassed by `templates.py`'s LoRA rules, so `51.model` falls back
  to the turbo's model and the switch still routes the schedule.
- Enhance/LTX drafts use the same template, so they get Regenerate with no extra code. `tests/test_h3_refine_template.py`
  checks the wiring, the empty-stack bypass and a refiner in the chain.

### Finish a take: Board and Story (2026-10-29; phase 7.4)
- **Board.** The selection bar's **Finish** takes the selected clips (`boardSelected()` filtered to videos) and POSTs
  `/api/h3/upscale` with `regen: {quality: "standard", lora, target: "1080p"}` for each, one at a time, adding each run to
  `S.history` and calling `boardChanged(run)` so it appears as a new take. A selection with no clips leaves it disabled.
- **Story.** **Finish takes** in the bar maps every shot to `clipOf(s)` (skipping clips already `regen`), queues the same
  run, and pushes its id onto `s.vpending`, so the existing `settle()` attaches the finished clip when it lands. Clips
  from a run whose template is `h3 regenerate` are marked `regen`, and `clipOf` returns a `regen` clip over a draft — so
  **Shots to video** takes the finished one even if the draft was the chosen clip.
- Both check `/api/h3/regen` first and say what is missing instead of queueing. `README` has the user-facing paragraph.
- **7.5, other models' drafts.** `run.js finishWithH3(g, index)` opens `deck-h3-refine` through `useRefineClip` and then
  sets the template's `rgon.value` to true and `rglora.__loras` to the installed refiner, so any clip (an LTX take, a
  scene render) can be finished the same way; Use as offers it for every video, H3's own or not.
