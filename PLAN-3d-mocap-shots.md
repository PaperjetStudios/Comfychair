# Implementation plan: shots, better mocap, photo → 3D, auto-rig

A plan to hand to an LLM coding agent, one phase per session. Checked against `main` at `58356d6` (2026-10-29):
there are already several cameras, mocap "With its camera", per-frame depth ranges and the Story tab, and the
phases build on them. The background research is in
`RESEARCH-3d-mocap-shots.md` (phases 1–6) and `RESEARCH-h3-regenerate.md` (phase 7, finishing H3 drafts).
Each phase stands on its own, can be merged on its own, and ends with tests and a README update.
**Do the phases in order**: later ones assume the earlier ones, except phase 7, which only needs the H3 pipeline
that is already on `main`.

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

## Phase 1: a keyable active camera (cuts) and a shot-list prompt

**Already on `main`** (read `NOTES.md` "several cameras" and "Mocap with its camera" first):
- `SC.camera` is the *active* camera and `SC.cams` holds the others (`camsOf()`, `newCamera()`,
  `setActiveCam()` swap them). Every camera has `id` and `name`. Camera panel ▸ Cameras handles rename, New,
  Make active and Delete.
- In the director view the other cameras show as outlines (`scene-view.js` `OTHERS`), and tapping one makes
  it active. The other cameras have key sheet rows (`L.other`).
- Depth renders get their own near and far per frame (`web/depth-range.js` `frameRanges`, mode `follow`).
- The **Story** tab has scenes and shots, with words for shot size, angle and move (`web/story.js` `SIZES`,
  `ANGLES`, `MOVES`) and "Shots to video".

**What's missing (this phase):** the active camera can't change *over time*. Add **cuts**: a Shots row in the
key sheet that says which camera is live from which frame. The view during playback, the depth, pose and clay
renders, and scene compositions follow the cuts. Add a **Prompt from the shots** section that writes
`[Shot N] At mm:ss.mmm, the camera cuts to …`, using the same words as Story. No models are needed.

