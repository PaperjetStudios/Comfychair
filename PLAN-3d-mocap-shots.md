# Implementation plan: shots, better mocap, photo → 3D, auto-rig

A plan to hand to an LLM coding agent, one phase per session. The background research is in
`RESEARCH-3d-mocap-shots.md`. Each phase stands on its own, can be merged on its own, and ends with tests and
a README update. **Do the phases in order**: later ones assume the earlier ones.

---

## 0. Rules for every phase (read first)

**Read before writing code:** `README.md` (3D tab sections), `NOTES.md` (the 3D tab modules, the key sheet,
shared engines), and every file a phase names. Match the code around you: short lines of plain-English
comments, the same naming, no new frameworks.

Hard rules taken from `NOTES.md`:
- **Imports**: always `import { … } from './x.js'`. Never write a bare `import './x.js'`: the server adds
  `?v=` only to `from` imports.
- **No `innerHTML`**. Build DOM with `h()` from `web/ui.js`. Reuse the shared controls (`button`, `field`,
  `seg`, `toggle`, `rangeField`, `numSlider`, `chip(s)`, `section`, `help`, `openSheet`, `toast`,
  `undoToast`). Add a new kind of control to `ui.js` first.
- **Keys**: one engine. `web/keys.js` is the maths, `scene-data.js` holds `chans`, `setKey`, `sample`,
  `current`, `write`, `addKey`, and `scene-keys.js` is the sheet. Don't write a second key system.
- **Undo**: every edit ends in `save()` (scene-data.js), which records one undo step. Gestures save once,
  on letting go.
- **Old scenes must load unchanged.** Any new field is optional; `upgrade()` in scene-data.js fills in
  defaults.
- **Renders** (`scene-export.js`) set `R.real = true` and use only the real keys (no mute, TEMP or HOLD).
- **ComfyUI templates** live in `templates/*.json` (API format). Fields show in the UI through node titles:
  `@N Label [input,input]`. Copy the style of `templates/deck-mocap.json` and `deck-h3-objectsheet.json`.
  **Before writing a template, check the node class names and inputs on the live ComfyUI**
  (`GET /object_info/<Class>`, or `comfy.object_info()` in `app/comfy.py`). The node names in this plan
  come from third-party listings and may be wrong.
- **Custom ComfyUI nodes** go in `comfy_nodes/deck_*/__init__.py`, like `deck_motion` (`OUTPUT_NODE`,
  `{"ui": {"files": [...]}}` for files ComfyChair should pick up). Note in the README that they are
  symlinked into `ComfyUI/custom_nodes`.
- **Tests**: Python goes in `tests/test_*.py` (pytest). Browser maths goes in `tests/*.test.mjs` run by
  node (`figure.js`, `keys.js` and `motion.js` import without a DOM). The `.mjs` tests run through Python
  wrappers like `tests/test_keys.py`. Run `pytest -q` before every commit. `dev/mock_comfy.py` fakes
  ComfyUI.
- **Docs**: every user-visible feature gets a short README paragraph in the existing voice. Note the
  internals in `NOTES.md` under a dated heading.
- **Commits**: one per working step, in the repo's style ("3D: …"), with no model names. After an `app/*.py`
  change the server has to restart; `web/` changes are live on reload.
- **Verify in a browser**: Playwright and Chromium are installed. Start the app against `dev/mock_comfy.py`,
  open the 3D tab, exercise the feature and check there are no console errors. Take a screenshot for the
  PR.

---

## Phase 1: several cameras, a keyable active camera, and a shot-list prompt

**Goal:** a scene has any number of cameras. A **Shots** row in the key sheet says which camera is live from
which frame (step keys, no blending). The view, the depth, pose and clay renders, and scene compositions all
use the live camera. A **Prompt from the shots** section writes `[Shot N] At mm:ss.mmm, the camera cuts to …`
per cut. No models are needed.

### 1.1 Data (`web/scene-data.js`)
Keep `SC.camera` as **camera 1**, so old scenes and the ~25 places that use it keep working. Add:

