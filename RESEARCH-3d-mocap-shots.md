# Research: better video mocap, photo → 3D → auto-rig, multi-camera shots

Research only, nothing built. Written 2026-10-29. Licences and node names come from project pages and
third-party listings. Check each repo's LICENSE before relying on it.

## Where things stand now

- **Mocap** (`deck-mocap`): RT-DETR boxes → SAM 3D Body per frame → `SAM3DBody_Smooth` → `DeckSaveBodyMotion`,
  which turns MHR70 keypoints plus camera translation into 22 SMPL joint *positions*, filling in the spine and
  head (`comfy_nodes/deck_motion`). `web/motion.js` then fits them onto a figure as keys.
- **3D tab**: imports glb/gltf/obj/fbx and splats (`scene-import.js`), builds Photo in 3D with MoGe (a depth
  shell, not an object), and models by hand (`scene-model.js`). Update: `main` now has several cameras (one
  active), mocap "With its camera", per-frame depth ranges and a Story tab, so see `PLAN-3d-mocap-shots.md`.
- **Prompts**: H3's `[Shot N] At mm:ss.mmm, the camera cuts to …` is already supported (`web/app.js:240`,
  `deck-h3-charsheet`). `scene-pose.js` writes "Prompt from the poses".

---

## 1. Video mocap: what to improve

What's probably weak in the current chain, from reading the code (to confirm on real clips):

| Problem | Why |
|---|---|
| Camera moves in the source clip become body movement | everything is in camera space; nothing solves the camera |
| Feet slide, root jitters in depth | monocular depth per frame, no foot-contact constraint |
| Forearm, head and spine twist are lost | only positions go across; spine and head are filled in, so IK guesses the roll |
| Fingers and face aren't used | MHR70 has hand points, but only 22 joints are kept |
| Jitter | each frame is estimated on its own; smoothing comes after |

### A. Cheap wins with the models already installed

1. **Foot contact lock**: where a foot's speed is near 0 and it's near the floor, pin it and spread the error
   into the root. This is the main idea of the "World-Coordinate Human Motion Retargeting via SAM 3D Body"
   paper, which runs SAM 3D Body frozen and adds a contact-aware ground optimiser. It goes in
   `DeckSaveBodyMotion` or `app/motion.py`.
2. **Remove camera motion with the tracker you already have**: the Track motion sheet already solves a camera
   from TAPNext++ / simple tracks. Change each frame's body from camera to world space with that solve before
   saving.
3. **Keep more points**: MHR70's hand points → the figure's finger keys (they're already joints, three per
   finger). Nose and ears → head yaw and roll. Toes → foot pitch.
4. **Rotations, not just positions**: if the SAM 3D Body node gives MHR joint rotations (the native nodes may),
   save them so twist comes across. Otherwise, work out twist from the hand and foot points.
5. **Check ComfyUI's native SAM 3D Body**: it's been in core since about 23 Aug 2026, with person tracking and
   BVH export. It might track better than the custom pack, and it's one less dependency.

### B. A better model as a second mocap template

| Model | What it adds | Licence | ComfyUI |
|---|---|---|---|
| **GEM-X** (NVIDIA, Mar 2026) | world-space motion **with a moving camera**; 77 joints for body, hands and face (SOMA body model) | Apache 2.0 (the older GENMO repo is noncommercial) | none found, so a `deck_gemx` node would be needed |
| **GVHMR** | world-grounded motion in gravity-view coordinates; tried and tested | check | `ComfyUI-MotionCapture` (PozzettiAndrea, same author as your SAM3 nodes), SMPL → BVH |
| **PromptHMR-video** | temporal model plus metric SLAM for world space, several people | check | none found |

**Recommendation:** do A first (1 and 2 matter most). Then add GEM-X as `deck-mocap-world` for clips with a
moving camera, saving into the same `{fps, frames}` format, so nothing changes in `motion.py` / `motion.js`.
That way the existing figure, keys, Moves and Prompt from the poses all keep working.

---

## 2. Photo(s) → 3D object

