# Plan: re-check the 2026-10-29 DeepSeek session on the GPU

## What went wrong

The DeepSeek session built phases 1–7 of `PLAN-3d-mocap-shots.md` (uncommitted on `main`), then stalled on a
**3D object** run (`deck-3d-object`, Pixal3D) that never finished.

- **ComfyUI ran on the CPU.** The agent's shell was sandboxed: `~/.cache/uv` was read-only (`.check/comfyui.log`) and
  `/dev/nvidia*` was hidden. It restarted the shared ComfyUI on :8188 from inside that sandbox at 16:28 and 17:10.
  `user/comfyui_8188.prev*.log` show `Device: cpu`, `Set vram state to: DISABLED` and "Total VRAM 64092 MB" (that is
  system RAM). torch is `2.14.1+cu130`, so the GPU was hidden from the process, not missing.
- **The stall.** Runs 608 (20 steps, 4096 texture), 609 (6 steps) and 610 (2 steps, 1024, no texture) all reached
  BiRefNet → MoGe → DINOv3 → NAF and then went silent at the Pixal3D sampler. The last log line was at 18:35:25. Run
  610 was still "running" after 48 min, until ComfyUI was restarted at 19:23 (that restart has the 4070 SUPER again).
  The agent polled `follow.py` every 20 s and did not read the ComfyUI log. Sparse-voxel sampling on the CPU does not
  finish.
