# Research: Open-H3-Regenerate-2K (NVIDIA) in ComfyChair

Written 2026-10-29. Research only, nothing built. **Open-H3-Regenerate-2K** comes from NVIDIA's NVlabs Sana team,
released about 27–28 Oct 2026. It's an open replacement for MiniMax's **H3-Regenerate-2K**, which is API-only. It
takes a draft at 384P, 512P, 576P or 768P and draws it again at 768P, 1080P, 2K (2560×1440) or 4K (3840×2160), using
a latent upscale and a refiner LoRA for a few denoising steps.

**Where the details come from:** I couldn't open NVIDIA's project page or comfyui-wiki (this session's network
blocks those hosts). File names, node names and timings come from a third-party RTX 5090 test report
(inkseq/h3-studio #795) and search summaries. Check them against the model card and node pack before building.

## What it is

| Part | File (HF `Efficient-Large-Model/Open-H3-Regenerate-2K`) | Size |
|---|---|---|
| Refiner LoRA (said to have LightX2V Turbo and LMS Sharp merged in) | `lora/open_h3_regenerate_2k_lora.safetensors` | 12.5 GB |
| Sharpness curve | `lora/sharp_curve_branches.safetensors` | 1.2 GB |
| Fast VAE decoder | `vae_fast/fast_h3_vae_noncausal_24l.safetensors` | 6.5 GB |
| Latent upscaler | `latent_upsampler/minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` | 0.7 GB, **we already have this one** |
| Timestep table (32 KB, read by range request from the ref2va checkpoint) | `minimax_h3_ref2va_pruned_adaln_t_table_only.safetensors` | 32 KB |

- **Base**: the usual Comfy-Org MiniMax-H3 files (int8 or fp8 FL2VA, Qwen3-VL text encoder, video and audio VAEs).
- **Node pack**: `rdh9616/ComfyUI-Open-H3-Regenerate`, Apache-2.0. Example: `example_workflows/Open-H3 Regenerate 2K - Draft Video.json`.
  - Nodes named in the report:
    - `OpenH3RegenRefineLatent`, with `audio_mode`: `silence (reference)` / `draft audio (AUDIO input)`;
    - a LoRA loader with `lora_name`, `curve_name` and `curve_table`;
    - `OpenH3VideoToPrompt`;
    - `BlockSparseAttention`;
    - the latent upscaler with presets `1080p (1920x1080)` / `2k (2560x1440)`;
    - a fast VAE decode.
- **Licence**: MiniMax H3 Community License for the LoRA and fast VAE, the same as the H3 base you run now.

**Settings tested on an RTX 5090** (int8 base, CUDA 13 + SageAttention 2, 5 s clips, model loaded):

| Preset | Schedule | 1080P | 2K |
|---|---|---|---|
| **Standard** (recommended) | 2 steps, σ 0.7 → 0.494 → 0 | ~70 s | ~145 s |
| Enhanced | 3 steps from σ 0.8 | ~90 s | ~199 s |
| NVIDIA default | 3 steps from σ 0.909 | | **faces changed identity** |

- **VRAM**: 2K int8 used the whole 32 GB card. It ran out of memory on CUDA 12.8 without Sage 2. 1080P is the safe target on 24–32 GB.
- **Sound**: with *draft audio* the original soundtrack goes in and lips stay in sync. With *silence*, lips drifted.
- Not answered by what I could read: 4K needs, drafts from models other than H3, and 4090-class timings.

## How it fits what we already have

`app/h3upscale.py` (`POST /api/h3/upscale`, **Upscale** on an H3 run) is already the same pipeline. It takes
the run's own workflow (prompt, LoRAs, references, seed), encodes the finished clip, uses
`MinimaxH3LatentUpscaler3D` with the same upscaler file, and samples again from part-way, keeping the clip's
own sound. Open-H3-Regenerate adds three things:
1. **the refiner LoRA**, trained for exactly this second pass, so the result is sharper with fewer steps;
2. **a gentler schedule** (2 steps from 0.7). Our `STRENGTHS["strong"] = 0.9035` sits where the report saw
   identity drift;
3. **the fast VAE decoder** for the big frames.

`deck-h3-refine` (**Use as → Refine with H3**, for 3D, splat and scene renders) is the same shape too, so it
gains the same way.

## What to build

1. **A "Regenerate" mode in H3 Upscale** (`app/h3upscale.py`, the Upscale sheet in `web/run.js` ~708):
   - **Quality**: *Upscale (as now)* / *Regenerate (Open-H3)*. Show Regenerate only when
     `object_info` has the pack's nodes and the LoRA file is there; otherwise explain what's missing, the way
     the MoGe check in `main.py` does.
   - **Target** `1080P / 2K` (presets, not a scale factor), and **Strength** *Standard* (2 steps, 0.7 →
     0.494) or *Enhanced* (3 steps from 0.8). Cap the start σ at 0.8 in this mode.
   - `build()`:
     - add the pack's LoRA loader after the run's model chain, and drop the run's **turbo LoRA**, because the
       refiner already has Turbo merged in (check that keeping both doesn't oversharpen);
     - keep the run's character/style LoRAs, but test them: they might fight the refiner;
     - put `OpenH3RegenRefineLatent` (or whatever the example workflow wires) with `audio_mode = draft audio`
       and the clip's sound;
     - use the fast VAE decode.

     Start from the pack's example workflow exported as API JSON. Look up the real node class names and
     inputs with `/object_info`.
   - Tests in `tests/test_h3upscale.py`: the Regenerate graph has the LoRA, no turbo LoRA, the right sigmas,
     and the clip's sound connected; Upscale mode is unchanged.
2. **The same mode in `deck-h3-refine`**: a `@N Regenerate LoRA` group that's off by default, so 3D and splat
   renders can be finished at 1080P/2K in a few steps. Test it on a 3D-tab render with the depth hold on: it
   may not need the hold any more.
3. **Draft, then finish** (the workflow this is for):
   - make takes fast at 768P (or try 512P/576P drafts, which the release supports, for even faster drafts);
   - pick the good ones, then **Finish** one or many: Board select → Finish, and on Story shots
     "Finish takes" for the takes chosen for each shot, queuing Regenerate runs through `make.js`
     `queueRun`.

   The finished clip is a child of the draft in History (lineage already does this), and **Shots to video**
   should prefer a finished take over its draft.
4. **Other models' drafts** (LTX, scene renders): `deck-h3-refine` already encodes any clip into H3's latent,
   so try Regenerate there on an LTX clip. If it holds up, list it under Use as for every clip.
5. **README**: the node pack and its four files go in the custom-node and model tables, with a note that it
   needs 32 GB and Sage 2 / CUDA 13 for 2K (1080P otherwise).

## Questions to settle first
- Does the int8 base you run match the one they tested (FL2VA vs the ref2va used by `deck-h3-ref2v`)? The LoRA
  is trained on the FL2VA base. Test whether it works on ref2v runs.
- What GPU and VRAM is the box? That decides whether 2K is on by default or only 1080P.
- What is the licence of the latent upscaler repo (`LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler`)? It isn't
  stated, but it's already in use here.

## Sources
- NVIDIA project page (not reachable from here): https://nvlabs.github.io/Sana/Open-H3-Regenerate-2K/
- ComfyUI Wiki news: https://comfyui-wiki.com/en/news/2026-10-27-open-h3-regenerate-2k
- Test report with files, nodes and timings: https://github.com/inkseq/h3-studio/issues/795
- MiniMax's API node, for comparison: https://docs.comfy.org/built-in-nodes/MinimaxHailuo03RegenerateNode
- Author's announcement: https://x.com/xieenze_jr/status/2115325378743189594
- "Any update for H3-Regenerate-2K?": https://huggingface.co/MiniMaxAI/MiniMax-H3/discussions/105