```js
SC.cams = [ { id, name, base: {px,py,pz,tx,ty,tz,fov,roll}, chans: {}, ease: 'smooth', mute: false } ]  // cameras 2..n
SC.cuts = [ { f, cam } ]   // sorted by f; cam = a camera id, 'main' for SC.camera. Empty or missing means SC.camera throughout
SC.camera.id = 'main'      // set in upgrade() if missing; SC.camera.name defaults to 'Camera 1'
```

Add helpers next to `keyTarget`:
- `allCams()` returns `[SC.camera, ...(SC.cams || [])]`. `camById(id)` returns the camera with that id, or
  `SC.camera`.
- `liveCam(f)` is the camera of the last cut at or before `f` (the first cut's camera before it; `SC.camera`
  with no cuts).
- `R.cam`: the camera being edited (id, not saved, like `R.sel`). `editCam()` returns `camById(R.cam)`.
- `shots()` returns `[{ i, f0, f1, cam }]`, the frame ranges between cuts, clipped to `frames()`. Cuts at the
  same camera as the one before them are merged.
- `upgrade()` defaults to `cams: []` and `cuts: []` and sets `SC.camera.id = 'main'`, then migrates each extra
  camera's keys with `migrateKeys(c, CAM)`.
- `allNames(item)` (used by mute and TEMP) has to return `CAM` for **any** camera: test
  `allCams().includes(item)`.
- `keyTarget()`: when nothing is selected, it returns `[editCam(), CAM]` instead of `[SC.camera, CAM]`.

### 1.2 What the view shows (`web/scene-view.js`)
- `pose(f)` calls `putCamera(current(viewCam(f), CAM, f))`, where `viewCam(f)` is:
  - `editCam()` in Camera mode (or while the camera layer is selected), so that you see the camera you're
    editing;
  - otherwise `liveCam(f)`, so playback shows the cut.

  Add a toggle to the toolbar's camera chip, **"View: Live cut / This camera"** (`R.viewLive`, not saved,
  default live), and use it to choose.
- Every `write(SC.camera, CAM, …)` / `current(SC.camera, CAM)` in this file (orbit `change`/`end`,
  `placeCamProxy`, `readCamera`, `cameraFromView`, `aimFree`, photos placing the camera) acts on the
  **camera on show**. Add `shownCam()` = the camera `pose()` last put up, and replace `SC.camera` with it in
  these places. Grep `SC.camera` across `web/scene-*.js` and change each one deliberately:
  `scene-camera.js` moves, `scene-keys.js` rows, `scene-ui.js` layer list, `scene-library.js`,
  `scene-offscreen.js`.
- In the director (free) view, draw a frustum for **each** camera: the live one bright, the others dim. Tap
  a frustum to edit that camera.

### 1.3 Layer list, key sheet and camera panel
- **Layer list** (`scene-ui.js`): one row per camera (🎥 *Camera 1*, *Camera 2* …) above the room, with
  rename (`nameSheet`), ◉ mute, delete (not camera 1; Undo through `undoToast`; delete that camera's cuts
  too), and **＋ Camera**. The new camera copies the camera on show at the playhead (base = its current
  values, no keys).
- **Key sheet** (`scene-keys.js`): a **Shots** row first, then a row per camera. Each cut key is drawn as a
  coloured block from its frame to the next cut, labelled with the camera's name.
  - ◆ on the Shots row (or **✂ Cut here** in the Camera panel) writes `{ f: R.f, cam: editCam().id }`,
    replacing any cut at that frame.
  - Dragging a cut retimes it. The existing key selection, move, delete and copy work on it too. Store cuts
    as a channel-like list so `keys.js` `putKey`/`removeKey` and the drag code can handle them. Treat them
    as **`const` ease** (it exists already) and never interpolate them.
  - **Tapping a block** makes that camera the edited one and seeks into the shot.