- **Other things the CPU blocked** (the session's own notes in `NOTES.md` say so):
  - UniRig / Make It Animatable took 13 min on the CPU. It worked.
  - Mocap clean-up: "Three real clips were not checked".
  - Multi-view: which sheet frame is which side has not been checked.
  - Regenerate: no real run was made.
  - GEM-X (phase 6): not installed.
- **No harm to live data.** The dev server used `.check/data2` on :8196. The live DB has no runs since 07:51. Today's
  checkout passes 309 Python tests (run with `DECK_DATA` set) and 20 node test files.

## Fix plan

### 0. Stop it happening again
1. Agents must never restart ComfyUI from a sandboxed shell. Add this to `NOTES.md` and memory: after a restart, check
   `curl :8188/system_stats` and confirm that `devices[0].type` is `cuda`.
2. In the app, `/api/status` reads ComfyUI's `/system_stats`. When the only device is `cpu`, the header shows a
   warning: "ComfyUI is running on the CPU". This also carries `vram_total`, which phase 7.2 wanted for hiding 2K.
3. Make `follow.py`-style waits time out. If ComfyUI's log or progress has not moved for N minutes, stop and report
   instead of waiting.

### 1. Re-run the 3D object on the GPU (phase 3)
1. Run the queue-empty check first, then submit run 610's params (2 steps, 1024, no texture) through the scratch dev
   server. Watch `comfyui_8188.log`. Expect minutes, not hours.
2. If it fits in 12 GB, step up to 609 (6 steps), then to the defaults (20 steps, texture on). If texturing runs out of
   memory, lower `@4 Texture resolution` before you try the TRELLIS.2 fallback template.
3. Check that the GLB lands as a `model` layer (`useas.js` → `scene-import.js addModel`).
4. Check the multi-view order on a real object sheet: frames 4, 54, 96 and 120 should be front, left, back and right.
   Fix the order in `scene-import.js` if a side is swapped.

### 2. Re-check the rest on the GPU
1. **Auto-rig (4.1 / 5.1):** time `deck-autorig-human` and `deck-autorig-any` on the GPU, starting from the GLB made in
   step 1. Confirm that `DeckSaveRig` writes the file and that the bones map. `UniRigLoadMesh` reads its list at
   startup, so restart ComfyUI once (normally, outside any sandbox) after `/api/scene/mesh` copies the file.
2. **Mocap clean-up (2.6):** run `deck-mocap` on three real clips: a walk, a turn and a jump. Check that hands, face and
   `cam_t` are saved, and that the planted feet do not slide under a pan.
3. **Regenerate (7.6):** the r384 refiner has downloaded (`regen-dl.log` R384_OK). Run Board ▸ Finish on one H3 draft
   at 1080P with Standard, then Enhanced. Watch faces and lip sync. Also try Refine with H3 + Regenerate on a scene
   render, with the depth hold on and off.
4. **GEM-X (phase 6):** still not started. It needs its own venv (torch 2.10) on `/mnt/data`. Ask the user before you
   install it.

### 3. Clean up and commit
1. Delete `.check/` junk, or move it out of the repo: `rig-test.glb` (29 MB), the `uv/numba/mpl` caches,
   `data2/` and the screenshots. Keep `cdp.py` only if it is worth keeping in `dev/`.
2. Look over the uncommitted diff (35 files, about 2.3k lines, plus the new files). Commit it in phase-sized commits on
   a branch: phases 1, 2, 3, 4–5 and 7. Merge only after steps 1–2 above.
3. `HANDOFF.md` (2026-10-26) is older than this session. Check whether it is still needed.

---

# Results of the GPU re-check (2026-10-29, evening)

ComfyUI on the 4070 SUPER (12 GB), `.check/data2` scratch app on :8196, live data untouched. Outputs are in
`.check/data2/projects/Unsorted/`.

## What passed

| Test | Result |
|---|---|
| 3D object, 2 steps, 1024, no texture | 10 s (32 s cold) once the bug below was fixed |
| 3D object, 20 steps, texture 4096 | 160 s, 5.8 MB GLB (CPU: never finished) |
| Auto-rig human (`deck-autorig-human`, stock warrior mesh) | 13 s, FBX saved by `DeckSaveRig` |
| Auto-rig anything (`deck-autorig-any`, cow) | 20 s after the fix below (9 min then an error before it) |
| Mocap (`deck-mocap`, 6 s kitchen clip) | 40 s; body 141x22x3, `cam_t`, hands and face all saved |
| Mocap clean-up | bone-length variation 0.0107 to 0.0003, jitter down 70% |
| H3 draft (`deck-h3-i2v`, 3 s, 384x448) | 20 s |
| Regenerate Standard, 1080P (r384 refiner) | 80 s, 928x1088; clearly sharper (face, wood grain, fruit) |
| Regenerate Enhanced | 50 s, also good |
| Refine template with Regenerate on | 30 s, keeps the scene and sharpens |
| Test suite | 316 pytest tests pass (use a fresh `DECK_DATA`) |

## Issues, and how to fix them

1. **ComfyUI on the CPU (root cause of the stall).** Fixed by the normal restart. Still to do: the app warns when
   `/system_stats` shows no `cuda` device, and agents check it after a restart (memory note written).
2. **`deck-3d-object*` with Texture off failed:** `Save3DAdvanced: 'MESH' object has no attribute 'format'`. The switch's
   off side fed a `MESH` to a node that takes a file. **Fixed** in `dev/make_3d_object_templates.py` (a second
   `MeshToFile3D` on the plain side) and the three templates were regenerated. Add a test that a run with Texture off
   has a `MeshToFile3D` ahead of the save node.
3. **`deck-autorig-any` used `skeleton_template: "mixamo"`**, a human skeleton, so a cow failed after 9 minutes with
   `Expected 52 bones for cls='vroid', got 19 bones`. **Fixed:** the template now says `articulationxl`. Suggest a test
   that the "any" template never uses `mixamo`.
4. **Slow, silent failure.** The wrong-skeleton run spent 9 minutes before it errored and the app only showed
   "running". Suggest a stall warning in the run list when ComfyUI's progress has not moved for a few minutes, with a
   Cancel button that is easy to find.
5. **`rig.target_face_count` has no limits in the template.** The node needs 10000 to 500000 in steps of 10000; 8000 got
   a bare 400 from ComfyUI. Suggest `min`, `max` and `step` on that field.
6. **A video field takes `{"media": name}` or `{"generation": id}`**, not a path. The API answers "pick the video
   again", which does not say that. Suggest a clearer message that names the accepted forms.
7. **`deck-h3-i2v` `16.value` is in seconds.** I read it as frames and got a 49 s clip (6 min). Suggest the field label
   says "seconds" and a warning above, say, 15 s.
8. **Refine without Regenerate at denoise 0.7 replaces the whole clip** (a different scene came out). Regenerate's
   own schedule at the same strength keeps it. Suggest the sheet warns above about 0.5 when Regenerate is off, and
   that Regenerate is the suggested path for a finishing pass.
9. **`UniRigLoadMesh`'s file list is built at startup** (known). A mesh made after startup cannot be rigged until
   ComfyUI restarts. Rigging from one of the stock meshes already in `input/3d` worked without a restart. The fix
   still wants a path-taking loader inside UniRig's isolated env.
10. **Tests:** `unittest discover` skips the pytest-style files (`test_3d_object.py` and others), so the 309 count
    earlier was incomplete. Run `pytest tests`, and use a fresh `DECK_DATA` each time: a reused folder made three
    unrelated tests fail. Put this in `NOTES.md`.

## Not tested, or inconclusive

- **Plant feet and ground** (mocap): no change on the kitchen clip, which is a man leaning on a counter, not walking.
  Needs a real walk, a turn and a jump clip.
- **Multi-view order** (frames 4, 54, 96, 120 as front, left, back, right) and **the textured 3D model in the 3D
  tab**: not checked. The only photo that was already set up as the test image shows a real person partly undressed,
  so I stopped using it and deleted the copies I had made. Use a neutral object photo instead.
- **Rigged FBX in the 3D tab** (47-bone mapping, poses): the files were made, but not loaded in a browser this time.
  The earlier CPU session did check this path.
- **The merge LoRA** (r128, needs a Hugging Face token), **lip sync** on a talking clip, and **2K** (hidden on 12 GB).
- **GEM-X (phase 6):** not started; it needs its own venv. Waiting for a yes.
- A browser pass over Board's **Finish** and Story's **Finish takes** buttons.

---

# Remaining work, in order, with time estimates

Times are wall-clock estimates for one agent session, including GPU waits (measured today: object 160 s, rig 13-20 s,
mocap 40 s, H3 draft 20 s, Regenerate 50-80 s, refine 30 s). They are guesses, not promises. **Do the groups in order**:
A makes the app safer to test with, B proves the unproven, C is optional and large.

## Group A: fix what the re-check found (about 3 h 30 min)

| # | Task | Est. |
|---|---|---|
| A1 | CPU warning in the app | 45 min |
| A2 | Template tests for the two template bugs | 15 min |
| A3 | Stall warning on a quiet run | 1 h |
| A4 | Limits on `rig.target_face_count` | 20 min |
| A5 | Clearer "pick the video again" error | 10 min |
| A6 | Seconds label and long-clip warning on `deck-h3-i2v` | 20 min |
| A7 | Refine denoise warning when Regenerate is off | 30 min |
| A8 | `NOTES.md`: run pytest, fresh `DECK_DATA` | 10 min |

- **A1.** `app/main.py` `/api/status` already asks ComfyUI for its state. Add a call to `/system_stats` (cached about 30 s)
  and return `{gpu: "cuda"|"cpu"|"unknown", vram_total}`. `web/app.js` shows a red line in the header when `gpu` is
  `cpu`: "ComfyUI is running on the CPU: restart it from a normal terminal". The same `vram_total` lets the Regenerate
  sheet hide 2K below 24 GB (phase 7.2 asked for it). Done when: a fake `/system_stats` with only a cpu device shows the
  line (unit test on the status builder), and the real one shows nothing.
- **A2.** In `tests/test_3d_object.py`: with the `tex` switch's off side, the node feeding `Save3DAdvanced` is a
  `MeshToFile3D` in all three templates; `deck-autorig-any` never has `skeleton_template == "mixamo"` and
  `deck-autorig-human` uses `MIAAutoRig`.
- **A3.** The run list shows "running" for hours. Track the last time ComfyUI's `/queue` or progress websocket moved
  for the run (the app already follows the progress events). After 5 minutes with no progress message, show
  "No progress for N min: ComfyUI may be stuck" on the card with the existing Cancel. Do not cancel by itself: a
  texture bake legitimately sits for over a minute. Done when: a test feeds a run with no events and sees the flag; a
  run with events does not.
- **A4.** Add `min` 10000, `max` 500000, `step` 10000 to the field in `deck-autorig-any.json`'s meta if the field kind
  supports limits (`app/templates.py` reads `@N` tags); if it does not, clamp in `main.py` before queueing and say so.
- **A5.** `main.py` ~561: message becomes "Source video · Video: pick the video again (a media file, or a run's
  video: `{media}` or `{generation, index}`)". One line, with a test.