| Model | Input | Output | Notes |
|---|---|---|---|
| **Pixal3D** (Tencent ARC, SIGGRAPH 2026) | 1 image, or **4 views** | GLB with PBR | **built into ComfyUI** (22 Aug 2026), multi-view weights since 8 Sep. Comfy says it matches the input more closely than TRELLIS.2 |
| **TRELLIS.2** (Microsoft, MIT) | 1 image (multi-view through the visualbruno wrapper) | GLB | also built in; about 16–24 GB VRAM reported |
| Hunyuan3D 2.x / 2mv | 1 or 4 views | mesh + texture | the licence has region and scale limits; 3.x isn't open |
| SAM 3D Objects (Meta) | an object inside a scene photo | mesh, texture and placement | `ComfyUI-SAM3DObjects`; licence unclear |

**Suggested flow, built from what you already have:**

```
photo ──▶ deck-h3-objectsheet (front / ¾ / back views, already made)
      └─▶ pick 4 views ─▶ Pixal3D multi-view (native) ─▶ GLB ─▶ History "Add to 3D" ─▶ model layer
```

`deck-h3-objectsheet` already makes consistent views from one photo, so "one photo" and "a few angles" go
through the same path. If you have real photos from several angles, they go straight into Pixal3D multi-view.
For characters, `deck-h3-charsheet` frames 4/54/96/120 (front, side, back, other side) feed in the same way.
A new template is enough (`deck-pixal3d`, `@Image` ×4 → save GLB), plus an "Add to 3D" for GLB outputs (the
MoGe mesh already works this way).

---

## 3. Auto-rig, with a guess you can refine

| Tool | Handles | Output | Licence | ComfyUI |
|---|---|---|---|---|
| **Make-It-Animatable** (CVPR 2025) | humanoids only, under 1 s | Mixamo-style skeleton + weights (FBX) | check | `BD AutoRig (MIA)`, also in ComfyUI-UniRig |
| **UniRig** (VAST, SIGGRAPH 2025) | anything: animals, props | skeleton, then skinning (two stages) | MIT | `ComfyUI-UniRig`, CCTech pack (Rig to GLB) |
| **Puppeteer** (ByteDance, NeurIPS 2025) | anything | skeleton + attention-based skinning | Apache 2.0 | none found |
| SkinTokens / TokenRig (VAST, 2026) | anything; UniRig's successor | skeleton and skin in one pass | check | none found |

Known catch: UniRig's Rig to GLB writes the bind-pose mesh **without textures**, so keep the original GLB and
move the weights across, or copy the materials back over.

**How "a guess, then I refine" could work here:**

1. **Humanoids → map to the figure's own skeleton.** Rig with MIA (or UniRig), then map its bones onto the
   posable person's joints. Then the 60 poses, Pairs, Moves, IK, hands, mocap and text-to-motion all work on
   your scanned character with no new animation code. The OpenPose render works too, because the joints are
   the same.
2. **Anything else → a generic rig layer**: a three.js `SkinnedMesh` with its own joint dots (the figure
   already has joint dots, the gizmo and FK/IK, so reuse them) and keys per bone.
3. **Refine**: show the guessed joints as dots, and let you drag them inside the mesh, add or remove bones, and
   mirror left and right. Then **only redo the skinning**: UniRig's skinning stage takes a skeleton as input,
   so it can be sent your edited one. For a quick offline fallback, compute heat-diffusion / geodesic weights
   in the browser. Paint-weights can wait.

---

## 4. Keyable active camera → shots in the prompt

This one needs no new models. It's front-end work on the 3D tab plus the prompt builder, and it's probably
the most useful thing on this list.

**Data** (`scene-data.js`):
- `SC.cameras = [{ id, name, base, chans, ease }]`, with today's `SC.camera` moved in as `cameras[0]`
  (`migrate` already handles old scenes).
- `SC.cuts = [{ f, cam }]`: a **step** row (no blend) at the top of the key sheet, labelled "Shots". ◆ Key on
  it, with a camera selected, writes "cut to this camera here". Its keys drag and retime like other keys
  (`keys.js` needs a step ease, or the row can skip interpolation).
- `activeCamera()` (`scene-view.js:530`) and the depth/pose/clay renders look up the camera from the cut at
  that frame.

**Prompt** (it extends Prompt from the poses): for each cut, one line:

```
[Shot 1] A wide shot, eye level, of <Subject 1> … ; the camera dollies in slowly.
[Shot 2] At 00:04.000, the camera cuts to a close-up of <Subject 2>'s face, low angle, static.
```

