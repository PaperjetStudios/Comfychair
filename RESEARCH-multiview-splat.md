# Research: a splat from more than one photo

Written 2026-10-30. Research only, nothing built. The question: SHARP makes a splat from **one** photo (it fills in only
what that photo shows). Is there a way to make one from several photos or a clip?

**Where this comes from:** web searches this session (arXiv pages, GitHub and node-pack listings) plus a look at this
machine. I couldn't open the repos' READMEs, so **GPU memory, view limits and licences below are not confirmed**;
check them before building. What I did find is marked as found; what I didn't is marked "not found".

## What we have now

- SHARP (`/mnt/data/sharp-venv`, `apple/ml-sharp`) takes one image, or a folder of them, but each image is its own
  scene: one `.ply` per image, never combined. Its paper and README describe a single-image model. No multi-view option
  exists in `sharp predict` (options: input, output, checkpoint, render, device).
- SHARP's licence is Apple's: the code licence plus a separate `LICENSE_MODEL` (one third-party listing calls the model
  research-use, non-commercial). Worth reading `/mnt/data/ml-sharp/LICENSE_MODEL` before relying on it for paid work.
- Machine: RTX 4070 SUPER, **12 GB**; `/mnt/data` has 259 GB free. The ComfyUI venv has torch 2.14 (cu130). **Not installed:**
  `colmap`, `glomap`, `brush`, `gsplat`, `vggt`.
- The 3D tab already takes any `.ply` splat (levels, trim, flip, box) so a new maker only has to write a `.ply` into
  the project's `.deck/assets/<group>/` like `finish_splat` does (`app/sceneasset.py`).

## Three ways to get a splat from several photos

### 1. Feed-forward, no camera poses: AnySplat (best fit)