- **A6.** Label the `@N Length` field "Length (seconds)" in `deck-h3-i2v.json` (check the other `deck-h3-*` templates
  for the same field) and, in the sheet, warn above 15 s that it is about 20x slower than a 3 s test.
- **A7.** In `web/run.js` the Refine sheet: when Regenerate is off and Strength (`10.denoise`) is above 0.5, show
  "Above 0.5 the picture can turn into a different scene. Regenerate keeps it." Link: switch Regenerate on.
- **A8.** Two lines in `NOTES.md` under testing: `pytest tests`, not `unittest discover` (it skips function-style
  tests); a fresh `DECK_DATA=$(mktemp -d)` every time.

## Group B: the tests that could not run (about 4 h 15 min)

| # | Test | Est. | Needs from you |
|---|---|---|---|
| B1 | Foot planting on walk, turn and jump clips | 45 min | clips, or I make them with H3 |
| B2 | Multi-view order + textured model in the 3D tab | 1 h | a neutral object photo |
| B3 | Rigged FBX in the 3D tab (bones, poses, mirror) | 45 min | nothing |
| B4 | Merge LoRA (r128) against r384 | 30 min | a Hugging Face token |
| B5 | Regenerate on a talking clip (lips, faces) | 30 min | nothing |
| B6 | Board Finish and Story Finish takes in a browser | 45 min | nothing |