### 1.1 Data (`web/scene-data.js`)
```js
SC.cuts = [ { f, cam } ]   // sorted by f; cam = a camera id. Empty or missing: SC.camera throughout, as today
```
- `camById(id)` searches `camsOf()`.
- `liveCam(f)` returns the camera of the last cut at or before `f` (the first cut's camera before it). With
  no cuts, or a cut whose camera was deleted, it returns `SC.camera`.
- `shots()` returns `[{ i, f0, f1, cam }]`, the frame ranges between cuts, clipped to `frames()`.
  Neighbouring cuts to the same camera merge.
- `upgrade()` defaults to `cuts: []`. Deleting a camera (scene-ui.js Cameras) also drops its cuts. Undo
  covers both, because `save()` snapshots the scene.
- **What "active" means with cuts:** `SC.camera` stays the camera you **edit** (the moves, the gizmo, ◆ Key
  on the camera, the orbit). What the view **shows** while playing or scrubbing is `liveCam(f)`, unless you're
  editing a camera: in Camera mode or with the camera layer selected, you see the camera you edit. Add a
  toolbar toggle **View: Cut / Editing camera** (`R.viewCut`, kept per device) so you can choose. Renders
  always use `liveCam(f)`.
  `setActiveCam()` keeps working unchanged: it picks which camera you edit.

### 1.2 Showing and rendering through the live camera
- `scene-view.js` `pose(f)` puts up `current(shownCam(f), CAM, f)`, where `shownCam(f)` is:
  - `liveCam(f)` when `R.real`, or when `R.viewCut` is on and you're not editing a camera;
  - otherwise `SC.camera`.

  The orbit and gizmo code that writes to `SC.camera` must only run while the shown camera *is*
  `SC.camera`. When it isn't, a drag on the view orbits the free/director view or does nothing. Pick one
  behaviour, say it in the toolbar hint, and grep every `SC.camera` in `web/scene-*.js` to check each place.
- `scene-export.js`: the depth, pose and range passes get the camera per frame through `pose(f)`.
  `depth-range.js` `frameRanges` gains `breaks: [frames]`, so its smoothing never reaches across a cut: a
  close-up and a wide shot each get their own range from the first frame. Pass the cut frames when rendering.
  Add a test in `tests/depth_range.test.mjs`.
- `scene-offscreen.js` `Stage` (scene clips in the Video tab) uses `liveCam(f)` too. Keep `liveCam` and
  `shots` DOM-free so the stage can import them.
- **Render: One take / Each shot** (`SC.renderShots`):
  - *One take* is today's single video, now with hard cuts.
  - *Each shot* renders one video per shot (that shot's frames, its camera), labelled
    `Shot N · <camera name>`. The toast offers **Shots to Video tab**: copy how Story's "Shots to video" lays
    clips on the timeline, and share that code instead of writing it a second time.

### 1.3 Key sheet and panel
- **Shots row** (`scene-keys.js`, first row, its own track kind `cut`): each cut is drawn as a block from its
  frame to the next cut, coloured per camera and labelled with the camera's name.
  - ◆ on the row, or **✂ Cut to this camera here** in Camera panel ▸ Cameras (one button per camera),
    writes `{ f: R.f, cam }` and replaces any cut on that frame.
  - Dragging retimes a cut, and the existing selection, move, delete, copy and paste work on it. Store the
    cuts so `keys.js` can move them like keys, with `const` ease, never blended.
  - **Tapping a block** makes that camera the one you edit (`setActiveCam`) and seeks into the shot.
- **Cameras section**: show each camera's shots (e.g. "Shot 2 · 00:04–00:07"). Add **Shot under the
  playhead** to the camera panel.

### 1.4 Prompt from the shots (`web/shot-words.js` pure, `web/scene-shots.js` the section)
- **One vocabulary**: move `SIZES`, `ANGLES` and `MOVES` out of `story.js` into `web/shot-words.js`, and
  import them in both places. The 3D tab then describes a shot with the same words a Story shot uses.
- Work each shot out from the scene, with pure functions that have node tests (three.js runs in node):
  - **Subjects**: the visible figures and named objects whose box is mostly in the camera's view in the
    middle frame of the shot.
  - **Size**: the main subject's height on screen ÷ frame height (h):
    - h > 1.6 extreme close-up
    - 0.9–1.6 close-up
    - 0.4–0.9 medium
    - below 0.4 wide (Story has these four)
    - no subject: wide

    Tune the thresholds with test scenes.
  - **Angle**, from the pitch to the target: low, eye level, high or overhead. |roll| > 8° gives Dutch.
    Reuse Story's `ANGLES` keys.
  - **Move**, comparing the camera at f0, halfway and f1:
    - Δfov → zoom
    - distance to target changes → push or pull
    - turns around the target at a steady distance → orbit (say "the camera circles")
    - sideways with its target → track
    - only the target moves → pan or tilt
    - Δy → crane
    - dense noisy keys → handheld
    - nothing → static

    If `scene-camera.js` `writeMove` wrote the keys, record the move id on the start key (`k.mv = id`) and
    prefer it over guessing.
  - **Action**: `promptItems()` in `scene-pose.js`, limited to pose keys in `[f0, f1]`. Export a version that
    takes a frame range.
- **Lines**:
  - shot 1: `[Shot 1] A {size}, {angle}, of {subjects}{; the camera {move}}. {action}`
  - later shots: `[Shot N] At {mm:ss.mmm}, the camera cuts to a {size} …`

  Move the stamp code from `web/app.js` (the "[Shot N] At mm:ss.mmm" helper, ~line 262) into
  `shot-words.js` as `stamp(sec)` and use it in both places.
- **Timecode**: the shot list shows SMPTE `HH:MM:SS:FF` from **Start timecode** (`SC.tcStart`, default
  `01:00:00:00`). The prompt always uses clip-relative `mm:ss.mmm`.
- **Checks and formats**: warn when the clip is outside 4–15 s (H3), when cuts are under 1 s apart, or when
  there are more than 10 cuts. A **Format** `seg` offers H3 (timestamps) or LTX (no timestamps:
  "Shot 1: … Hard cut to shot 2: …", 2–4 shots).
- **UI**: chips like Prompt from the poses (tap to leave a shot out, long-press to edit its line, stored in
  `SC.shotText[cut id]`). Then **Copy**, **Add to Generate prompt** (`C.addToPrompt`) and **To Story**,
  which adds one Story shot per cut with size, angle, move and length filled in, the line as its
  description, and a clay frame from that camera as its frame. Look at how Story creates shots
  (`newShot`) and frames.

### 1.5 Tests and done-when
- `tests/shots.test.mjs` (with a Python wrapper like `tests/test_keys.py`):
  - `liveCam`/`shots` with no cuts, out-of-order cuts, a cut past the end, and a deleted camera;
  - `stamp`;
  - size and angle for fixed setups;
  - move words for each `MOVES` id (keys built with `writeMove`);
  - a scene from before this phase upgrades and renders through `SC.camera` as before.
- Browser check:
  1. two cameras plus cuts;
  2. playback cuts;
  3. a depth render cuts at the right frames, with a fresh range per shot;
  4. the shot prompt and To Story;
  5. undo and redo;
  6. an old scene.
- README: a **Shots** paragraph in the 3D section. NOTES: how cuts, `SC.camera` and `liveCam` relate.

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

### 2.3 Camera in the clip: already done for turning cameras
`main` has **Moves ▸ From video ▸ With its camera** (`scene-motion.js` `applyWithCamera`, `motion.js` `toWorld`,
`space` from `app/motion.py`, and `focal` from Deck Save Body Motion). It tracks the clip, adds a Mocap camera with
the footage behind it, and places the body in the world through it, for pan, tilt, roll and zoom only.
**Match its proportions** is done too. In this phase:
- make the 2.2 clean-up run **after** `toWorld`, so feet are planted in world space, not camera space
  (otherwise a pan makes a planted foot look as if it's sliding);
- in the sheet's help, say that a camera that physically moves (dolly, handheld walking) needs Phase 6.

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
- The output also has the **camera path** in world space. Reuse `applyWithCamera`'s flow (Mocap camera +
  backdrop, made active), but key the camera's *position* as well as its turn, from GEM-X's camera instead of
  the tracker.
- Phase 2 clean-up runs on this too (contacts especially).
- **Alternative if GEM-X won't install**: GVHMR through `ComfyUI-MotionCapture` (PozzettiAndrea). Write a
  saver for its SMPL output and check its licence.
- Tests: the SOMA → 22 mapping on a fixture, and the saver's JSON shape. By hand: a handheld walking clip,
  compared with Phase 2's output.

---

## Phase 7: finish drafts with Open-H3-Regenerate (the Regenerate second pass)

**Goal:** turn a quick H3 draft into a sharp take at 1080P, in a few denoising steps, without losing faces or lip sync.
The research is in `RESEARCH-h3-regenerate.md`; this phase is the build order for it. Nothing else in the plan depends
on it, and it can be merged on its own.

`app/h3upscale.py` (**Upscale** on an H3 run) already encodes the finished clip, enlarges its latent with
`MinimaxH3LatentUpscaler3D` and samples again from part-way (`LADDER`, `STRENGTHS`, the run's own prompt, LoRAs,
references and sound). Open-H3-Regenerate adds the **refiner LoRA** (trained for exactly this second pass), a **gentler
schedule** (2 steps from 0.7, where our `strong` 0.9035 is the point the report saw faces drift) and an optional fast
VAE. `templates/deck-h3-refine.json` (**Use as → Refine with H3**) is the same shape and gains the same way.

**What this box can do (12 GB VRAM, 64 GB RAM):** 1080P-class second passes already work here; 2K filled 32 GB on a
5090, so **2K stays hidden** unless a card over 24 GB is found. Use one of the smaller community LoRAs, not NVIDIA's
12.5 GB FP32 rank-576 file:

| File | What it is | Where |
|---|---|---|
| `minimax_h3_open_regenerate_2k_r128_comfyui_bf16.safetensors` (2.0 GB) | the whole merge (refiner + Turbo + Sharp); **drop the run's turbo LoRA** | `father558/H3-Open-Regenerate-2K-ComfyUI` |
| `minimax_h3_open_regenerate_2k_refiner_rank_384_bf16.safetensors` (5.9 GB) | refiner only; **keep the run's turbo LoRA** | `Kijai/MiniMax-H3-experimental` |

Both are ordinary ComfyUI LoRAs (`LoraLoaderModelOnly`), not NVIDIA's curve-aware format. **The father558 repo asked for
a token on this box** (the Hugging Face API answered "Invalid username or password"), so Kijai's public refiner is the one
that installs without one; the merge is worth trying when a token is available. The agent must try both on the same three
clips (faces, fine texture, motion) and make the winner the default.

### 7.1 Check what is installed
- Look for the pack's nodes with `/object_info`: `OpenH3RegenRefineLatent` (with `audio_mode` `silence` / `draft audio`),
  a LoRA loader taking `lora_name`, `curve_name` and `curve_table`, `OpenH3VideoToPrompt`, `BlockSparseAttention`, the
  latent upscaler's `1080p` / `2k` presets, and a fast VAE decode. These names come from a third-party report: **check
  them before wiring anything**.
- Candidate packs: `rdh9616/ComfyUI-Open-H3-Regenerate` (Apache-2.0, the one the report used) and
  `Songssx/ComfyUI-OpenH3-Regenerate2K` (MIT, needs `models/open_h3_regenerate/lora/` and **hard-checks the base
  checkpoint's sha** against `minimax_h3_ref2va_pruned_int8_convrot`, so it may refuse this install's community merge).
  Prefer the first; the second only if its check passes or is patched.
- **The Sharp curve branches are probably inert.** Check NVIDIA's file before downloading 1.2 GB:
  `python -c "from safetensors import safe_open as o; f=o('sharp_curve_branches.safetensors','pt'); print(max(f.get_tensor(k).abs().max().item() for k in f.keys() if 'curve_B' in k))"`
  in ComfyUI's venv. `0.0` means skip the file and the 32 KB timestep table; anything else means only a curve-aware
  loader applies it, and the pack above is that loader.
- Licences: the refiner LoRA and fast VAE are MiniMax H3 Community Licence; record them, and the latent upscaler's
  unstated one, in the README models table.

### 7.2 Regenerate in H3 Upscale (`app/h3upscale.py`, the sheet in `web/run.js` ~708)
- **Quality**: *Upscale (as now)* / *Regenerate (Open-H3)*. Show Regenerate only when the chosen LoRA file is in
  `models/loras` (and the pack's nodes, if its loader is needed); otherwise say what's missing, the way `main.py`'s
  MoGe check does.
- **Target**: `1.5×` (as now) and `1080P` presets; **2K hidden** below 24 GB of VRAM (ComfyUI's `/system_stats` gives
  `vram_total`; `/api/status` does not carry it yet, so add it there or read it in the sheet). Convert 1080P to a size
  with the same 32-pixel rounding as `target_size`.
- **Strength**: *Standard* = 2 steps, sigmas `0.7, 0.494117, 0`; *Enhanced* = 3 steps starting at `0.8` — confirm the
  exact list against the pack's `OpenH3RegenerateSigmas` (NVIDIA's 3-step ladder is `0.909375, 0.857142…, 0.666666…, 0`;
  the report's 0.8 start may replace its first two values). Cap the start σ at 0.8 in this mode; `sigmas()` stays for
  Upscale. Add `REGEN_SIGMAS` and a `regen` branch to `build()` rather than a second builder.
- `build(..., regen=...)`:
  - load the chosen LoRA with `LoraLoaderModelOnly` after the run's model chain, at strength 1.0;
  - drop the run's **turbo LoRA only when the file carries Turbo inside** (the r128 merge does; Kijai's r384 does not);
    keep character/style LoRAs for now, and test whether they fight the refiner;
  - if the pack's `OpenH3RegenRefineLatent` (or whatever the example workflow wires) is used, give it
    `audio_mode = draft audio` and the clip's sound, so lips stay in sync;
  - keep the existing VAE and tiled decode on 12 GB; the 6.5 GB fast VAE is an option to test, not a default.
- Tests in `tests/test_h3upscale.py`: the Regenerate graph has the refiner LoRA and the exact sigmas; the run's turbo
  LoRA is present with r384 and gone with r128; the clip's sound is connected; `regen` off leaves today's graph
  byte-for-byte the same.

### 7.3 Regenerate in `deck-h3-refine`
- Add a `@N Regenerate LoRA` stack to the template, **off by default**, and a `@N Regenerate` toggle that switches the
  sigma schedule. When it is on and the file carries Turbo, drop the `@Turbo LoRA` (it would double the distill).
- Try it on a 3D render with the depth hold on (and with it off): the gentler 0.7 start may make the hold unnecessary.
- If it holds up, the same mode finishes splats and scene colour renders at 1080P.

### 7.4 Draft, then finish (the workflow this exists for)
- Draft fast at 768P (512P/576P drafts are supported; try one for speed), pick the good takes, then **Finish**:
  - Board: select takes → **Finish** (queue Regenerate runs with `make.js` `queueRun`, one per take);
  - Story: **Finish takes** on a scene — every shot's chosen take, queued the same way.
- The finished clip is a child of its draft (lineage already records that), and **Shots to video** prefers a finished
  take over its draft (Story's clip choice).

### 7.5 Other models' drafts
- `deck-h3-refine` already encodes any clip into H3's latent, so try Regenerate on an **LTX** clip and a scene render.
  If faces and motion hold, add **Finish with H3** to Use as for every clip, not just H3 runs.

### 7.6 Done-when
- Tests: `tests/test_h3upscale.py` (the graph cases above) and, if the pack's nodes are used, a small test that the
  template's `@Regenerate` group is skipped when off (the existing empty-node rules in `app/templates.py`).
- By hand, on this box: three clips (faces, fine texture, motion), 768P → 1.5×/1080P, Standard 2 steps, r128 versus
  r384, with times and a face-by-face comparison in `NOTES.md`. 2K stays untested here (needs >24 GB).
- README: the node pack and its files in the custom-node and model tables; a **Finish a take** paragraph; the 2K
  caveat. NOTES: how the Regenerate graph differs from Upscale, and the Sharp-curve check's result.

## Model and node checklist (fill in during each phase, then copy to the README tables)

| Phase | Thing | Where it goes | Checked |
|---|---|---|---|
| 2 | SAM 3D Body hand refinement | (same model) | on by default; native `SAM3DBody_*` nodes; hands/face now stored |
| 2 | Native SAM 3D Body nodes | ComfyUI core | `SAM3DBody_Loader/Predict/Smooth`, `RTDETR_detect` |
| 3 | Pixal3D (single + multi-view) | ComfyUI core | `Pixal3DConditioning`, `Pixal3DMultiViewConditioning`, `Save3DAdvanced`; 5.2 GB int8; multi-view fov 20; a CPU pass is hours, so the by-hand check waits for the GPU |
| 3 | TRELLIS.2 | ComfyUI core | `Trellis2Conditioning/ShapeStage/TextureStage/UpsampleStage`, `VaeDecode*Trellis*`; 4.9 GB |
| 4 | Make-It-Animatable | `ComfyUI-UniRig` (isolated pixi env) | `MIAAutoRig` writes an FBX; ~13 min on CPU for a character; licence to confirm |
| 4/5 | UniRig skeleton + skin | `ComfyUI-UniRig` | `UniRigAutoRig`, `UniRigExtractSkeletonNew`, `UniRigApplySkinningMLNew`; its mesh list is fixed at ComfyUI startup |
| 6 | GEM-X | none installed | no ComfyUI node exists; the pip package needs torch 2.10 + CUDA, so not installed here |
| 6 alt | GVHMR | `ComfyUI-MotionCapture` | not installed |
| 7 | Open-H3-Regenerate refiner LoRA (r128 merge, Turbo inside) | `loras` (`father558`) | repo asks for a Hugging Face token |
| 7 | Open-H3-Regenerate refiner-only LoRA (r384) | `loras` (`Kijai`) | installed: 5.6 GB, 416 tensors, refiner-only |
| 7 | Sharp curve branches + timestep table | `open_h3_regenerate/lora/` (Songssx only) | not downloaded; check `curve_B` first |
| 7 | Fast H3 VAE (non-causal, 24 layers) | `vae` | not downloaded; the standard decode is what the tests use |
| 7 | Open-H3-Regenerate node pack | `rdh9616/ComfyUI-Open-H3-Regenerate` | not needed: the LoRAs work in plain `LoraLoaderModelOnly` |