- **AnySplat** ([paper](https://arxiv.org/html/2505.23716v1), [code](https://github.com/InternRobotics/AnySplat), SIGGRAPH Asia 2025):
  a set of **unposed** photos in, 3D Gaussians **plus each photo's intrinsics and pose** out, in one forward pass. It
  distils geometry from VGGT, so it needs no COLMAP. The paper says it copes with hundreds of views, where earlier
  pose-free feed-forward methods managed about 2–24.
- Code and weights are public (training and inference code released 2025-06-30). The listing I saw shows an **MIT**
  licence for the repo (confirm in the LICENSE file; the weights may carry their own terms). Written for Python 3.10+,
  PyTorch 2.2 / CUDA 12.1, said to work with others.
- **Not found:** GPU memory per view count, and any ComfyUI node for it. On 12 GB, expect to cap the views (maybe 8–32)
  and the image size; this has to be measured.
- It makes a splat of the *whole captured scene or object*, with real geometry from every side the photos cover. That
  is what SHARP can't do.
- Newer papers build on the same idea (FLEG, 2Xplat, ATSplat, EcoSplat, a frame-consistent pipeline using frozen VGGT
  poses); I only saw abstracts. None looked like a ready tool.

Fit for ComfyChair: a **separate venv on /mnt/data** (like SHARP's and the voice engines'), one server endpoint
`/api/scene/splat-multi` taking 2–N input images, run under the same GPU lock as SHARP (`voice._gpu`), then
`finish_splat`-style levels. The sheet would be "Splat from several photos": pick photos, choose preview density, go.
No camera for the shot to look through by default; AnySplat gives per-photo poses, so "camera to photo N" is possible.

### 2. A video or photos fused out of SHARP: camera-comfyUI

- [camera-comfyUI](https://github.com/Alexankharin/camera-comfyUI) is a ComfyUI node pack whose `VideoToFusedSplats` node
  runs **SHARP on video keyframes, scale-aligns each to metric depth, drops moving pixels and fuses the keyframes into
  one world-frame splat**. It uses **VGGT** (camera pose and depth) and **gsplat**. Other nodes: `ImageToSplat`,
  `MergeSplats`, `FuseSplats`, `SplatPolish`, `RenderSplat`, `LoadPlySplat`, `SavePlySplat`.
- Install is one script (`install.py`: requirements, VGGT from GitHub, the SHARP submodule, gsplat, a sibling inpainting
  pack). gsplat's CUDA kernels compile on first use.
- It is SHARP's look (soft, learned) with more coverage, rather than a true reconstruction. It reuses the SHARP we
  already run. **Not found:** how well it works on a few still photos rather than a clip; licence of the pack.
- It runs inside ComfyUI, which fits how this app runs templates, but a template needs the nodes to exist in our
  ComfyUI first (and the memory note about ComfyUI updates dropping patches applies).

### 3. Classic reconstruction: COLMAP-style poses, then train

- Camera poses from COLMAP/GLOMAP (or VGGT), then train a splat with **gsplat** ([paper](https://arxiv.org/pdf/2409.06765):
  on an A100 it trained MipNeRF360 scenes in about 19 min and 5.6 GB, against 26 min and 9 GB for the original), or
  LichtFeld Studio, or Brush. The best quality when there are many sharp photos (dozens to hundreds) and the scene is
  static.
- Cost: minutes to an hour per scene, needs 30+ overlapping photos, and nothing here is installed. I found no timing
  for a 12 GB card and nothing on Brush or GLOMAP. ComfyUI-SplatKit
  ([listing](https://comfy.icu/extension/mickmumpitz__ComfyUI-SplatKit)) only builds a COLMAP dataset from one 360° panorama.
- Too heavy for "tidy a few photos into a splat"; sensible only as an "I walked round it with my phone" mode.

## Single-image alternatives, for contrast

- **TripoSplat** (Comfy Org, in ComfyUI's docs) and ComfyUI's native `GAUSSIAN` type: single image to splat; they
  generate the unseen sides rather than reading them from extra photos.
- **ComfyUI-Sharp** (PozzettiAndrea) wraps the same SHARP as three nodes; nothing multi-view.

## What I'd do

1. **AnySplat first**: a venv at `/mnt/data/anysplat-venv`, an endpoint beside `/api/scene/splat`, a sheet taking 2–16
   photos. Start by measuring VRAM use on the 4070 at 4, 8, 16 views and 512/768 px; decide the caps from that.
   Check the weights' licence.
2. Keep **SHARP for one photo** (fast, under a second) and offer the multi-photo maker when 2+ are picked.
3. Park the classic COLMAP/gsplat route and camera-comfyUI's video fuse until AnySplat's result is seen.

## Open questions

- AnySplat's real VRAM and speed on 12 GB; its output Gaussian count (the app thins to 250k by default for the tablet).
- Whether its splat comes out y-down or y-up, and its scale (SHARP's is metric-ish; the `flip` and `fit` defaults would
  need setting).
- Whether the weights and VGGT carry non-commercial terms.
- Whether photos from different lighting or a generated "character sheet" work (these are not real views of one
  object, so a pose-free model may fail; real photos are the target).

## Sources

- [AnySplat paper](https://arxiv.org/html/2505.23716v1) · [Hugging Face paper page](https://huggingface.co/papers/2505.23716) · [InternRobotics/AnySplat](https://github.com/InternRobotics/AnySplat)
- [camera-comfyUI](https://github.com/Alexankharin/camera-comfyUI) · [VideoToFusedSplats](https://comfy.icu/node/VideoToFusedSplats)
- [Apple ml-sharp](https://github.com/apple/ml-sharp) · [SHARP paper](https://arxiv.org/html/2512.10685v1) · [ComfyUI-Sharp](https://www.runcomfy.com/comfyui-nodes/ComfyUI-Sharp)
- [gsplat paper](https://arxiv.org/pdf/2409.06765) · [ImprovedGS+ (LichtFeld Studio)](https://arxiv.org/pdf/2603.08661)
- [ComfyUI native splat nodes](https://radiancefields.com/comfyui-adds-native-gaussian-splat-manipulation-nodes-for-rendering-meshing-and-transformation) · [ComfyUI-SplatKit](https://comfy.icu/extension/mickmumpitz__ComfyUI-SplatKit)
- Newer feed-forward papers (abstracts only): [FLEG](https://arxiv.org/pdf/2512.17541) · [2Xplat](https://arxiv.org/pdf/2603.21064) · [ATSplat](https://arxiv.org/pdf/2607.20417) · [EcoSplat](https://arxiv.org/pdf/2512.18692)