- **B1.** Make three 4-6 s clips with `deck-h3-i2v` (a person walking toward the camera, turning on the spot, jumping)
  from neutral stills, run `deck-mocap` on each (40 s), then `/api/motion/clean` with `feet` and `ground` on. Measure
  the lowest foot's horizontal speed while it is on the ground (target: under 0.05 m/s on planted frames, down from
  about 0.16 m/s) and the floor height range (target: under 0.03 m). If it does not plant, read `_plant` thresholds
  in `app/motion.py` before changing anything and re-test on the same three clips.
- **B2.** Make an object sheet (`deck-h3-objectsheet`) from a neutral object photo (a chair, a lamp). Run
  `deck-3d-object-multi` with the sheet's frames 4, 54, 96, 120 as front, left, back, right, then again with two views
  swapped. The right order gives one clean object; the swapped one shows a ghost or a doubled side. If the order is
  wrong, fix it in `web/scene-import.js`. Load the GLB in the 3D tab with headless Chrome over CDP
  (`.check/cdp.py` is the existing driver) and check it stands on the floor, is the right size, and the texture is on.
- **B3.** Rig a neutral mesh (the warrior again, or the output of B2 through `deck-autorig-human`), load the FBX with
  Rig it, and check: the 47-bone map, a strong pose (Touch toes), Mirror the bones, a bone dot drag with IK, Re-skin
  after Add bone. Send screenshots. Compare against `.check/*.png` from the CPU session for regressions.
- **B4.** After a token is in `~/.cache/huggingface/token`, download the 2.0 GB r128 merge (about 10 min on this
  link) to `/mnt/data/ComfyUI/models/loras`, check `regen_loras` marks `has_turbo: true`, run the same 3 s clip as
  today (Standard and Enhanced) and compare with the r384 results frame by frame. The winner becomes the default
  (phase 7 says so).
- **B5.** Draft a talking clip (`deck-test-talking.mp4` is a good source: 704x704, 5 s), then Regenerate Standard.
  Check lip sync by listening to both, and compare the face at 1:1. If lips drift, try `audio_mode = draft audio`
  from the Open-H3 pack (phase 7.1/7.2 text); that node is not installed yet, so say so in the result.
- **B6.** Headless Chrome on the scratch app with three finished clips in a project: select two on the Board, press
  Finish, check two runs queue and the new takes appear; open Story, Finish takes, check `vpending` clears and **Shots
  to video** picks the finished clips. Fix any button that stays disabled.

## Group C: bigger, optional (about 8 h 30 min)

| # | Task | Est. |
|---|---|---|
| C1 | UniRig loader that takes a path (no restart for new meshes) | 2 h 30 min |
| C2 | GEM-X world-space mocap (phase 6) | 6 h |

- **C1.** `UniRigLoadMesh` builds its file list when ComfyUI starts, so `/prompt` rejects a mesh made after that.
  Write a small `DeckLoadMesh` node in `comfy_nodes/deck_rigsave/` that takes a string path under ComfyUI's `input` or
  `output` folder, loads it with trimesh inside UniRig's isolated environment, and returns UniRig's `TRIMESH`.
  Risk: that type does not cross the environment boundary (see `NOTES.md`), so the node may have to run in the same
  worker. Timebox 90 min; if it does not work, keep the restart message and drop this.
- **C2.** Ask first. About 10 GB of downloads to `/mnt/data`, a separate Python 3.10+ venv with torch 2.10, SOMA 0.3.3,
  the checkpoints and a YOLOX detector (1.5 h); `comfy_nodes/deck_gemx` plus the saver that maps SOMA's 77 joints to the
  22 + hands + face format (2.5 h, read SOMA's joint order rather than guessing); the camera position keys and the
  Still / Panning / Moving choice in the sheet (1 h); a moving-camera test clip and the clean-up measurements (1 h).
  May run out of VRAM on 12 GB; if it does, stop and report instead of building more.

## Totals

| Group | Time |
|---|---|
| A: fixes | 3 h 30 min |
| B: unrun tests | 4 h 15 min |
| A + B (what I recommend doing next) | **7 h 45 min** |
| C1 | 2 h 30 min |
| C2 | 6 h |
| **Everything** | **about 16 h** |

Add about 20% if something in B fails and needs a fix. Do A and B first: they need no decisions except the
neutral photo, walking clips (or my making them) and the Hugging Face token.