- **Camera panel** (Camera mode, `scene-camera.js` / `scene-builtin.js`): a camera picker (`seg` or chips)
  at the top that sets `R.cam`. The existing moves apply to `editCam()`. Add **Shot length** to show the
  shot under the playhead (`f0–f1`, in seconds).

### 1.4 Renders and compositions
- `scene-export.js` `renderDepthVideo`, `renderPoseVideo` and `measureRange`: after `pose(f)`, put up
  `liveCam(f)`. That's simplest if `pose(f)` already uses the live camera whenever `R.real` is set, so make
  `viewCam(f)` return `liveCam(f)` when `R.real`. `saveFrame` keeps the camera on show.
- **Depth range:** `measureRange` measures over all frames with the live camera, so the range is shared
  across shots. Add **Range per shot** (`SC.rangePerShot`), which measures and normalises each shot on its
  own, because a close-up and a wide shot need different ranges. Pass a per-frame range to `setRange`.
- `scene-offscreen.js` `Stage`: use the same `liveCam(f)` so a scene clip in the Video tab cuts too. Keep the
  helpers DOM-free so the offscreen stage can import them from scene-data.js.
- Option **Render: One take / Each shot** (`SC.renderShots`):
  - *One take* is today's single video, now with hard cuts.
  - *Each shot* renders one video per shot (same kind, that shot's frames). They're labelled
    `Shot N · Camera X` and sent to `/api/scene/render` one after another. The toast then offers
    **Shots to Video tab**, which places the takes on the Video timeline at their cut times (see the
    Video tab's add-clip code in `web/video.js` / `timeline.js`).

### 1.5 Prompt from the shots (new `web/scene-shots.js`, a section next to Prompt from the poses)
Each shot is described from the scene, as pure, testable functions with no DOM, in `web/shot-words.js`:
- **Subject**: the visible figures (and named objects) whose bounding box is mostly inside the camera's
  frustum in the middle frame of the shot. Project their `Box3` corners with the shot's camera
  (three.js runs in node).
- **Size**, from the main subject's height on screen ÷ frame height (h):
  - h > 1.6 extreme close-up (face only)
  - 0.9–1.6 close-up
  - 0.6–0.9 medium close-up
  - 0.4–0.6 medium shot
  - 0.25–0.4 full shot
  - below 0.25 wide shot
  - no subject: establishing / wide shot of the room

  Tune the thresholds with test scenes.
- **Angle**, from the pitch of (target − position): above +25° low angle, −10° to +10° eye level, below −25°
  high angle, below −60° overhead. |roll| > 8° adds "Dutch angle".
- **Movement**: compare the camera at f0 and f1 (and halfway, to tell an orbit from a truck):
  - |Δfov| > 3° → zoom in/out
  - distance to the target changes → dolly in/out (push in if the fov changes too)
  - the angle around the target changes with the distance held → orbit left/right
  - the position moves sideways with the target → truck
  - only the target moves → pan/tilt
  - Δy → pedestal/crane
  - keys every few frames with small noise → handheld
  - nothing → static

  Where `scene-camera.js` `writeMove` was used, store the move id on the start key (`k.mv = id`), and
  prefer it over guessing.
- **Action**: run `promptItems()` from `scene-pose.js`, limited to pose keys inside `[f0, f1]`. Export a
  version that takes a frame range.
- **Line**: for shot 1, `[Shot 1] A {size}, {angle}, of {subjects}{, the camera {move}}. {action}`; for later
  shots, `[Shot N] At {mm:ss.mmm}, the camera cuts to a {size} …`. Reuse the timestamp format in
  `web/app.js:240` and move it into `shot-words.js` as `stamp(sec)` so both use one function.
- **Timecode display**: the shot list shows SMPTE `HH:MM:SS:FF` from **Start timecode** (`SC.tcStart`,
  default `01:00:00:00`). The prompt **always** uses clip-relative `mm:ss.mmm`.
- **Model check**: warn when the length isn't between 4 and 15 s (H3), when cuts are under 1 s apart, and
  above 10 cuts. A **Format** `seg` offers H3 (timestamps) or LTX (no timestamps: "Shot 1: … Hard cut to
  shot 2: …", with transitions named). Keep it to 2–4 shots for LTX.
- UI: the same chip list as Prompt from the poses (tap to leave a shot out; long-press edits its text,
  stored as `SC.shotText[cutF]`), plus Copy and **Add to Generate prompt** (`C.addToPrompt`).

### 1.6 Tests and done-when
- `tests/shots.test.mjs` (with a `tests/test_shots.py` wrapper):
  - `liveCam` and `shots` with no cuts, one cut, cuts out of order, and a cut past the end;
  - `stamp`;
  - size and angle words for fixed camera and figure setups;
  - movement words for each `MOVES` id (build the keys with `writeMove`);
  - an old scene (no `cams`/`cuts`) upgrades and renders as before.
- Browser check:
  1. add two cameras and key cuts;
  2. play: the view cuts;
  3. render a depth video: frames cut at the right frames;
  4. the shot prompt reads correctly;
  5. undo and redo through all of it;
  6. load a scene saved before this phase.
- README: a **Shots** paragraph under the 3D tab section.

---

## Phase 2: cleaner video mocap with the models already installed

**Goal:** less foot sliding and jitter, no body movement caused by camera movement, and head, hand and
finger motion from the clip. The output format stays `{fps, frames}`, plus optional extras, so
`motion.py` and `motion.js` keep working with old files.

### 2.1 Save more from SAM 3D Body (`comfy_nodes/deck_motion/__init__.py`)
- `DeckSaveBodyMotion` writes, besides `frames` (22 joints):
  - `hands: {l: [[21 × xyz]], r: [...]}` per frame, from MHR70's hand points. Look up the index ranges:
    the wrists are 41 and 62, so the hand points are probably 21–41 and 42–62. **Confirm this from the
    SAM 3D Body / MHR docs or by printing a frame.**
  - `face: [nose, leye, reye, lear, rear]` per frame;
  - `cam_t`: the raw camera translation per frame;
  - if the node gives them, `rots` (MHR joint rotations). Check what `pred_*` keys `SAM3DBody_Predict`
    returns and log them once.
- Turn on `run_hand_refinement` in `templates/deck-mocap.json` behind a new `@5 Hands [run_hand_refinement]`
  toggle (on by default if it's fast enough).

### 2.2 Clean-up on the server (`app/motion.py`, new `clean()`, used for `source == "sam3d-body"`)
Implement these as small pure numpy functions in this order, each with a test:
1. **Fill and smooth**: a One-Euro filter per joint coordinate (min cutoff ~1.0 Hz, beta ~0.02, tunable).
   It replaces a fixed window, so fast moves don't lag.
2. **Bone lengths**: hold each bone at its median length over the clip by rescaling child positions along
   the bone. This stops limbs stretching with depth noise.
3. **Root depth**: monocular z is the noisiest. Low-pass the pelvis z harder than x and y (a separate cutoff).
4. **Foot contact lock**:
   - per foot, contact = (height above the floor < 3 cm, after `_normalise` puts the floor at 0) and
     (horizontal speed < 0.25 m/s), with ≥ 3 frames of hysteresis;
   - during a contact span, pin the toe and ankle to the span's mean xz;
   - move the pelvis by the average correction of the planted feet, so the body comes along;
   - blend in and out over 3 frames.

   Save `contacts: {l: [0/1...], r: [...]}` so the figure can show it later.
5. **Ground**: fit the floor height from the contact frames (not just the minimum toe), then level it.

Expose them as options on `/api/motion/from` and `/api/motion/file`, with the defaults on:
`clean: {smooth, bones, feet, ground}`. The "Where it goes" sheet in `scene-motion.js` gets a
**Clean-up** row of toggles (Steady, Keep bone lengths, Plant feet) saved in `PLACE`.

### 2.3 Take out the camera's movement
- In the **Motion from video** sheet, add **Camera in the clip: Still / Moving (track it first)**.
- *Moving* first runs the existing Track motion (`app/tracking.py` simple or TAPNext++) on the same clip and
  range. Find the track result format and the function that turns it into a camera (`web/track-math.js`
  `sceneFromTrack`). That gives per-frame pan, tilt, roll and zoom (a rotation-only camera).
- Send the per-frame camera rotation (and the fov if zoomed) with the motion request. In `clean()`, before
  normalising, turn each frame's joints, which are in camera space, by the inverse of that frame's camera
  rotation. The person's travel and turn are then in world space for a panning or tilting camera. A camera
  that physically moves (dolly, handheld walking) isn't fixed by this: say so in the help text and point to
  Phase 6.
- Add the option **Also bring the camera move into the scene**: key the scene camera with the tracked move
  as well (the Track motion flow already does this), so the figure and camera line up as in the clip.

### 2.4 Head, hands and fingers onto the figure (`web/motion.js`)
- `worldTurns`:
  - **Head**: if `face` is there, aim `W.head` with the nose → forward and ear → ear for left. That gives
    yaw, pitch and roll instead of copying the neck.
  - **Wrists**: if `hands` is there, set `W.lhand`/`W.rhand` from wrist → middle-finger base (along) and
    index base → pinky base (across). This gives forearm twist too: spread part of the hand's twist
    (about 50%) onto the elbow joint.
  - **Fingers**: for each finger, the curl of each of its 3 joints is the angle between consecutive
    segments. Write them through `figure.js`'s finger joint channels: look up the finger joint names and
    their `FINGER_AT` rest data, and follow how the Hands tab's curl sets them.
- `toKeys` writes these joints too when they're present. Old files without the extras give the same keys as
  before (test this).

### 2.5 Smaller things
- **Person picker**: when RT-DETR finds several people, the sheet asks which one. Queue with
  `max_detections` 4, show the first frame with numbered boxes from a cheap preview frame, then set
  `person`. If that's too heavy, a `Person #` number field is enough for v1.
- Try **ComfyUI's native SAM 3D Body nodes** (in core since about Aug 2026, with person tracking and BVH
  export). If they're there (`object_info`), make `deck-mocap-native.json` and prefer it when the custom pack
  is missing. Map its output in `DeckSaveBodyMotion`, or write a second saver.

### 2.6 Tests and done-when
- `tests/test_motion_clean.py`:
  - synthetic walk data with added noise: jitter goes down, bone-length variance goes down;
  - a planted foot doesn't move during contact;
  - a sequence turned by a known camera pan comes back unturned;
  - an old JSON without extras reads the same.
- `tests/motion.test.mjs`: the head turn from face points, finger curl from hand points, and identical
  output without the extras.
- A by-hand check on 3 real clips: a still camera, a panning camera, and hands in view. Record the
  before and after in `NOTES.md`.

---

## Phase 3: photo(s) → 3D object (Pixal3D, TRELLIS.2 as a fallback)

**Goal:** one photo, or a few angles, become a textured GLB **model layer** in the 3D tab. One photo can go
through the object or character sheet to get its other views first.

### 3.1 Check what ComfyUI has
Use `/object_info` to find the native Pixal3D and TRELLIS.2 node classes, their inputs (single and
multi-view) and their model files. The native Pixal3D template is called "Pixal3D & TRELLIS.2: Image to
Model" in ComfyUI's template library, so open it in ComfyUI and export it as API JSON as the starting point.
Note the exact model file names and folders for the README models table.

### 3.2 Templates
- `templates/deck-3d-object.json` (Pixal3D):
  - `@1 Front [image]`, plus optional `@2 Back`, `@3 Left`, `@4 Right` (empty image fields are dropped
    already: see "empty-image drop" in `tests/test_core.py`);
  - `@5 Detail` (resolution/steps), `@6 Texture` on/off, `@7 Seed`;
  - Save GLB with `filename_prefix` `deck/object3d`.

  If multi-view needs a different node graph from single-view, make two templates (`-single`, `-multi`) and
  let the UI pick by how many views are given.
- `templates/deck-3d-object-trellis.json`: the same fields for TRELLIS.2, for comparing.
- Background removal: if these models want a cut-out, add the native background-removal node or reuse SAM3
  in front. Check what the example workflow does.

### 3.3 Flow in the app
- **Use as…** on an image (`web/useas.js` `sceneTargets`): add **Make a 3D object** next to "Make a 3D
  photo". It opens a sheet with:
  - **From this photo only** (queues single-view);
  - **Make its views first** (queues `deck-h3-objectsheet`, or `deck-h3-charsheet` with a
    Person/Object `seg`, waits with `make.js` `runAndWait`, pulls the views at the frames the README lists,
    then queues multi-view);
  - **Pick the other views…** (an image picker for Back/Left/Right, for your own photos from several
    angles).
- **Frames from the sheets**: the sheet clip's frames `4, 54, 96, 120` are front, side, back, other side.
  Pull them with the existing frame-grab endpoint (grep for the first/last frame code). Map side and other
  side to left and right, and check which is which on one example.
- **Mesh outputs**: `useas.js` line ~162 sends every `.glb` to `addPhoto` (the MoGe photo layer). Split it:
  generations with template `3d photo` keep `addPhoto`; any other GLB gets **Add to the 3D scene** as a
  **model layer** through `scene-import.js`. Find or add an `addModel(url, name)` export that does what
  importing a file does (fit to about 1 m, standing on the floor at the scene centre), and export it from
  `scene.js`.
- **3D tab, + Add**: **🧊 Object from photos…** opens the same sheet from inside the scene.
- The sheet shows the inputs as cards and the result as a turntable thumbnail. `outputCard` already draws a
  mesh tile; check that `kinds.js` handles GLB thumbnails.

### 3.4 Done-when
- Tests: the template's field parsing (four image fields, empties dropped) in `tests/test_core.py` style;
  `useas` routing (3d photo → photo layer, other GLB → model layer) as a small node test if possible.
- By hand: one photo → object in the scene; photo → object sheet → 4 views → object; check the textures
  survive. Add the VRAM used to the README models table.

---

## Phase 4: auto-rig people onto the posable figure's skeleton

**Goal:** a person-shaped model (from Phase 3, or an imported GLB/FBX) becomes a **rigged model** driven by
the figure's own joints. So every pose, Pair, Move, IK, Hands, Face, mocap and text-to-motion feature works
on it, and the OpenPose render works too.

### 4.1 Rigging in ComfyUI
- Look for **Make-It-Animatable** nodes (`BD AutoRig (MIA)`, or the "MIA: Auto Rig" in ComfyUI-UniRig) with
  `/object_info`. Fall back to UniRig's skeleton and skinning nodes. Check the licences and write them in
  the README.
- `templates/deck-autorig-human.json`: `@1 Model [mesh path or file]`, outputting a **skinned GLB**
  (Mixamo-style bone names for MIA). If a node only writes FBX, add a conversion step: look for a ComfyUI
  FBX→GLB node, or convert on the server with `assimp` / Blender CLI if they're installed. Document
  whichever is chosen.
- **Textures**: UniRig's "Rig to GLB" drops the materials. After rigging, copy the materials from the
  original GLB onto the rigged one by mesh index. Do it in the browser at load time (simplest: load both and
  move `material` across).

### 4.2 Bone map (new `web/rig-map.js`, pure)
- A table from Mixamo bone names (`mixamorig:Hips`, `Spine`, `Spine1`, `Spine2`, `Neck`, `Head`,
  `LeftShoulder`, `LeftArm`, `LeftForeArm`, `LeftHand`, `LeftHandThumb1..3`, `LeftUpLeg`, `LeftLeg`,
  `LeftFoot`, `LeftToeBase`, …) to `figure.js` `JOINTS` names (`hips`, `spine`, `chest`, `neck`, `head`,
  `lsho`, `lelb`, `lhand`, `lhip`, `lknee`, `lfoot`, the finger joints …). Also map UniRig's names, and
  guess by position when they aren't recognised: for each figure joint, the nearest bone in the right
  chain.
- **Rest pose**: work out a per-bone rest offset `restQ[bone]` = the turn from the figure's rest pose
  (`FIGURE.preset('stand')` or its T-pose) to the model's bind pose, in world space. Then each frame,
  `bone.quaternion = parentInv * (figureWorld[joint] * restQ[bone])`. The same idea as `motion.js` `aim()`:
  only bone directions matter, not lengths.

### 4.3 Layer type `rigged` (new `web/scene-rig.js`)
- `TYPES.rigged = { label: 'Rigged model', icon: '🦴', size: [1,1,1] }`; `EVEN` gets it. The layer is
  `{ type: 'rigged', url, name, map: {bone: joint}, rest: {...}, ground: true }`.
- Its **values are a figure's**, using `namesFor()` → `FIG` for `rigged` too. That way keys, the Poses tab
  and Moves just work. A hidden `figure.js` rig is built for it (no meshes, or meshes not rendered) and
  posed by `pose(f)` as usual; then the skinned model's bones copy that rig's world turns through the map.
  Render the model's `SkinnedMesh` in place of the figure's volumes.
- Joint dots, IK and the gizmo come from that hidden rig, so they work with no new code. Check every
  `o.type === 'figure'` in `web/scene-*.js` and `figure.js` callers: most should become `isPosable(o)`
  (figure or rigged). Make that a helper in scene-data.js.
- Depth and clay renders draw the skinned mesh. Pose renders use the hidden rig's `projectPose`, so they
  work as they are.
- Make it from: Use as… on a GLB → **Rig as a person** (queues the template, then adds the layer), and in
  the 3D tab, a selected model layer → **🦴 Rig as a person**.

### 4.4 Refining
- **Fit**: after rigging, show the model with the hidden rig's joint dots over it. **Fit joints** mode lets
  you drag each dot (the gizmo in Move) to where the joint really is. This changes `restQ`/offsets (a
  per-joint offset `o.fit[joint] = [dx,dy,dz]` added to the hidden rig's rest positions), not keys. Mirror
  L/R is a toggle (reuse `R.sym`).
- **Re-skin**: if the weights are bad after moving joints, offer **Re-skin with these joints**, which sends
  the edited skeleton back to the skinning stage. That's possible with UniRig, whose skinning node takes a
  skeleton; it isn't possible with MIA. If neither works, do it locally: heat-diffusion weights are a later
  extra, so leave a TODO.
- Save fits per layer; undo works through `save()`.

### 4.5 Done-when
- Tests: `tests/rig_map.test.mjs`: the Mixamo name map, the position-based guess on a synthetic skeleton,
  and a figure pose put on a synthetic skinned skeleton giving the expected bone directions.
- By hand: photo → object (Phase 3) → rig → pick a Pose, play a Move, apply a mocap clip, render depth and
  pose videos.

---

## Phase 5: auto-rig anything else (animals, props) as a generic skinned layer

**Goal:** models that aren't people get a guessed skeleton that you can refine and pose bone by bone, with
keys.

### 5.1 Rigging
- `templates/deck-autorig-any.json` with UniRig (skeleton, then skinning, then Rig to GLB). Puppeteer is the
  alternative if a node exists (check `object_info`). Expose `@2 Detail` / seed if the nodes have them.
- The textures fix from 4.1 applies here too.

### 5.2 Layer type `skinned` (in `web/scene-rig.js`)
- The values are `OBJ` plus `b` (bone turns), with channels `b.<boneName>` as quaternions: the same as the
  figure's `j.` channels. Add the `b.` prefix wherever scene-data.js handles `j.` (`baseOf`, `valOf`,
  `sampleChan` slerp, `keyChans`, `sample`, `overlay`, `bakeBase`). Do it once, generically
  (`isQuatCh(ch)`), and not by copy-paste.
- **Bone dots** at each bone head, picked like the joint dots. Rotate them with the gizmo. **Move** on an end
  bone uses a simple CCD IK up its chain (2–3 bones; stop at a branch). Keep it in a pure `web/ik.js` with
  tests.
- **Refine skeleton** mode:
  - drag bone heads (rest positions);
  - add a bone (tap a bone, then tap where the new child goes);
  - delete a bone (its children move up to its parent);
  - rename;
  - **Mirror** (pair bones by x position and keep them mirrored).

  After editing: **Re-skin** sends the edited skeleton to UniRig's skinning stage. The skeleton goes to the
  node in whatever format it takes: look it up. Store the rest edits on the layer, and keep the original so
  you can go back.
- The key sheet shows bones grouped by chain, like the finger rows.

### 5.3 Done-when
- Tests: the generic quaternion channels (a figure scene loads and samples exactly as before), CCD IK
  reaching a target, and rest edits applied in a stable order.
- By hand: a four-legged animal photo → object → rig → refine a leg → key a step cycle → render depth.

---

## Phase 6: world-space mocap for moving cameras (GEM-X)

**Goal:** a second mocap template for handheld or moving-camera clips, with world-space body, hands and face.

- **GEM-X** (NVlabs, Apache 2.0 according to its repo: check) has no ComfyUI node that I found. Write
  `comfy_nodes/deck_gemx`:
  - a loader for the weights from `nvidia/GEM-X` on Hugging Face;
  - a predict node that takes IMAGE frames (and optional person boxes from RT-DETR), runs the GEM-X
    inference code (vendor it, or `pip install` it into ComfyUI's venv; follow its `docs/INSTALL.md`), and
    returns SOMA 77-joint world positions per frame;
  - `DeckSaveWorldMotion`, which maps SOMA 77 → the 22 SMPL joints, plus `hands` and `face` in the
    Phase 2 format. SOMA has an SMPL-X compatible layout, so the 22 come across directly: check the joint
    order in the SOMA model card.
- `templates/deck-mocap-world.json`, shaped like `deck-mocap.json`.
- In the **Motion from video** sheet: **Camera in the clip: Still / Panning (track) / Moving (world
  mocap)**. Moving uses this template when it's installed; otherwise it's disabled with a note.
- The output also has the **camera path** in world space. Offer **Bring the camera into the scene**: key the
  scene camera with it (position, look direction, fov), so the figure and camera line up with the clip.
- Phase 2 clean-up runs on this too (contacts especially).
- **Alternative if GEM-X won't install**: GVHMR through `ComfyUI-MotionCapture` (PozzettiAndrea). Write a
  saver for its SMPL output and check its licence.
- Tests: the SOMA → 22 mapping on a fixture, and the saver's JSON shape. By hand: a handheld walking clip,
  compared with Phase 2's output.

---

## Model and node checklist (fill in during each phase, then copy to the README tables)

| Phase | Thing | Where it goes | Check |
|---|---|---|---|
| 2 | SAM 3D Body hand refinement | (same model) | speed with it on |
| 2 | Native SAM 3D Body nodes | ComfyUI core | class names |
| 3 | Pixal3D (single + multi-view) | ComfyUI core; weights folder? | names, VRAM, licence |
| 3 | TRELLIS.2 | ComfyUI core | names, VRAM |
| 4 | Make-It-Animatable | custom node pack? | licence, output format |
| 4/5 | UniRig skeleton + skin | `ComfyUI-UniRig`, `models/unirig` | textures dropped; skeleton input for re-skin |
| 6 | GEM-X | `deck_gemx` (new), weights `nvidia/GEM-X` | licence, install, VRAM |
| 6 alt | GVHMR | `ComfyUI-MotionCapture` | licence |