- **Shot size** from how much of the frame the subject's bounding box fills (ECU / CU / MCU / MS / WS / EWS).
  **Angle** from camera pitch (high, eye level, low, overhead) and from roll (Dutch). **Movement** from that
  camera's keys inside the shot: `scene-camera.js` `MOVES` already names dolly, orbit, pan and so on, and
  `writeMove` records which one was used.
- **What happens** comes from `promptItems()` limited to the frames of the shot.
- **Timecode:** the timeline can show SMPTE (`01:00:00:00`, starting at hour 1 like an edit), but the prompt
  must use clip-relative **`mm:ss.mmm`**. H3 wants exact, rising cut times, clips of 4–15 s at 24 fps, and
  copes with roughly 10 cuts. LTX-2.5 does multi-shot with **no** timestamps (2–4 shots, name each transition
  and re-establish the framing), so the shot writer needs one formatter per model family.

**Two ways to render it** (offer both):
1. **One take with cuts**: one depth/pose control video with hard cuts plus the `[Shot N]` prompt, into
   `deck-h3-ctrl2v`. Needs testing: whether H3's Fun ControlNet follows hard cuts in the control video
   cleanly.
2. **Shot list → one generation per shot**: render each shot's control video and prompt separately, queue
   them, and line the takes up on the Video timeline at the cut times. This is more reliable and not limited
   to 15 s. It's also the "scenes/shots/takes" item already in the README's *Next*.

---

## Suggested order

1. **Multi-camera cuts + shot prompt** (no models, uses existing code).
2. **Mocap A**: foot lock and camera compensation with the existing tracker; keep hands and head.
3. **Photo → 3D**: a `deck-pixal3d` template fed by the object or character sheets; GLB into the 3D tab.
4. **Auto-rig for humanoids** onto the figure's own skeleton (MIA), with joint refining.
5. **Auto-rig for anything else** (UniRig / Puppeteer) as a generic skinned layer.
6. **GEM-X** as world-space mocap for handheld or moving-camera clips.

## Sources

- Pixal3D / TRELLIS.2 native: https://blog.comfy.org/p/trellis2-and-pixal3d-are-now-native ·
  https://comfyui-wiki.com/en/news/2026-08-22-trellis2-pixal3d-native-comfyui ·
  https://comfyui-wiki.com/en/news/2026-09-09-pixal3d-multiview · https://docs.comfy.org/tutorials/3d/pixal3d
- TRELLIS.2 multi-view nodes: https://comfyai.run/documentation/Trellis2MultiViewImageToShape
- Hunyuan3D in ComfyUI: https://docs.comfy.org/tutorials/3d/hunyuan3D-2
- SAM 3D Objects nodes: https://www.runcomfy.com/comfyui-nodes/ComfyUI-SAM3DObjects
- UniRig: https://github.com/VAST-AI-Research/UniRig · ComfyUI-UniRig: https://www.runcomfy.com/comfyui-nodes/ComfyUI-UniRig ·
  Rig to GLB: https://comfy.icu/node/CCTechUniRigRigToGLB
- Puppeteer: https://proceedings.neurips.cc/paper_files/paper/2025/file/689cffc97600f9deb8374fc8fa918b8e-Paper-Conference.pdf
- SkinTokens: https://zjp-shadow.github.io/works/SkinTokens/
- Make-It-Animatable: https://arxiv.org/html/2411.18197v2 · node: https://comfy.icu/node/BD_AutoRigMIA
- GEM-X: https://github.com/NVlabs/GEM-X · https://huggingface.co/nvidia/GEM-X · GENMO: https://github.com/NVlabs/GENMO
- GVHMR: https://zju3dv.github.io/gvhmr · ComfyUI-MotionCapture: https://github.com/PozzettiAndrea/ComfyUI-MotionCapture
- PromptHMR: https://github.com/yufu-wang/PromptHMR
- SAM 3D Body world retargeting: https://arxiv.org/html/2512.21573 · native SAM 3D Body:
  https://comfyui-wiki.com/en/news/2026-08-23-sam-3d-body-native-comfyui
- H3 shot timing: https://www.atlascloud.ai/blog/guides/minimax-h3-video-length ·
  https://www.weshop.ai/solutions/models/mini-max-h3-prompt-guide-for-dialogue-and-timing
- LTX-2.5 multi-shot: https://runware.ai/docs/models/lightricks-ltx-2-5-pro/guides/multi-shot ·
  https://ltx.io/blog/ltx-2-5-prompt-guide
