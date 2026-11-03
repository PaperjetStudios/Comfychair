# ComfyChair

A touch-first front end for ComfyUI. ComfyUI runs headless on your Linux box; ComfyChair serves a
tablet-friendly page on your LAN and drives ComfyUI through its API.

```
tablet ──http/ws──▶ ComfyChair :8190 ──http/ws──▶ ComfyUI :8188 (can stay on 127.0.0.1)
```

**What it does:** a template system, live (animated) sampler previews, LoRA stacks, projects and a history with full
lineage, plus editors for images, video and sound, a 3D blocking tab and a storyboard. The top bar groups the tabs into
three spaces: **Make** (Story, Generate, VFX, 3D), **Edit** (Image, Video, Sound) and **View** (Board, History). Tap a
space to go to it and its tools' tabs follow; a sideways swipe along the top bar or Alt + the arrow keys moves between
them. Every slider is a number box with a bar behind it: hold it, then pull sideways to change it (a swipe scrolls past
it), or tap to type. The preview pinch/wheel-zooms, the picker has a camera button, and ⛶ goes full screen.

**Story** is a storyboard of scenes and shots: draw each shot's frame on a canvas, redraw it, make it a video, with the
project's characters (see *Story* below).

**Generate** runs a template: set its pictures, prompt, LoRA stack, size and seed and watch the sampler's preview.
Uploads have a megapixel cap. Reuse a run's settings, or send any output (or a video's first or last frame) back in as
an input. Any image field has **Draw**: a full-screen sketch pad with pen pressure and palm rejection (once a pen
touches it, finger touches are ignored), e.g. to sketch the source for the `-i2i` templates.

**Image** crops images and joins them side by side, stacked or in a grid, then saves the result as an input. It paints
too: the tool strip on the left of its canvas has pressure and tilt brushes (pencil, ink, airbrush, marker), an eraser,
line / rectangle / ellipse, bucket fill, a colour picker and rectangle / lasso selections, on any layer or on a
**Blank canvas**. Layers get blend modes and a lock, and turn and mirror: the round handle above the selected layer
turns it about its centre, pulling to 15 degree steps (Shift steps by 15, Alt turns freely), and the layer panel has a
Rotation slider, quarter turns and mirrors. **Image tools** and **Inpaint and extend** are described below.

**Video** trims generated clips, orders them and exports one video (ffmpeg); the result lands in History.
**⤓ Import clip** (also "From a link or big file…" in every video picker) cuts a piece out of a YouTube/Reddit/X/Vimeo
link, a video file on the PC, or a file on the device, and saves it to the media library (see *Importing clips* under
Setup).

**Sound** is a multi-track sound editor (see *Sound* below).

**VFX** runs one effect per tab (Effect 1, Effect 2…) on a clip or a still, with LTX-2.5 and friends: control maps,
restyles, mattes and keying, replace and remove, text and sound to video, performance transfer (see *VFX templates*
under *Making templates*).

**3D** blocks out a shot with soft mannequins, boxes and a room, keyframes them and the camera, and renders it as a
depth, pose or colour video, e.g. for `deck-h3-ctrl2v` (see below).

**Board** shows every image, video and sound in the project as a pin board, with pins, filters and a tile-size slider
(sounds show their waveform; tap one for a player). **Use as…** (in the Board's gallery, key U, and in History) lists
every place an output fits: the Generate template's fields of its kind (a clip also gives its first or last frame to
image fields and its sound to sound fields), the VFX tab's source, matte, start image, sound or voice, the Video and
Sound timelines, the Image tab, and the 3D tab's reference or a 3D photo. **☑ Select** (or long-press a tile) picks
several: **New edit** opens a new Image tab with the images, **To video** adds them to the timeline, **Delete** removes
their generations (it asks first). In the gallery, **✎ Edit here** puts an image in the open Image tab (Undo brings the
old layers back). **Compare** (select two tiles) shows them full screen as a wipe (drag the line: the split shows as a
percentage) or side by side, two clips playing in step.

**History** lists every run with its prompt, settings and lineage. **Replay & edit** loads a run's settings into
Generate and **Run again** re-queues it unchanged.

**Settings** (⚙) holds, among other things, **Projects**: every project with its size on disk and number of
generations. Drag ⠿ (or ↑/↓) to change the picker's order, ✎ renames, ⧉ duplicates (files, saved tabs and history,
copied in the background) and 🗑 deletes a project with its history and files for good (type its name to confirm).

---

## Setup

```bash
sudo apt install python3-venv ffmpeg      # ffmpeg is used to grab frames from videos
cd ~/comfydeck
./run.sh                                  # first run creates .venv and installs deps
```

Open `http://<linux-box-ip>:8190` on the tablet, then "Add to Home screen" for fullscreen.

ComfyUI no longer needs `--listen`: ComfyChair proxies everything, so ComfyUI can stay on
localhost. Keep `--listen` if you still want the normal ComfyUI UI from other machines.

**Previews:** ComfyChair asks ComfyUI for live previews on every run, so no launch flag is needed.
Images use TAESD when a decoder for the model is in `models/vae_approx` (`taef2_decoder` for
Flux2/MOSS/Klein, `taeh3-comfy` for MiniMax H3), otherwise latent2rgb. Video runs default to
VideoHelperSuite's animated preview (low-res, shows motion); **Advanced → Live preview** switches
to one sharp TAE frame per step. Change the defaults with `DECK_PREVIEW` / `DECK_VIDEO_PREVIEW`.
Krea2 (Wan latent) and Qwen Image 2.1 (RGBA TAE) currently crash ComfyUI's TAESD previewer, so
don't put `lighttaew2_1` or `taeqi2_1_decoder` in `vae_approx`.

**Run on boot (terminal-only mode):** `deploy/` has the systemd units. The "ComfyUI" GRUB entry
boots `comfyui.target`: no desktop, ComfyUI plus ComfyChair. Install or update them with:

```bash
sudo bash deploy/install-services.sh        # backs up the old units, installs, reloads systemd
journalctl -u comfyui -u comfydeck -f        # logs
```

Before starting, ComfyUI waits up to 90 s for the drive(s) its extra model folders are on. It reads
the `base_path`s in `extra_model_paths.yaml` and matches them to `/etc/fstab`, so moving the models
again needs no change here. It retries the mount, then starts anyway, so a missing drive only costs
you the models on it. The models are on NTFS (`/mnt/data`): if Windows ever runs on that disk, turn
off Fast Startup there, or ntfs-3g can refuse to mount it. ComfyChair reconnects to ComfyUI on
its own, so the start order between them doesn't matter.

**HTTPS (optional, recommended):** over HTTPS the tablet can use the real screen wake-lock, show
"done" notifications, and install ComfyChair as an app (with an offline page when the box is off).
Over plain http ComfyChair keeps the screen on during runs with a tiny silent video instead, and
signals a finished run with a chime and a ✓ in the tab title.

**Settings → Network** lists the addresses ComfyChair answers on (LAN, Tailscale, `<host>.local`), each with a QR
code to scan from the tablet, the Tailscale state, whether the certificate covers the current address, and a
button to download the CA certificate for a new tablet. The LAN address changes with the Wi-Fi network; a
Tailscale address does not.

**Uploaded .mov files** that the browser can't play (HEVC, ProRes, PCM sound) get a playable H.264 copy in
`tmp/playable/` beside the original; processing always uses the original, and the copy goes with the file.

**Drag and drop (desktop)**: drag pictures, videos or sound from a file window onto the Video tab. On a timeline lane the
clip lands where you drop it (a line shows where; it snaps to the frame, the playhead and clip edges); anywhere else on the
tab it goes after the last clip. Several files go one after another. Files are uploaded to the media library like **+ Sound / files**.

Free, on your own network, all from the text console: the box makes its own certificate and the tablet
trusts it once you install one small file on it. One command does it all, and it stays on across reboots
(the services start on HTTPS and renew the certificate themselves, also when the box's IP changes):

```bash
deploy/local-https.sh        # certificate, ComfyChair (and the Lab) on HTTPS, then it serves the tablet the
                             # file at http://<box-ip>:8000/comfydeck-ca.crt and prints the Android steps
deploy/local-https.sh ca     # the file again, for another tablet
deploy/local-https.sh off    # back to plain http
```

Then open `https://<box-ip>:8190` on the tablet and ⋮ → Install app. Give the box a fixed IP in your router
(a DHCP reservation, free on any router): the installed app is tied to its address.

(`deploy/tailscale-https.sh` does the same through Tailscale, for reaching the box away from home.)

**ComfyChair Lab**, the experimental copy (branch `lab`: things with a little physics; the three spaces and their
travel are in the main app now), runs beside this one as its own app, with its own data. It boots the same
way: `comfyui.target` starts it with ComfyUI and ComfyChair (a drop-in, `comfyui.target.d/lab.conf`, so
`install-services.sh` keeps it), and it uses ComfyChair's HTTPS certificate. Once, and again to update it:

```bash
deploy/lab.sh            # check out the lab branch beside this one (<this>-lab), start comfydeck-lab on :8191
                         # → https://<box-ip>:8191 (install it on the tablet from there)
deploy/lab.sh off        # stop it and take it out of the boot
journalctl -u comfydeck-lab -f
```

**Any second copy as its own app** (e.g. another branch next to the one you use): check it out
next to this one and run it on another port with another name. Each address installs as its own
home-screen app, named by `DECK_NAME`:

```bash
git worktree add ../comfychair-exp <branch>
cd ../comfychair-exp && DECK_PORT=8192 DECK_NAME="ComfyChair Exp" ./run.sh
```

Both copies share `data/` only if you point them at the same one (`DECK_DATA`); by default each has its own.

**Access token (optional):** with `DECK_TOKEN=<something long>` set (e.g. `Environment=DECK_TOKEN=…`
in the service), every page, file and API call needs it. Open `http://<box>:8190/?token=<it>` once on
each device and a cookie remembers it for a year. Without it there's no login, so only run it on a
network you trust.

**Importing clips:** the importer shows the video, you set in/out (and optionally a crop and a size
limit), and only that piece is saved, as h264 + aac in `data/media`.
- The editor has a zoomed bar (2 s, 10 s or 60 s around the handle you last moved; handles snap to frames),
  **▶ Selection** (plays in to out, looping), and keys once you tap the player: ← → a frame (Shift: a second),
  I / O set in / out, P plays the selection, Space plays.
- Temporary files (`data/tmp/clips`) clear themselves: a link's preview after 3 h unused, a PC preview copy after
  3 days, leftovers after 1 h, and the least recently used first once the folder passes 4 GB.
- *Link*: anything [yt-dlp](https://github.com/yt-dlp/yt-dlp) reads. `./run.sh` installs it into the venv;
  keep it current (`.venv/bin/pip install -U yt-dlp`), because sites change often. The preview is a small
  stream relayed through ComfyChair while a small whole-video copy downloads (a few seconds for a 10-minute
  video); once it's in, the player switches to it and seeking is instant. The cut seeks into the full-quality stream, so only the chosen part is
  downloaded. Sites that only stream in pieces (HLS) get a small preview copy first (videos up to 20 min).
- *This PC*: browses your home folder and mounted drives. Set `DECK_CLIP_ROOTS` (paths joined with `:`)
  to choose other folders. Files the browser can't play (ProRes, some MKV/HEVC) get a small preview copy.
- *This device*: the browser cuts the piece with ffmpeg.wasm (a 31 MB core the server fetches from
  jsDelivr the first time, kept in `data/vendor`). It reads only the needed part of the file and sends
  only that piece, so a multi-GB file is fine.

**Several devices:** every device sees the queue, but only the device that started a run gets its
live preview and result in the viewer; the others say "busy with another device's run". Stop only
stops your own run (it asks first once a run has gone 30 s); stop other runs from the Queue. A
tablet that slept, reloaded or lost Wi-Fi picks a running job's progress back up and shows any
result it missed.

---

## What ComfyUI needs

The repo holds no model weights (`.gitignore` keeps them out). These are the custom nodes and model
files the bundled templates and the app expect, by the filename the templates load. Folders are under
`ComfyUI/models/` (or any `base_path` in `extra_model_paths.yaml`). A template whose files are missing
still lists; it fails when run. You only need the files of the templates you use.

### Custom node packs

| Pack | Used by |
|---|---|
| [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | video load/save in most video templates, animated previews |
| [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | `ImageResizeKJv2`, LTX guide nodes |
| [ComfyUI-LTXVideo](https://github.com/Lightricks/ComfyUI-LTXVideo) | `deck-ltx-*` IC-LoRA, tiling, inpaint, tracks, audio-only |
| [ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) | `deck-klein9b-*` (GGUF text encoder) |
| [comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux) | DWPose in `deck-pose-video`, `deck-h3-drive`, `deck-h3-faceswap`, `deck-ltx-drive` |
| [ComfyUI-UtilsCollection](https://github.com/silveroxides/ComfyUI-UtilsCollection) | `UC_StitchImageGrid` |
| [ComfyUI-Viggle-Animate-H3](https://github.com/Saganaki22/ComfyUI-Viggle-Animate-H3) | `deck-h3-animate`, `deck-h3-faceswap` |
| [ComfyUI-SAM3](https://github.com/PozzettiAndrea/ComfyUI-SAM3) | `deck-sam3-video-mask` |
| [ComfyUI-Video-Depth-Anything](https://github.com/yuvraj108c/ComfyUI-Video-Depth-Anything) | `deck-depth-image`, `deck-depth-video` (patched, see below) |
| [ComfyUI-HY-Motion1](https://github.com/jtydhr88/ComfyUI-HY-Motion1) | `deck-motion-text` |
| [ComfyUI_ProPainter_Nodes](https://github.com/daniabib/ComfyUI_ProPainter_Nodes) | VFX logo removal, Quality (patched, see below) |
| [ComfyUI-UniRig](https://github.com/PozzettiAndrea/ComfyUI-UniRig) | auto-rig: `deck-autorig-human` (Make It Animatable) and `-any` (UniRig); its own pixi env with a bundled Blender (`install.py`), and it downloads the checkpoints on first use |
| [Comfyui_Minimax_h3_latent_Upscaler](https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler) | H3 upscale (`POST /api/h3/upscale`) |
| [Veda-on-ComfyUI](https://github.com/veda-sparse/Veda-on-ComfyUI) | optional Veda sparse attention for H3 (Advanced) |
| [comfyui-krea2edit](https://github.com/lbouaraba/comfyui-krea2edit) (2.0+) | `deck-krea2-edit`, `deck-krea2-identity` |
| [ComfyUI-MMAudio](https://github.com/kijai/ComfyUI-MMAudio) | `deck-mmaudio-foley` (with `comfy_nodes/deck_mmaudio`) |
| [ComfyUI-Idol](https://github.com/Nynxz/ComfyUI-Idol) | `deck-3d-object-splat` |
| `comfy_nodes/deck_*` (this repo) | face crop, face restore, pose smoothing, motion save, TAPNext++, rig save, MMAudio sampler: symlink each into `custom_nodes` |

Three packs carry local fixes, each marked `(ComfyChair patch)`; an update or reinstall drops them, so grep for the
marker afterwards and re-apply:
- **comfy_env** (in ComfyUI's venv, used by ComfyUI-SAM3), `isolation/workers/{_persistent_worker.py,_ipc_shared.py,_ipc_parent.py}`:
  sends empty arrays and tensors over the IPC. Without it SAM3 fails with "cannot mmap an empty file".
- **ComfyUI-Video-Depth-Anything**: `video_depth_anything/dinov2_layers/attention.py` uses `F.scaled_dot_product_attention`,
  and `node.py` `process()` calls `mm.unload_all_models()` first. Large at 518 px still runs out of memory on 12 GB,
  so the templates use 448 for Large.
- **ComfyUI_ProPainter_Nodes**: `propainter_nodes.py` `ProPainterInpaint` unloads ComfyUI's models before it runs.

MiniMax H3, MOSS (and its edit node, ComfyUI after v0.42.4), Flux2/Klein, Qwen Image 2.1, SeedVR2, SAM 3D Body, SDPose, RT-DETR, MoGe and ACE-Step
nodes are ComfyUI core: keep ComfyUI current.

### Models

**LTX-2.5** (all `deck-ltx-*`)

| Folder | File | Size |
|---|---|---|
| `diffusion_models` | `ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors` | 21 GB |
| `text_encoders` | `gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors` | 15 GB |
| `vae` | `ltx-2.5-video-vae-bf16.safetensors` | 1.4 GB |
| `vae` | `ltx-2.5-video-vae-conv-bf16.safetensors` (`deck-ltx-ripple` only) | 1.4 GB |
| `vae` | `ltx-2.5-audio-vae-bf16.safetensors` | 348 MB |

IC-LoRAs, each for one template:

| Folder | File | Template |
|---|---|---|
| `loras/ltx2.3` | `ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors` | `deck-ltx-ctrl2v`, `deck-ltx-drive*` |
| `loras/ltx2.5` | `ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors` | `deck-ltx-inpaint` |
| `loras/ltx2.5` | `ltx-2.3-22b-ic-lora-motion-track-control-ref0.5.safetensors` | `deck-ltx-tracks` |
| `loras/ltx2.5` | `ltx-2.5-22b-ic-lora-alpha-gen-0.9.safetensors` | `deck-ltx-alpha` |
| `loras/ltx2.5` | `ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors` | `deck-ltx-cleanplate` |
| `loras/ltx2.5` | `ltx-2.5-22b-ic-lora-colorization-0.9.safetensors` | `deck-ltx-v2v-lora` |
| `loras/ltx2.5` | `ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors` | `deck-ltx-ingredients` |
| `loras/ltx2.5` | `ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors` | `deck-ltx-layout` |
| `loras/ltx2.5` | `ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors` | `deck-ltx-upscale` |
| `loras/ltx2.5` | `LTX25_Ripple_v11.safetensors` | `deck-ltx-ripple` |

**MiniMax H3** (`deck-h3-*` except animate/faceswap)

| Folder | File | Size |
|---|---|---|
| `diffusion_models` | `Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors` | 20 GB |
| `text_encoders` | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | 15 GB |
| `vae` | `minimax_h3_video_vae_int8_convrot.safetensors` | 3.0 GB |
| `vae` | `minimax_h3_audio_vae_fp32.safetensors` | 578 MB |
| `loras/h3` | `minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors` (ref2v, sheets, ctrl2v, drive) | 1.9 GB |
| `loras/h3` | `minimax_h3_turbo_v4_step600_pruned_comfyui.safetensors` (`deck-h3-i2v`, `deck-h3-flf2v`) | 592 MB |
| `controlnet` | `minimax_h3_fun_controlnet_union_pruned_int8_convrot.safetensors` (`deck-h3-ctrl2v`, `deck-h3-drive*`) | 2.2 GB |
| `latent_upscale_models` | `minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors` (H3 upscale) | 659 MB |
| `loras` | `minimax_h3_open_regenerate_2k_refiner_rank_384_bf16.safetensors` (Regenerate; refiner only, keeps the turbo LoRA) | 5.6 GB |
| `veda` | `minimax_h3_r2va_veda_preview_fp8.safetensors`, `minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors` (optional) | 263 MB each |
| `vae_approx` | `taeh3-comfy` (optional, sharper previews) | |

**Viggle Animate H3** (`deck-h3-animate`, `deck-h3-faceswap`): the H3 video VAE above, plus

| Folder | File | Size |
|---|---|---|
| `diffusion_models` | `minimax_h3_ref2va_viggle_pruned_int8_convrot.safetensors` | 20 GB |
| `loras` | `viggle_animate_dmd_lora_r64.safetensors` | 899 MB |
| `text_cond` | `fixed_embed_fwd_anyframe.safetensors` | 3.6 MB |

**Images**

| Template | Folder | File | Size |
|---|---|---|---|
| `deck-qwen21-*` | `diffusion_models` | `qwen_image_2.1_turbo_int8_convrot.safetensors` | 6.8 GB |
| | `text_encoders` | `qwen3vl_8b_int8_convrot.safetensors` | 8.8 GB |
| | `vae` | `qwen_image_2.1_vae_bf16.safetensors` | 645 MB |
| `deck-krea2-*` | `diffusion_models` | `krea2_turbo_fp8_scaled.safetensors` | 13 GB |
| | `text_encoders` | `qwen3vl_4b_fp8_scaled.safetensors` | 4.9 GB |
| | `vae` | `qwen_image_vae.safetensors` | 243 MB |
| `deck-krea2-edit` | `loras/krea` | `krea2_general_edit_v2.safetensors` ([conradlocke/krea2-identity-edit](https://huggingface.co/conradlocke/krea2-identity-edit)) | 1.8 GB |
| `deck-krea2-identity` | `loras/krea` | `krea2_identity_edit_v2.safetensors` (same repo) | 1.8 GB |
| `deck-moss-*` | `diffusion_models` | `moss_image_sft_int8_convrot.safetensors` | 5.1 GB |
| | `text_encoders` | `qwen3.5_9b_w4a8_gptq.safetensors` | 6.9 GB |
| | `vae` | `flux2-vae_small.safetensors` | 238 MB |
| `deck-moss-edit` | `loras/moss` | `moss_image_edit_lora_bf16.safetensors` ([PedroMarinhoDev/Moss-Image-Edit-ComfyUI](https://huggingface.co/PedroMarinhoDev/Moss-Image-Edit-ComfyUI)) | 297 MB |
| `deck-klein3-*` | `diffusion_models` | `flux3-image-klein-int8-convrot.safetensors` | 5.5 GB |
| | `text_encoders` | `qwen3vl_4b_int8_convrot.safetensors` | 4.6 GB |
| | `vae` | `flux2-vae.safetensors` | 321 MB |
| `deck-klein9b-*` | `diffusion_models` | `flux-2-klein-9b-fp8.safetensors` | 8.8 GB |
| | `text_encoders` | `Qwen3-8B-Q8_0.gguf` | 8.2 GB |
| | `vae` | `flux2-vae.safetensors` | 321 MB |
| previews | `vae_approx` | `taef2_decoder` (optional, Flux2/MOSS/Klein) | |

**Upscale**

| Template | Folder | File | Size |
|---|---|---|---|
| `deck-upscale-image`, `deck-upscale-video` | `diffusion_models` | `seedvr2_7b_sharp_int8_convrot.safetensors` | 7.8 GB |
| `deck-upscale-video-fast` | `diffusion_models` | `seedvr2_3b_int8_convrot.safetensors` | 3.3 GB |
| all three | `vae` | `seedvr2_ema_vae_fp16.safetensors` | 479 MB |
| `deck-upscale-image-fast` | `upscale_models` | `4x-UltraSharp.pth` | 64 MB |

**Pose, depth, masks, 3D**

| Used by | Folder | File | Size |
|---|---|---|---|
| DWPose (`deck-pose-video`, `deck-h3-drive`, `deck-h3-faceswap`, `deck-ltx-drive`) | `custom_nodes/comfyui_controlnet_aux/ckpts/yzd-v/DWPose` | `yolox_l.onnx`, `dw-ll_ucoco_384.onnx` (the pack downloads them) | 207 + 129 MB |
| SDPose (`deck-pose-sdpose`, `deck-*-drive-sd`) | `checkpoints` | `sdpose_wholebody_fp16.safetensors` | 1.8 GB |
| SDPose, `deck-mocap` person detector | `diffusion_models` | `rt_detr_v4-x-hgnet_fp16.safetensors` | 119 MB |
| `deck-mocap` | `detection` | `sam_3d_body_dinov3_bf16.safetensors` | 2.7 GB |
| `deck-depth-*` | `videodepthanything` | `video_depth_anything_vitl.pth` | 1.5 GB |
| `deck-sam3-video-mask` | `sam3` | `sam3.safetensors` | |
| `deck-motion-text` | `HY-Motion` | `HY-Motion-1.0-Lite` and `ckpts/Qwen3-8B` (the pack's layout) | |
| 3D tab, Photo in 3D | `geometry_estimation` | `moge_3_vitl_fp16.safetensors` (from `Comfy-Org/MoGe`) | |
| `deck-3d-object` | `diffusion_models` | `pixal3d_int8_convrot.safetensors` | 5.2 GB |
| `deck-3d-object-trellis` | `diffusion_models` | `trellis_2_int8_convrot.safetensors` | 4.9 GB |
| both 3D object templates | `vae` | `trellis_2_shape_vae_bf16.safetensors` | 1.0 GB |
| both (textures) | `vae` | `trellis_2_texture_vae_bf16.safetensors` | 904 MB |
| both | `clip_vision` | `dino_v3_L_naf_fp32.safetensors` | 1.13 GB |
| `deck-3d-object` (its FOV) | `geometry_estimation` | `moge_2_vitl_normal_fp16.safetensors` | 631 MB |
| both (cut out) | `background_removal` | `birefnet.safetensors` | 424 MB |
| `deck-3d-object-splat` (Idol) | `diffusion_models` | `idol_fp16.safetensors` | 741 MB |
| `deck-3d-object-splat` | `vae` | `idol_decoder_fp16.safetensors`, `flux2-vae.safetensors` | 576 MB |
| `deck-3d-object-splat` | `clip_vision` | `dino_v3_vit_h.safetensors` | 1.68 GB |
| `deck-autorig-human` | `mia` (the pack downloads) | `pose.pth`, `bw.pth`, `bw_normal.pth`, `joints.pth`, `joints_coarse.pth` | ~2.2 GB |
| `deck-autorig-any` | `unirig` (the pack downloads) | its checkpoint | |
| VFX tracking (TAPNext++) | `tapnet` | `tapnextpp_ckpt.pt` | 2.4 GB |
| VFX logo removal | `propainter` (or the pack's `weights/`) | `ProPainter.pth`, `raft-things.pth`, `recurrent_flow_completion.pth` | |

**Sound**

| Template | Folder | File | Size |
|---|---|---|---|
| `deck-ace-music` | `checkpoints` | `ace_step_1.5_turbo_aio.safetensors` | 9.4 GB |
| `deck-mmaudio-foley` | `mmaudio` | `mmaudio_large_44k_v2_fp16.safetensors` | 2.06 GB |
| `deck-mmaudio-foley` | `mmaudio` | `mmaudio_vae_44k_fp16.safetensors`, `mmaudio_synchformer_fp16.safetensors` | 611 + 475 MB |
| `deck-mmaudio-foley` | `mmaudio` | `apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors` | 1.97 GB |

`deck-ltx-t2a` and `deck-ltx-a2v` use the LTX files above. The voice tools keep their own models outside
ComfyUI (see *Voice tools*).

---

## Making templates

1. Build the workflow in desktop ComfyUI and check that it runs.
2. Rename (double-click the title) each node you want on the tablet so it starts with `@`.
3. **Workflow → Export (API)** and save the JSON into `templates/`. The filename becomes the
   template name (`wan_i2v_480p.json` → "wan i2v 480p").
4. Tap ↻ on the tablet. No restart needed.

| Node title | What the tablet shows |
|---|---|
| `@Prompt` | every widget on that node (types, ranges and dropdowns come from ComfyUI) |
| `@Sampler [seed,steps,cfg]` | only the listed inputs |
| `@1 Prompt` | a leading number orders the group among groups of the same kind (see below) |
| `@LoRAs` on a **LoraLoader** or **LoraLoaderModelOnly** | a LoRA stack: add/remove/disable, strength sliders. At run time the node is chained N times, or bypassed if the stack is empty |
| `@Start frame` on a **LoadImage** | image picker: a gallery of input images and generated outputs, plus upload (with megapixel cap). Left empty, the node is removed and whatever it fed is unplugged, so it works for optional inputs (reference images, first/last frames). Where several slots share a title (H3's References) the picker takes several: they fill this slot, then the empty ones |
| the same `@References` title on several nodes | one group; the fields are numbered (Image 1, Image 2…) |

A **Primitive** node (`PrimitiveInt`, `PrimitiveFloat`…) shows as one number labelled with its title, e.g.
`@3 Length (seconds)` feeding a math node that converts seconds to frames (see `templates/deck-h3-i2v.json`).

**VFX templates** (the **VFX** tab). Each effect runs one template by id (`deck-ltx-ripple`,
`deck-ltx-v2v-lora`, `deck-ltx-alpha`, `deck-sam3-video-mask`, `deck-ltx-cleanplate`, `deck-ltx-t2v`,
`deck-ltx-layout`, `deck-ltx-tracks`, `deck-ltx-ingredients`, `deck-ltx-upscale`; Quick: `deck-depth-video`,
`deck-canny-video`, `deck-scribble-video`; Replace and Extend frame: `deck-ltx-inpaint`; Sound to video and Talking
shot: `deck-ltx-a2v`; Cut out (Alpha Gen) on a masked area: `deck-ltx-alpha-crop`; Drive a still, reading the pose
with SDPose: `deck-h3-drive-sd`, `deck-ltx-drive-sd`; see `EFFECTS` in `web/vfx.js`). An effect whose template is missing shows a note instead of Run. The tab fills these
tagged fields, found by kind and group name (`ROLES` in `web/vfx.js`):

| Node title | Filled with |
|---|---|
| `@Source video` on **VHS_LoadVideoPath** | the source clip, with its trim and crop |
| `@Mask video` / `@Matte video` on **VHS_LoadVideoPath** | the mask or matte clip (white = keep / remove) |
| `@First frame` (any title) on **LoadImage** | the edited first frame, start image or ingredients sheet |
| `@Prompt` | the prompt (a title with "negative" is left alone) |
| `@Length (seconds)` | the length in seconds; the graph turns it into 8n+1 frames at 24 fps |
| `@Width`, `@Height` (Primitive or `[width,height]`) | the size, for effects that have one |
| `@Seed` | the seed (−1 = random) |
| `@LoRAs` | one LoRA and its strength (LoRA restyle) |
| `@Points [points_store]` on **SAM3PointCollector** | `{"positive":[{x,y}],"negative":[…]}` in pixels of the clip |
| `@Tracks [points_store]` on **LTXVSparseTrackEditor** | `[[{x,y},…],…]`: one list of control points per path, in pixels of the generated size |

The **Performance** effects use more tagged fields: `@Character` (any title) on **LoadImage** for the
character still, `@Steps [sigmas]` on **ManualSigmas** (Viggle's distilled schedules; Fast/Balanced/Quality
send 4, 6 or 8 points) and `@Blend [shape,grow,feather,chin]` on **Deck Face Uncrop** (`face` or `oval`;
the VFX tab's Face size, Edge softness and Chin sliders).

| Effect | Template | What it runs |
|---|---|---|
| Replace character | `deck-h3-animate` | Viggle-Animate (an H3 ref2va finetune): the clip's performer re-rendered as the still's character, in 124-frame windows |
| Face only | `deck-h3-faceswap` | the same model on a square that follows the face, pasted back with Deck Face Uncrop |
| Drive a still | `deck-h3-drive` | `deck-h3-ctrl2v`'s graph with the clip's DWPose (body, hands, face) as the control video |
| Drive a still (LTX) | `deck-ltx-drive` | LTX-2.5 with the still as the first frame and DWPose through the union-control IC-LoRA |
| Pose preview | `deck-pose-video` | DWPose, steadied (CPU): what the drive effects follow |
| Talking shot | `deck-ltx-a2v` | a picture of someone and a line: the line spoken by the Sound tab's engines (or a sound picked), then sound to video with the line in the prompt |

**Talking shot** (`web/talk.js`): pick a project character (their main picture becomes the start image, their voice
speaks, their look goes in the prompt) or a picture and a voice, write the line, choose the engine and how it is said,
and **Speak the line** (`POST /api/voice/speak`, one line, evened to −16 LUFS). Or pick any sound of someone speaking.
With the prompt left empty it is made from the line (`talkPrompt`: who, their look, the line in quotes, then "their
lips move in time with every word…"). The clip is the line's length plus a quarter to half a second, at the picture's
shape scaled to about 1280×704. Tested 2026-10-28 on an 8.5 s line: a 1280×704 close-up took about 2 minutes warm,
a medium shot 2.5 minutes; lips close on b/m/p and between phrases, and the face keeps the picture's identity. The
closer and more frontal the face, the crisper the mouth. In Story, **Talking shot** (next to Speak the lines) speaks the
shot's lines if needed and runs `deck-ltx-a2v` on its frame whatever the shot's video template; the clip lands on the shot.

The drives don't read the pose again when the clip already has one: before queueing, the VFX tab asks
`POST /api/pose/find` for a finished Pose preview of the same clip (generation output or media file), trim
start (within a frame), crop and poser (`deck-pose-video` for DWPose, `deck-pose-sdpose` for SDPose) with
enough frames (`app/posefind.py`). With one, it runs `deck-h3-drive-posed` / `deck-ltx-drive-posed`, which
take it as `@14 Pose video` (cut and stretched as the extracted pose would be) and keep the clip for size,
frames and sound; the drive's params record the pose generation. Without one, it queues the Pose preview
first, waits, then runs the posed drive, so the next drive on that clip reuses it. Anything failing falls
back to the reading template. Under the source, "Pose ready · #id" opens the pose video; Make again reads
it afresh on the next Run.

They come from `dev/make_perf_templates.py`. Viggle needs `minimax_h3_ref2va_viggle_pruned_int8_convrot`,
`viggle_animate_dmd_lora_r64` and the `fixed_embed_fwd_anyframe` text conditioning (ComfyUI-Viggle-Animate-H3).

**Face crop** (`comfy_nodes/deck_facecrop`): Deck Face Crop follows a face through a clip from a face mask
(DWPose face points are enough). Frames without a face take their neighbours' box, the square keeps one
size, and edges are padded. Deck Face Uncrop pastes processed crops back through a soft outline of each
frame's face points plus the forehead; Chin below 1 lifts its lower edge off the neck and collar. Link it like the TAPNext++ node below
(`ln -s ~/Programs/comfydeck/comfy_nodes/deck_facecrop ~/Programs/ComfyUI/custom_nodes/deck_facecrop`) and
restart ComfyUI.

**Pose smoothing** (`comfy_nodes/deck_posesmooth`): DWPose looks at each frame on its own, so its points
shake. Deck Pose Smooth takes its keypoints for the whole clip, follows each person from frame to frame,
fills gaps of up to Max gap frames, pulls back points that jump, and averages each point with its neighbours
in time (Smoothing, in frames; hands and face get half). It has no lag and needs no model. The drive and pose
templates use it (`@12 Pose smoothing`). Link it like the others
(`ln -s ~/Programs/comfydeck/comfy_nodes/deck_posesmooth ~/Programs/ComfyUI/custom_nodes/deck_posesmooth`) and
restart ComfyUI.

**Clean up matte** (VFX → Matte, `POST /api/video/matte`) cleans up a matte or mask, or combines two (the SAM3 mask
and the **Cut out (Alpha Gen)** matte, say): Either, Both, First minus second or Average, then grow / shrink, fill holes, steady over
frames, edge levels, feather and invert. It runs with ffmpeg on the server (`videoedit.matte_filters`) and lands in
History as a new matte for Apply matte or Clean plate.

**Keying** needs no template: the Video tab's **Colour key…** button on a clip, and the VFX tab's **Colour key**
and **Apply matte** effects, call `POST /api/video/key`. It writes a VP9 webm with alpha into History.
The Video preview and its export put a keyed clip over the tracks below it.

**TAPNext++ tracking** (`comfy_nodes/deck_tapnext`). This is a ComfyUI node that follows points with
DeepMind's TAPNext++. The model code is vendored from google-deepmind/tapnet (Apache 2.0), so nothing is
pip-installed. It needs torch, torchvision and einops, which ComfyUI already has.

To install:
1. Link the node into ComfyUI:
   `ln -s ~/Programs/comfydeck/comfy_nodes/deck_tapnext ~/Programs/ComfyUI/custom_nodes/deck_tapnext`
2. Put `tapnextpp_ckpt.pt` in a `tapnet` folder beside any ComfyUI model folder. Bases from
   `extra_model_paths.yaml` count too, for example `/mnt/data/ComfyUI/models/tapnet/`.
3. Restart ComfyUI.

The Track motion sheet then offers **Tracker: TAPNext++**. ComfyChair cuts the clip to about 640 px wide
and queues it on ComfyUI, so it waits behind any running generation. A 20×20 grid of points (inside the
track box, outside the ignore box) is followed through every frame. The camera is fitted to those tracks
the same way as with Simple tracking.

**Stabilise** (in the Track motion sheet, after a track): Smooth keeps the hand-held feel and removes the shake
(its own Smoothing, in frames), Lock cancels all the motion like a tripod. Correct roll can be turned off; Auto zoom
crops just enough to hide the empty borders (capped at 1.3×, so a clip that drifts further still shows some).
The result lands in History as a `stabilise` item with the clip's sound for that span.

**Solve 3D camera**: the plain track gives a camera that only turns and zooms. Two solves give a camera that
also moves, so objects placed in the 3D tab hold their place on a dolly or walking shot. **PnP + MoGe** lifts the
tracked points to metres with MoGe's depth of the first frame and fits every frame's camera to them
(metric, so a 1.8 m figure is the right size; drifts on long shots since the depth comes from one frame).
**Depth Anything 3** runs DA3 in multi-view mode on 8–64 sampled frames (`depth_anything_3_small` or `_base`
in `geometry_estimation/`) and interpolates the cameras between them (consistent, relative scale: the Scale
slider sets it, by default so the camera starts 1.5 m above the found floor). Both find the floor plane so the
3D room's floor matches the footage. They need `comfy_nodes/deck_solve` linked into ComfyUI's `custom_nodes`.
Choose the method under Solve 3D camera, Solve, then Create 3D scene.
To track only part of a clip, set a **Range** on the Video tab's ruler (I / O, or the Range button) and use **Range → Track motion on the range**, or the clip's own **Track motion** button: the sheet opens with Start and End on the part of the clip inside the range.

**Character sheets** (`deck-h3-charsheet`): give it a picture of a character as Reference 1 and it
makes a 12 s portrait clip: a 6 s orbit on a grey studio backdrop, then cuts at 6, 7.5, 9 and 10.5 s to
close-ups (face front, three-quarter, profile, waist up). It saves the clip plus a sheet: frames
`4,54,96,120` (front, side, back, other side: H3 eases into the orbit, so these aren't evenly spaced) and
one from each close-up (`162,198,234,270`), 4 per row.
Pick the sheet as a reference in `deck-h3-ref2v` for the next video. With a fixed seed the same
character gives the same sheet; if the orbit runs fast or slow, change **Sheet frames** (frame = seconds × 24).
The length is fixed, so changing the shot timestamps in the prompt also means changing the frames.
For detail on the body, `deck-h3-charsheet-body` (13 s, 8 pictures, 4 per row): the same orbit of the full figure, then close shots of the chest, back, legs and feet.

Shorter sheets for a model of the upper body, same inputs and settings: `deck-h3-charsheet-bust` (8 s, 6 pictures, 3 per row: front, side, back, other side, then close-ups of the face front and three-quarter) and `deck-h3-charsheet-bust4` (5.5 s, 4 pictures: front, side, back, face front). The camera frames head to mid-waist the whole way. They come from `dev/make_bust_sheet_templates.py`; frames are untested on a GPU, so change **Sheet frames** if the orbit lands off.
`deck-h3-objectsheet` is the same for props and other objects: the close-ups are front, three-quarter,
the top (high angle) and a small detail.

**Blocking a shot** (`deck-h3-ctrl2v` + the **3D** tab): ref2v plus H3's Fun ControlNet, driven by a
control video. The 3D tab works like the Image tab: **+ Add** people (soft, featureless mannequins), boxes,
balls, cylinders, walls or a room; the layer list holds the Camera, the Room and the objects (◉ hides
one), and under it are the selected layer's settings. Everything but the camera can be deleted (with
Undo). Tap an object to select it and get a gizmo; tap it again (or W / E / R, or the toolbar) to switch
between Move, Rotate and Scale. Tap empty space to go back to the camera: the view is the camera, so
drag to orbit, two fingers to pan and zoom. **◆ Key** keyframes the selected object (or the camera) at
the playhead; once something has keys, changing it writes a key where the playhead is. The key sheet
under the view has a row per layer: drag a key along its row to retime it, tap a row to scrub (←/→ step
a frame, Shift+←/→ to the start / end, ↑/↓ jump between keys). With **Auto key** off (K), a change to something animated is only
held until ◆ Key or the playhead moves, so you can look around without touching the keys. ↶ / ↷ (Ctrl+Z,
Ctrl+Shift+Z) undo and redo (in the top bar).

**Shots.** More than one camera, and the clip cuts between them. The **Shots** row on the key sheet is a block per
cut, coloured by camera: **Cut here** (or ◆ while that row is selected) cuts to the camera you are editing at the
playhead. While the clip plays, the view follows the shot list (**Cut** on the toolbar; **Cam** stays on the camera
you are editing, which is also what a drag orbits). A render follows the cuts either way. **One take** is one video;
**Each shot** is one video per shot, labelled Shot N. **Prompt from the shots** writes a line per cut in the same
words as the Story tab (wide, close, low angle, the camera pushes in). Tap a chip to leave that shot out, hold it to
edit the line. **To Story** adds one Story shot per cut, with a clay frame.

**Objects from a photo.** **Use as → Make a 3D object** (or **+ Add → Object from photos…**) turns a picture into a
textured model with Pixal3D. The sheet is a board of four slots (Front, Left, Back, Right): tap a slot to pick a photo for it
(the picker can crop it first), or **Split one picture…** to draw a box round each view of a character sheet. One filled slot
makes the model from that photo alone (**Make its other views first** renders an orbit sheet and takes the four sides);
two or more are used together for a rounder model. The mesh comes in as a model layer, fitted and standing on the floor in the middle of the
scene. Its fields are **Cut out** (BiRefNet, on), **Detail** (sampling steps), **Texture** (off leaves the plain shape),
**Seed** and **Texture resolution**. When `deck-3d-object-trellis` is installed, **Model (one photo)** switches between
Pixal3D and TRELLIS.2, to compare. Two or more views run `deck-3d-object-multi`, which always uses Pixal3D.
With one photo, **Make a splat (Idol)** (`deck-3d-object-splat`) makes a Gaussian splat of the object instead, with the
sides the photo doesn't show; turn on **The picture is a photograph** for a camera photo, off for a render. It
lands as a splat layer. **Photo as a splat (SHARP)…** (in + Add, `POST /api/scene/splat`) turns a picture into a splat
placed where the shot camera is, seen through the photo's lens.

**Real size**: the scene is in metres. Each object's settings show its **Real size** (height × width × depth).
The person button on the view's bar puts a 1.8 m outline person beside what is selected, and the floor has
faint metre marks; neither ever shows in a render. **Measure…** on an object: tap two points on it, then say
what that distance really is (Person, Door, Table, Car or a number) and it is rescaled about its base (undo
works; with keys, it keys the scale at the playhead). A photo's mesh or splat also has **Calibrate from a
person**: the person in the source photo is found (on the CPU, only while ComfyUI's queue is empty) and the
whole layer is scaled so they are 1.7 m, or the height you pick. Imported glTF comes in at its true size and
FBX by its unit; OBJ, splats and absurd sizes ask "About how tall is it?".
**Posable person**: a low-poly man or woman with joints (+ Add has both; **Place** switches one). The
parts are smooth volumes on the joints, built in code (no mesh files), shaped to read in a depth render:
chest, pelvis, shoulders, a face with nose, brows, eyes, ears and a jaw. Tap it to show its joint dots, tap
a dot to pose that joint (Rotate), or drag a hand or foot (Move) and the arm or leg follows (IK). Its settings are in tabs:
**Poses** (about 60 with pictures: standing, bending, moving, sitting and kneeling, on the floor, fitness;
**Pairs** pose it with the nearest other figure: hug, kiss, holding hands, carry, lying together…;
**Mine** keeps your own, per project or for all; apply to the whole, upper or lower body), **Adjust**
(parameters on top of the pose, on/off: lean, head turn, legs apart, bend knees…; walk and run cycles
whose steps follow how far the figure moves; squat/sit/kneel as 0–100%), **Hands** (relaxed, open, fist,
grip, point, pinch for one hand or both, each hand's curl toward a fist, and **Hand mode**: the view closes
in on a hand and dragging a fingertip curls that finger), **Face** (head turn, look and tilt, the eyes'
look and blink, mouth open, smile or frown, brows), **Moves** (one tap keys a walk,
jump, sit down, push-ups, wave… from the playhead), **Joints** (a body map and sliders) and **Place**
(planted on the floor, the pivot the gizmo turns it around). A pose is keyed like anything else; the
fingers are joints of their own (three per finger, a row per hand in the key sheet) and blend between keys.
**Moves ▸ From video** copies a person's movement from a clip onto the figure. Clean-up is on: steadier
joints, bone lengths held, feet planted. When the capture has hands and a face, those move the fingers and
the head. **With its camera** keeps a body still while the camera pans; a camera that travels is not solved.
The pose video draws the posable people as OpenPose stick figures for a pose control video, with
each hand's 21 points and the face's 68 (DWPose's layout; the face points follow the expression; **Hands** and
**Face points** can each be turned off in the Render sheet). **Prompt from the poses** writes
what each `<Subject N>` does, in order, to copy or add to the Generate prompt.
**🖼 Photo in 3D…** (in + Add) turns a picture into a mesh with MoGe in ComfyUI (a model from
`Comfy-Org/MoGe` in `ComfyUI/models/geometry_estimation`) and puts it where the shot camera is, seen
through the photo's lens; key a small camera move and render the depth video. The mesh is also in
History (**Add to 3D**).

**🎬 Render…** opens one sheet. Tick the videos to make: **Depth**, **Pose** (when a posable person is in the scene)
and **Colour**. They run one after another over the same shot, and a cancelled or failed one stops the rest.
**One take** is one video with the cuts in it; **Each shot** is one video per shot, labelled Shot N. Depth has
**Depth range** (**Follow the shot**: each moment gets its own near and far, eased over about a second, and a cut
starts again; **Whole clip**: one near and far for the whole clip, so a long camera move squeezes part of it into a few
greys), **Depth from** (**3D shapes**: exact depth from the objects, where a splat is only a box; **The picture**: the
shot is rendered in colour and Video Depth Anything estimates its depth, so a splat gets real depth, but slower;
**Both**: the picture's depth with the objects' exact depth laid over it) and **Soften edges**, which blurs the depth
so the shapes are followed less literally. Pose has the **Hands** and **Face points** toggles.

The depth video goes to History (near = white, far = black), and **Use in H3 control** opens `deck-h3-ctrl2v` with it,
the size and the length set. Strength 1 with End 0.4 keeps the layout and camera move but lets H3 draw real people and
furniture; ending later copies the blockout's shapes (and overrides the references), lower strength loses the camera.
Keep the walls about where the real ones should be: H3 sizes the room from them. The control video is fitted to the
output's size (centre crop) and length (the last frame is held). **📷 Save frame** saves a lit clay frame as an
input; **Save depth frame** and **Save pose frame** save the depth or the stick figures of the current frame as a
picture.

**Rigged models.** A model made from a photo, or an import, can be **rigged** as a person (the model layer's
**🦴 Rig it as a person**): Make It Animatable gives it the posable figure's skeleton, and it then lands in the scene as a
**rigged layer** that takes every pose, Pair, Move, IK, Hands, Face and mocap feature, and renders in depth and pose
videos. Its bones are matched by name (Mixamo, Rigify) or by where they sit; the panel says how many follow and which
joints are missing, and can re-map or turn it 180°. **Rig anything** (UniRig) is the general case for animals and props. If a joint gets no bone, the layer's panel lists
it and lets you map one (or point a joint at another bone), and **Re-map the bones** starts over. ComfyUI reads its list of meshes when it starts:
a model made in this session needs one ComfyUI restart before the rig can find it.

**Skinned models.** A model rigged with UniRig — an animal, a prop — lands as a **skinned layer**, posed bone by bone:
**Bones** in its panel picks a bone, three sliders turn it, and **Turn it** keeps that turn at the playhead (a key when the
layer has keys; with Auto key off, ◆ Key keeps it). **Key every bone** keys the whole skeleton where it stands, so single
bones can move from there; **Put it back** returns one bone to the model's bind pose. **Drag a bone dot** in the view and
the chain up to that bone reaches for the pointer (the shoulder, elbow and wrist solve together), keyed at the playhead;
let go to keep it. **Mirror the bones** turns the whole pose onto the other side (Left/Right bones swap, centre bones
mirror in place) for both keys and the resting pose. **Name** renames a bone (and the keys it holds) in the model and the
layer (the name is kept in the layer and put back when the file loads again), and **Forget this bone** drops that one
bone's keys and resting turn, back to the model's bind pose. **Add a bone** and **Delete this bone** change the skeleton
and weight the mesh again with the nearest four bones (a simple re-skin, not a heat-diffusion one: look at the result). Get one with **Rig anything** on a
model layer, **Use as → Rig anything**, or **Key its own bones** on an import that already has a skeleton.

**Refining a render** (`deck-h3-refine`): **Use as → Refine with H3** on any clip (a splat camera move rendered as colour
video, a 3D render) loads it into a template that encodes it into H3's latent, enlarges it with the H3 latent upscaler
(**Upscale**, 1 keeps the size) and samples it again from part-way (**Strength**: Denoise and Steps), conditioned on the
prompt and up to four **References** (the splat's source photo first). An optional **Depth video** of the same camera
(the 3D tab's depth render) is resized to match and applied as H3's Fun ControlNet (**Depth hold**), so a stronger pass
can clean up without moving the room. The clip is trimmed to H3's frame grid (17k+5 frames at 24 fps); no sound of its own (Board **Finish**, Story **Finish takes** and the History sheet go through `POST /api/h3/upscale`, which puts the clip's own sound back; see below).
**Regenerate** (off) adds the Open-H3-Regenerate refiner LoRA (**Regenerate LoRA**, after the turbo LoRA) and switches the
sampler to its own schedule, so **Strength** is ignored while it is on: **Standard** is 2 steps from 0.70, **Enhanced**
starts from 0.80. The LoRA draws the clip again at **1.5×** or **1080P**, and the clip's own sound goes back in, so
speech stays in sync. It sharpens more than the plain upscale and holds faces better than Strong. The mode shows only
when its LoRA is in `models/loras`: Kijai's refiner (5.6 GB) keeps the run's turbo LoRA on, and the 2 GB merged
file needs it off and a Hugging Face token to download. 2K needs a card over 24 GB; 1080P is the most this box
should draw.

On a finished H3 run, **Upscale (H3)…** offers the same Regenerate. For whole clips at once, select them on the
**Board** and tap **Finish**, or tap **Finish takes** in the **Story** bar: each shot's clip is drawn again, and the
finished take becomes that shot's clip (**Shots to video** takes it over the draft). Both work in place on H3 runs.
A single clip from another model (an LTX take, a scene render) goes through **Use as → Finish with H3** instead,
loaded into `deck-h3-refine` with Regenerate already on; several such clips are refused.

**A clip in the image picker.** Choosing a video opens its frames. Scrub or step to one: an input that takes one picture gets **Use this frame**; one that takes several gets **Add this frame**, up to the room it has, then **Done**. **Last frame** is there too. Each is cut from the file at that exact frame.

**Characters** (Story tab, view **Characters**). A character holds its writing (role, height, a line, their story, notes), a
voice, and one or more **looks**: each look has its own words for prompts, main picture, views, sheet, expressions, current
3D model and current rig. A shot chooses which look it uses. **Media** is their own ordered list (drag to reorder), with
photos marked Face, Body, Reference or Edit. **Edit in Generate**, the sheets, **Make the views**, **Make the expressions**,
**Make a 3D object** and **Rig** all come back to **To review**, to keep, make again or throw away, and this survives a
reload. **Use as… → Give it to a character** sends anything else in. **Model and rig** are per-look settings: choose an older
version, or use **Make again** / **Rig again**, which start from how the current one was made. A layer placed in a 3D scene
doesn't change by itself; the 3D panel offers **Update to current rig**, which adds a new layer where the old one stands and
hides the old one with its poses. **Bring in from a project** copies a character and its files, so the two share only the voice.

**In use on the Board.** A run that any saved document uses (a character, a shot, a scene, a timeline, an open tab) shows a
link badge and can't be deleted until it's taken out of what holds it. **Delete all** removes what the Board is showing
except what's in use or pinned, and says how many of each stay first.

**Layers on a canvas.** Story's canvas has the layers in a dock under the picture (drag its grip to resize, pull it down to
shut). On Story and the Image tab, **Group** joins selected layers, with one opacity and blend for the whole group. The mask
button gives a layer a mask: the eraser hides, the brush shows, and it moves with its layer. Undo also covers moves, order,
hiding, blend and groups. The chips over the list add a grid, turn steps and size steps.

**Cropping past the edges:** hold **Ctrl** while dragging a crop (or turn on **Past the edges**) and the box can go past the picture. The new part is neutral grey. Letting go makes a new layer of that box over the original, which hides; its mask, if it has one, shows the new part. **Edit from a prompt** can then fill the grey in.

**Selecting layers:** Shift-click in the list selects from the selected layer through the one clicked; a hidden layer between them is left out. Alt-click adds or drops one. The **Select layers** arrow (Q, under Move) drags a box: it selects every showing, unlocked layer it touches. Shift adds, Alt takes away. Press V to move what's selected. When a tool hides the original, its result takes the original's place in the selection, so the next run works on the results. **Move to new edit** takes the selected layers and their masks out of this edit into a new tab. **Delete N selected** (or the Delete key) removes them all, with Undo; a locked one stays. **Shift+Enter** runs the Image tool that's open, also from its text boxes.

**Between edits:** **Copy** (Ctrl+C) takes the selected layers with their masks and **Paste** (Ctrl+V) puts them in any edit tab, in the place they had; a group comes along.
They still use the same picture files. **Delete hidden** removes every hidden layer and its mask, with Undo; a locked layer stays. **Match colour** (two or more selected) gives them curves to look like one of them, or like their average.

**Image tools** (Image tab, panel **Image tools**; the same idea as the VFX tab's effects). Pick a tool, then **Run**.
**Run on** chooses what it works on: **Whole picture** (every visible layer together) or **Selected layers** (each
selected layer alone, one run each). The result lands as a layer on top. On a selected layer the result sits over that
layer: a cropped layer sends only its kept part, and a turned or mirrored layer is sent unturned and its result takes
the same turn.
A masked layer is sent whole, without its mask. An **Edit**, **Upscale**, **Detail pass**, **De-light**, **Remove** or **Clean** result gets a copy of the
mask as it was when sent, at the result's size; other tools' results get none.
The row of buttons at the top of the section opens the main tools; the list below it has them all.
- **Edit from a prompt** (Qwen 2.1): the same edit on many layers at once. **Prompt**, **Also know** (more context, on
  every run), **Keep the rest** (a sentence that holds the rest still) and up to three reference pictures (the picture
  being edited is Picture 1, references Picture 2 onward). `{layer}` in the prompt becomes each layer's name, and
  `{a|b|c}` picks afresh for each run. **Change** sets where: **Anywhere**, **What I name** (SAM3 finds it in each
  picture) or **The red mask** (cut to each selected layer); with an area only that area changes, the rest stays pixel
  for pixel, with **Close-up**, **Grow the area** and **Edge softness**. Knobs: **Size**, **Variations** (side by side, or on
  top of each other on a canvas of a fixed size), **Seed**
  (Fixed: alike across a batch), **Steps**, **Guidance** (above 1 it follows the prompt harder, takes about twice as
  long, and uses **Avoid**) and **LoRAs** (each with strength and on/off). A layer that fails doesn't stop the rest.
- **Maps:** **Depth map**, **Canny edges**, **Scribble** and **Pose**. Depth has **Detail** (Fine: the Large model,
  sharpest; Fast: the Small one, about five times quicker). Canny and Scribble have **Amount** (More lines, Normal,
  Fewer). Pose can read with DWPose (CPU) or SDPose (GPU, holds up better on hard poses, up to 2 people). These
  templates are the VFX tab's Quick effects too: `web/maps.js` names them once for both.
- **Cut out and mask:** **Auto mask: the subject** (BiRefNet) and **Auto mask: by words** (SAM3; name what to find),
  as a cut-out layer or straight into the mask.
  **Fine edges** (on by default): these models see any picture at about 1000 px, so a big picture's edge comes back as a
  staircase. Each thing found gets a second look on a crop close to it (a run for each, not kept in History; not for a thing
  about as big as the picture), then the pixels along its edge are decided by their colour: is it more common on the thing or
  beside it (`web/matte-edge.js`). It works in a band as wide as the staircase, so a mask far off the thing is only partly put right.
- **Clean up:** **Remove** marks what you name in red with SAM3 for you to check (it can miss a watermark or mark other
  things), or uses the mask you painted; then LaMa fills it in from what is round it, with no prompt. It runs on a crop round each
  marked area (at 4K the whole picture doesn't fit 12 GB), so only those areas change. **Remove a watermark all over the
  picture** is for a faint repeated one: an edit model draws the picture again, at about 2 MP. **Clean** is a 1x restoration
  model at the picture's own size: noise, JPEG blocks or blur.
- **Restore an old photo** runs the steps you tick and lands one new layer. **Scratches and dust** are found in the browser from how thin
  and how different they are (`web/photo-restore.js`), faces left out, and LaMa fills them. **Clean** is as above. **Faces:** SAM3 finds each
  face, GFPGAN redraws it at 512 px, and it goes back through a soft oval at **Face strength**. **Add colour** is as Colourise.
  It needs `models/upscale_models/GFPGANv1.4.safetensors` (`deck-face-restore`, with `comfy_nodes/deck_facerestore` symlinked into `custom_nodes`). GFPGAN's licence file lists NVIDIA StyleGAN2
  and DFDNet terms that limit parts of it to non-commercial use.
- **Colourise:** an edit model adds colour at about 2 MP, then the picture's own brightness goes back on it, so details and faces stay as they are.
- **Upscale:** quality (SeedVR2) or fast (4x-UltraSharp), at 2×, 3× or 4×, hiding the original if you like.
- **Detail pass:** draws the picture again with more fine detail and the same layout, with Klein 9B, Klein 3, Krea 2
  or Qwen 2.1 (their i2i templates, with a **Strength** and a prompt of their own) or SeedVR2. The models differ a
  lot by subject: try two on the same picture.

Templates: `deck-cutout-image`, `deck-mask-image`, `deck-remove-lama` (needs `models/lama/big-lama.safetensors`) and
`deck-clean-image` (made by `dev/make_image_tool_templates.py`), and the depth,
Canny, scribble, pose and upscale picture templates. Run on the GPU only once so far: the mask and upscale results
were not checked there.

**Selected layers** (Image tab, **Export** panel, with layers selected): **Save each as input** makes every layer its
own input in the current project, at its file's full pixels, with its crop, turn and opacity and a see-through
background. **Save as one input** makes them one input the size of their shared box, on the **Background** colour, at
**Export size** and **Max MP**. **Open in a new edit** puts them in a new edit tab, in place. A hidden layer that is
selected is included.

**Upscaling:** `deck-upscale-image` / `deck-upscale-video` use SeedVR2 7B (sharp, int8) in one step,
`deck-upscale-video-fast` the 3B, `deck-upscale-image-fast` a 4× GAN model (4x-UltraSharp) then a
resize (0.5 = 2× overall). Videos are split into chunks that fit in VRAM and keep their sound and fps.
A `@Video` title on a **VHS_LoadVideoPath** node gives a video picker (this project's video outputs
and the Video tab's uploaded clips); left empty, the node is removed like an empty image.

Every number box also works like a slider: drag sideways on it (finger or mouse) to change the value
across its range, tap to type. Template fields keep to sensible limits (steps 1–100, CFG 0–20, sizes
64–4096…) inside ComfyUI's own.

A node's `width` + `height` pair shows as one size picker: an aspect preset (1:1, 16:9, 9:16, 4:3…)
plus megapixels, or a custom width/height. Sides snap to the node's own step (8, 16 or 32).

`@Boxes` on a **CreateBoundingBoxes** node gives a layout-box editor (draw boxes over the canvas or the
image being edited; each is an object with a description, or a text with its words). Used by
`deck-moss-layout` and `deck-klein3-edit`; in Klein prompts refer to box 1 as `<obj_1>`. On templates with
a **ReferenceMultiLatent** (Klein), a box can also carry a reference image: it's added as the next
reference and the box's description gets "matching <ref_image_N>". MOSS ignores reference images.

A LoRA group titled with "Turbo" (`@5 Turbo LoRA`) only lists speed-up LoRAs and starts off.
Every LoRA row has an **i** button with its Civitai page, trigger words (tap to add to the prompt)
and examples, looked up by file hash through rgthree-comfy.

**Civitai…** beside **+ Add LoRA** browses civitai.com for LoRAs made for the template's model family
(the LoRA folder: `h3` → MiniMax H3, `krea` → Krea 2, `klein` → Flux.2 Klein 9B, `qwen` → Qwen 2.1,
`moss` → MOSS Image, `ltx2.5` → LTXV 2.5, `ltx2.3` → LTXV 2.3; see `BASES` in `app/civitai.py`). Download
puts the file in that family's LoRA folder (the first `loras` path in ComfyUI's `extra_model_paths.yaml`, or
`DECK_LORA_DIR`) with a `<file>.civitai.json` beside it (ids, trigger words, preview), and **Add to the
stack** adds it. Some downloads need a Civitai API key: Settings ⚙ → Civitai. The key stays on the server in
`data/secrets.json`; the NSFW setting there decides which pictures are blurred.

The main prompt has **Build from parts**: Subject / Action / Camera / Style / Lighting / Sound
(video) or Subject / Setting / Style / Lighting / Camera (images), joined into the prompt. Each part
has saved snippets (💾 save, ◀ ▶ cycle, 🗑 delete), stored on the server so every device and template
shares them. The builder is one shared state for all templates (subjects carry over when you switch
workflow), and **Prompt set** saves/cycles the whole thing (all subjects and parts) by name. Subjects are separate slots (+ Add subject), each cycling the same library of saved
characters; the prompt gets "Subject 1: …", "Subject 2: …" labels added for you, and a slot can be tied
to a reference picture ("(as in <Picture 2>)"). Tag chips above the prompt insert the model's reference tags at the cursor: H3
`<Picture N>` (+ "Subject N" labels), Klein `<ref_image_N>` / `<obj_N>`, Qwen edit `Picture N`, Krea 2 edit `the first image` / `the second image`, MOSS edit `image N`.

**Wildcards:** `{red|green|blue}` in any text field picks one option at random for every run, so a
batch of 4 gets 4 different picks. Options can be empty (`{rainy |}`) and nest (`{a {big|small} dog|a cat}`);
braces without a `|` are left as they are. History shows the prompt that actually ran; **Edit** brings
back the wildcards, **Run again** repeats the same picks. On a tablet the text popup has keys for them:
**{ }** starts a group (or wraps the selected text as its first option), **|** adds an option, and
**}→** jumps past the end of the group.

**Setups** (the bar above the groups) save the whole template: the prompt and its builder parts, the
images and crops, LoRAs and every setting. ◀ ▶ load the previous/next setup (Undo brings back what you
had), 💾 saves over the loaded one, ＋ saves a new one, 🗑 deletes it, ↺ goes back to the template's own
prompt and settings (the tablet otherwise keeps what you last typed, even after the template file
changes). They're per workflow and stored on the server.

**Defaults** (the button on each Generate tab) set what the tab inherits its settings from: a tab keeps only the
values you change, and changing the default moves every tab that hasn't changed that setting. The prompt, seed and
images stay with the tab. The sheet saves the tab as a new default, saves its changes into the current one, or resets
the tab to it.

**Presets** sit at the top of each settings group (Seed, Sampler, LoRAs, Turbo LoRA, size…) and keep
only that group's numbers and choices, not prompts or images: ◀ ▶ cycle, 💾 save over the one shown, ＋ save new, 🗑 delete. The first entry is always the template's
default. A save is for this workflow, this model, or everywhere; model and everywhere saves match by
node type + input, so a KSampler or LoRA-stack save also turns up in other templates using them.

While a run is going, the strip under the progress bar shows its stages (loading models, preparing
images, encoding prompt, sampling, decoding, saving) with step counts and times. Drag the bar between
the preview and the settings to resize them (double-tap resets).

Settings panels with several groups have a **Section** picker at the top: choose a group by name,
or use the icon strip beside it. The picker follows the group in view as you scroll. On touch screens,
sidebar buttons and fields use larger targets; desktop keeps its compact spacing. In **VFX**, the
**Effect** picker groups the available effects and leaves room for the source and settings below it.

**Queue** (top bar): running and waiting jobs with elapsed time and an ETA from recent runs of the
same template, Stop/Cancel, and recent run times. History shows how long each run took; **Replay &
edit** loads a run's settings (prompt and builder parts, fixed seed, images, LoRAs) into Generate,
and **Run again** re-queues it unchanged.

Every template gets an **Advanced** group: attention backend (sage from the launch flag, Comfy
Kitchen INT8, or plain PyTorch), live preview type for video, and Veda sparse attention for H3.
These are inserted in front of the sampler at run time; templates don't need extra nodes.

Seeds get Random / Fixed / +1 modes automatically (any `seed` or `noise_seed` input).
The client sorts the groups by their name, in this order: prompt, inputs (pictures, clips, references), LoRAs,
control (control, denoise, strength, upscale, colour, look), size and length, everything else, model, **Advanced**.
A leading number only orders groups within one of those kinds, and groups the list doesn't know keep the template's
order.

The settings used every run (size, length, frames, fps, batch and seed) leave the sidebar for a **basics pane** over
the viewer. A button beside ⛶ opens it (`basicsPane` in `web/layout.js`; `isBasic` in `web/generate.js` picks the
fields).

**A typical image-to-video template** might tag:
`@1 Prompt`, `@2 Negative`, `@3 Start frame` (LoadImage), `@4 LoRAs` (LoraLoaderModelOnly after the
UNet loader), `@5 Sampler [seed,steps,cfg]`, `@6 Video [width,height,length]` (the image-to-video
latent node), and maybe `@9 Model` on the UNet loader if you switch high/low-noise models.

If a template looks wrong, open a generation in History → **Workflow JSON** and drag it into
desktop ComfyUI. It's the exact graph that ran, with LoRAs expanded.

### Masked edits

The Image tab does the same on the canvas. In the **Masks** panel, mark the area to redraw with **Paint mask**
(a red brush on its own layer), **Add selection** (a rectangle or lasso selection joins the mask), **Add layer shape**
(the solid part of each selected layer joins it: what its see-through and its own mask leave showing), **Cut out layer**
(a new layer of what the mask covers on each selected layer, in the same place and at full size; the layer stays, hidden, and
the mask is used up; **Invert** first to keep what is outside it), **Invert**, **Clear**
or **Mask outside** (everything of the canvas outside the selected layer). **Dilate / erode** grows or shrinks the mask, and the
canvas follows the slider. In the **Inpaint and extend** panel, **Add item** draws a box for something new:
describe it, and optionally give a picture to match (Flux 3 Klein places each box). **Extend…** grows the canvas and
marks the new part. Then describe what should be there, pick the Model (default `deck-klein3-inpaint`, then
`deck-klein9b-inpaint`, `deck-krea2-inpaint`, `deck-qwen21-inpaint`), set Denoise, Crop to mask and Edge softness, and tap **Fill**. The rest of the picture comes back untouched.

On an image template (the `-edit` and `-i2i` ones), the first picture has **Mask…**: a full-screen painter
over the picture as cropped. Paint what the edit may change; it shows as a red tint. The pen paints (press
harder for a wider line), **Erase** takes paint off, **Size** is on screen (zoom in for fine work, or `[` `]`), **Dilate / erode** grows or shrinks what is painted,
and **Invert**, **Fill all** and **Clear** work on the whole mask. Two fingers pan and zoom; once the pen has
touched the screen, fingers only pan (**Pen only**). A two-finger tap undoes, three redo (or Ctrl+Z).
**Use mask** saves it, and the picture's field shows its thumbnail (tap to edit it, the bin removes it)
with **Edge softness** (Hard, 4–64 px) and **Grow** (none, 4–32 px). A new picture or a new crop clears it.
Tabs, shots and **Replay & edit** keep the mask.

At run time every saved image is put back onto the picture through the mask (`app/maskcomp.py`, core nodes
only): the picture, scaled to the result's size, is the background; the mask is scaled the same way, grown,
then blurred; `ImageCompositeMasked` puts the result over it where the mask is. So whatever the model did
outside the mask is thrown away, and the rest is your picture, pixel for pixel. When the result's shape differs
from the picture (a different Size), the picture is scaled and cropped from the middle to fit, the same way the
edit templates' Size crops it on the way in. Videos and sounds are left alone; the setting is only offered on
templates that save images.

**Crop to mask** (on the templates with a Size, the edit models): the model only sees a box around the mask
(with room around it, in the Size's shape), made at the Size, and the result is scaled back into that box on
the full picture, so a small area gets the model's whole resolution. The output is then the picture's own
size. It falls back to the whole picture when the box would be most of it.

A template with a mask input of its own gets the painted mask too: a **LoadImageMask** (read from the red
channel), or a `@… mask` / `@… inpaint` picture left empty.

**Inpainting** (the **Inpaint** model filter): `deck-klein3-inpaint` (the default choice), `deck-klein9b-inpaint`, `deck-krea2-inpaint` and `deck-qwen21-inpaint`
make the painted area again from the prompt, instead of editing the whole picture. The picture is encoded, the
mask (grown 16 px and softened) becomes the latent's noise mask, and Differential Diffusion blends its edge; then
the result goes back onto the picture through the mask as above. Their picture shows **Paint area…** as its main
button, and a run without a mask stops with "Paint the area to change first" (the server refuses it too).
Crop to mask starts on. **Denoise** (tap 0.6 / 0.8 / 0.9 / 1.0, any denoise field has these): 0.9 is the default;
1.0 starts from pure noise and also redraws the background inside a loose mask, 0.6–0.8 keeps the old shapes and
colours (a recolour, a change of material). Describe what should be in the area, not an instruction ("a red
leather jacket", not "make the jacket red"). The Klein pair (Klein 3: 16 steps; Klein 9B: 4) draws the best extensions and takes
reference slots for things to add, never the picture itself. Krea gives the fills closest to the rest of the picture;
Qwen takes up to two **References** (Picture 1, 2) to copy a look from. Krea and Qwen are 8-step turbo models (about
10 s at 1 MP). They come from `dev/make_inpaint_templates.py`. A template counts as inpaint when it has a LoadImageMask
of its own and saves images (`maskcomp.fields` marks its Mask `required`).

**Edit with references** (Krea 2 and MOSS, from `dev/make_krea_edit_templates.py` and `dev/make_moss_edit_template.py`):
- `deck-krea2-edit`: Krea 2 turbo with the General Edit V2 LoRA. The picture to edit plus up to two **References**; the
  prompt is an instruction ("Put the robot from the second image into the first image, standing by the window"). The
  node pack takes two pictures, so two references go in side by side as one ("the right half of the second image").
  **Reference strength** (tap 1–6, 4 is the card's value) is how hard it follows the reference (the picture, when there is none).
  8 steps, about 20 s at 1 MP once loaded. The picture keeps its layout; a reference is placed beside the canvas, so a
  person or object can be restaged into the scene.
- `deck-krea2-identity`: Krea 2 turbo with the Identity Edit V2 LoRA: one photo of a person (or character) and a prompt
  for the new scene, at any Size. Reference strength 2; higher keeps the face closer, lower lets it drift. Say how much of the
  person shows ("full body", "sitting on a bench"): it tends to copy the photo's pose and crop otherwise.
- `deck-moss-edit`: MOSS-Image SFT with the Moss-Image-Edit LoRA (chinoll) on ComfyUI's own Text Encode MOSS-Image Edit:
  the picture and up to three references, named `image 1`, `image 2`… 30 steps at CFG 5. It follows the instruction
  but redraws more of the picture than Krea. The LoRA's training project is GPLv3; the weights name no licence.
`deck-krea2-inpaint` stays text-only: with the edit LoRA and a reference it fills the mask cleanly, but squeezes the
subject into the painted shape (a mask that stops at the shoulders gives a headless figure); a painted mask on
`deck-krea2-edit` (the masked-edit composite above, with Crop to mask) does that job.

**Control picture** (`deck-klein3-control`, `deck-klein9b-control`, `deck-qwen21-control`, from
`dev/make_control_templates.py`): a depth, edge, scribble or pose picture steers a new picture. None of these models
has a ControlNet, so each is the model's edit template with its first picture read as a map: the shapes, edges and
distances stay where they are, and the prompt says what they become. The reference slots stay, for a look or a person
to borrow. Make the maps in the Image tab's **Image tools**, the VFX tab's Quick effects (from a picture) or the 3D
tab (**Save depth frame**, **Save pose frame**). Krea 2 and MOSS are left out: their edit modes give the map back.

Masks are greyscale PNGs (white = change), saved by `POST /api/inputs/mask` under `data/inputs/mask/` and in
ComfyUI's `input/comfydeck/mask/`; they stay out of the input pickers. The run's settings hold the mask as
`<node>.__mask` = `{name, feather, grow, fit, box}`.

---

## The work area (every timeline)

Every timeline can have a teal range along the top of its ruler (Blender's preview range): the 3D key sheet (and its
graph), Video, Sound and the Image tab's animation bar. **Range** in the transport opens its menu: keep the playhead in it
(on / off), Start and End typed, In / Out at the playhead, the whole timeline, Clear. I / O set the in / out point at
the playhead (Alt+I / Alt+O in the Image tab, where I and O pick paint tools), Alt+X clears. On the ruler only the bar
takes a touch: drag its ends or slide it, tap it to put the playhead there; the rest of the ruler always scrubs. Ends
snap to frames, and to keys or clip edges where that timeline snaps; Alt while dragging snaps to frames only.

While it's on, the playhead stays in it: play loops inside it (or stops at its out point with Loop off), stepping and
scrubbing stop at its ends, and ⇤ / ⇥ go to them. It's saved with the tab (3D scene, video edit, mix, Image tab
animation). Renders and exports (3D depth and pose, Export video, Export sound, Export clip) do only the range while **Range only** is on, which it is by default once
there's a range. The maths is `web/workarea-math.js`, tested by `tests/workarea.test.mjs`.

## The transport (every timeline)

Laid out like Blender's timeline header: ⇤ start, ⧏ previous key, ⏴ a frame back, Play / Pause, ⏵ a frame forward,
⧐ next key, ⇥ end (of the range while it is on). Keys: Space, ← / → a frame (Shift: Video and Sound a second, 3D the
start / end), ↑ / ↓ next / previous key, Home / End. Tap the time to type one (a frame number, `2.5s` or `m:ss`); the
Image tab's bar and the 3D key bar type the length beside it, and the 3D bar the current frame. The keys jumped to are the
selected layer's or clip's, else every one's.

In the 3D tab every animatable property in the panel (position, rotation, size, the camera's lens, height and roll, a
figure's parameters and joints) has ◀ ◆ ▶ like Video and the Image tab: ◆ keys just that property at the playhead, ◀ ▶
jump between its keys, and its label is yellow on a key and green between keys. In the key sheet, selected keys show
**Key at** and **Value** to type: the frame moves them (keeping their spacing), the value sets every selected number.
In full screen with the settings panel out, the key bar stays clear of the panel.

The 3D view's tool bar is contextual: Move / Rotate / Scale, the gizmo's axes and the pivot (and the **Snap** chip, a
menu with each snap and its step) fade in only while something can be moved. Depth, the reference picture and the
scale person are one **Overlays** menu beside the director view. The bars are see-through. **H** (or the eye under the
full-screen button) hides every tool over the view; **N** pulls the settings panel in and out in full screen.

The director view has a **mini camera view** (its toolbar button, or M): what the camera you edit sees, in a box you can drag and resize from its corner, with none of the view's tools in it. It isn't in renders, and it hides while the Depth overlay is on.

**Apply scale**, **Apply rotation** and **Apply transform** (a layer's panel, under Origin) work as in Blender: the layer stays exactly
where it is and looks the same, but its scale reads 1, its rotation 0, or both and its position 0 with its origin there
(`web/bake-math.js`; the layer's `bake`). Files aren't changed. A stretched layer loses its scale with its rotation, keys on what would
go refuse it, and posable people, rigged models, pictures and backdrops don't have it.

Every 3D layer has an **Origin** (under Pivot in its panel): the point it really turns and scales around, in the view,
in renders and between keys; Position is where that point is. **Edit origin** moves it without moving the layer: drag
the gizmo (with snapping), tap the layer, or aim with Pivot at the view centre. There are also named places (Base,
Centre, a figure's Feet, Hips, Head...), metres for X, Y and Z, and Reset.

The panel's **Position**, **Rotation** and **Size** (and the camera's **Position** and **Aims at**) are rows of three
boxes with their axis inside, X red, Y (up) green, Z blue: type a value, or hold and pull sideways at a steady rate
(1 cm, half a degree, 5 mm a pixel; Shift on a mouse is ten times finer); a double-tap puts one back. The chain on
Size locks its proportions.

**Undo / Redo** sit in the top bar for the open tab (3D, and the Image tab's and Story's painting; `web/undo-dock.js`),
and float at the top of a full-screen view.

## Story

The **Story** tab (first in Make) is a storyboard: a place to write a story down and sort it out before making it. Each
story is a tab saved in the project, like video edits.

- A story has a **title**, **notes** (free writing, ideas, a script) and **scenes** in order. A scene has a heading
  (`INT. KITCHEN - NIGHT`), a summary and **shots** in order. A shot has what we see, action / dialogue, its framing (shot
  size, angle, camera move), a length (1–10 s), a status (idea, drafted, made) and **frames** (pictures).
- Four views of the same story (the bar under the stage):
  - **Canvas**: the selected shot big, to draw and lay out its frame, with its scene's shots as a filmstrip under it (tap
    one to open it; the arrows at the ends go to the scene before or after; the plus adds a shot).
  - **Storyboard**: the shots as cards with big frames. **Outline**: the list, for writing (type straight into each shot).
  - **Script**: a screenplay page: scene headings, what we see as action, and the lines (`MARA: words`, `@Mara (quietly):
    words`) as character cues and dialogue. Tap a shot to edit it.
  Tap a shot to edit it in the side panel. Drag the grip (pen, finger or mouse) to reorder shots, also into another
  scene or onto a folded one, and scenes; the arrows do the same a step at a time. Scene options have duplicate and
  delete; deletes have Undo. The expand button over the canvas looks at the frames big: every shot's frame in turn
  (arrows, a swipe, or the keys), a shot's other frames under it, **Choose** and **Compare** (a wipe or side by side,
  against the chosen frame or the next shot).
- **The shot's canvas** is the Image tab's own engine, in the Story tab: layers, brushes with pressure and tilt, shapes,
  fill, selections, crop, turning and mirroring, blank canvases, blend modes, lock and undo, the same tool strip and
  gestures. Start from the shot's frame (**Draw on this frame** puts it under a see-through layer), a **Blank
  canvas**, **Add pictures** (this project's pictures and outputs, any input, saved edits, uploads) or **Frame from a
  clip** (any clip here, scrubbed to the frame you want), and lay several out as a collage. Each shot keeps its
  composition; its flattened picture (saved a moment after the last change) is the shot's frame, shown as **Canvas** in
  its frames, unless another frame is chosen.
- **Generate frame** runs the story's text-to-image template (Frames, Template: any installed image template with a
  prompt, a width and a height and no picture input; the first one by default) on the shot's framing and description
  plus the story's **Style** line, at the story's **Shape** (about a megapixel), 1-4 per run. The pictures land on the
  shot when the run ends, also after a reload. **From pictures** (the image picker) and **Upload** add frames too.
  Tap a frame to make it the shot's chosen one; the canvas button on a frame puts it on the canvas as a new layer.
- **Redraw** runs the shot's frame (the canvas, flattened) through an edit or image-to-image template (the story's
  choice, or the shot's own: `deck-krea2-edit` first, then `deck-klein3-edit`, `deck-qwen21-edit` and `deck-moss-edit`, then the Krea 2, Qwen and MOSS i2i templates). The prompt comes from the
  shot (what we see, its characters' looks, the story's style; an edit model is asked to turn the picture into a
  finished frame, keeping the layout and camera), or write your own. Characters in the shot with a main picture go in as
  the edit model's extra pictures, named in its syntax (`Picture 2`, `<ref_image_1>`, `the second image`, `image 2`). **Change** sets how far an
  image-to-image template may go. A **mask** (painted over the frame, or the canvas's rectangle or lasso selection) keeps
  everything outside it as it was (the masked-edit composite, below). The results land in the shot's frames.
- **Video** runs an image-to-video template (`deck-ltx-i2v` by default; any video template with a start picture and a
  prompt) on the shot's frame, for the shot's length, with a prompt from what we see, the action and the lines (in
  quotes; H3 gets `<d></d>`), the camera move, the characters and the style. With a first-to-last template
  (`deck-ltx-flf2v`, `deck-h3-flf2v`) the clip ends on the next shot's frame (**End on the next shot's frame**). Lines
  said by characters with a voice can be spoken (**Speak the lines**: Qwen, IndexTTS-2 or Fish S2, as in the Sound tab),
  joined into one sound, and given to a template that plays to a sound (`deck-ltx-a2v`) or takes a voice; the clip is
  made at least as long as the lines. The clips land on the shot; tap one to choose it, the chosen one to play it.
- The chosen frame goes **To Generate** (the open template's picture field), **To VFX** (the start image) or **To the
  Image tab**. **Shots to video** puts every shot on the Video tab's timeline in order: its chosen clip, or its chosen frame
  for its length. **Copy as text** copies the outline as plain text.

### Characters

Characters belong to the project (one `characters` document each in its folder) and are listed in the Story panel.
A character has a name, who they are, their **look** (what prompts say about them: face, hair, clothes, kept the same
every time), reference **pictures** (tap one to make it the main one; **The shot's frame** adds the selected shot's
frame), a **voice** from the Sound tab's voice library, and notes. Write `@` and a name in a shot, a scene summary or
the story's notes: matching characters show as chips under the box (and in the text popup on a tablet). A shot shows
who is in it (named with `@`, or speaking a line); Generate frame, Redraw and Video add each one's look to the prompt,
Redraw and the H3 reference templates get their picture (below), and their lines are spoken in their voice.

**Look pack** (in the character): five views, **Front**, **Three-quarter**, **Side**, **Back** and **Face**, each optional.
**Make the views** draws the missing ones from the main picture with `deck-krea2-identity` (Reference strength 4,
704×1280 full body on light grey, the face 1024×1024; the prompts are `VIEW_PROMPTS` in `web/cast.js`); each result
comes back under the slots to **keep**, **make again** or **throw away**. The plus on an empty slot takes one of your
pictures instead. **Character sheet** puts the kept views side by side on light grey as one input picture
(`POST /api/looks/sheet`). A back view keeps the back of the outfit but the identity LoRA may still turn a face to the
camera: make it again or pick one.

**Which picture a shot uses**: Redraw and Video give each character the view the shot's camera wants: a Close or
Extreme close shot the face, the **Profile** angle (or "in profile", "from the side") the side, **From behind** (or
"walks away", "from behind") the back, a medium shot the three-quarter, otherwise the front, falling back to a near view
and then the main picture. Redraw's **Reference pictures** shows the pick per character and takes another (a view, the
sheet or the main picture) for that shot.

**Look check**: when a frame lands on a shot with characters, the server compares it with their packs
(`app/looks.py`): the DFN5B CLIP ViT-H-14 image tower that ComfyUI-MMAudio already keeps in `models/mmaudio`, run in
ComfyUI's venv on the CPU (no VRAM; about 7 s to start, 1–3 s a picture), on each person DWPose's YOLOX finds, plus a
hue match of their middle (a jacket that changed colour). Below 0.75 look or 0.6 colours (`DECK_LOOK_MIN`,
`DECK_COLOUR_MIN`) the frame shows **Look drifted**, and Redraw offers **Redo with stronger reference** (Reference
strength 2 higher, up to 6; a template without one uses `deck-krea2-edit`). It catches another person or a changed
outfit colour; a changed head of the same colours can pass. `DECK_LOOK_SCORER=none` turns it off; `DECK_LOOK_PY`,
`DECK_LOOK_MODEL` and `DECK_LOOK_DET` point at the venv, the CLIP file and the detector when ComfyUI is elsewhere.

## Sound

The **Sound** tab is laid out like the Video tab: tracks (mute, **S**olo, level, pan), clips from sound files or the
sound of any clip (drag to move, drag the ends to trim, overlap to cross-fade, split, duplicate), a waveform overview
with a level meter, and **Export**, which mixes everything (optionally evened out to −16 LUFS) into an M4A/WAV/MP3/FLAC
file in the media library. Each mix is a tab saved in the project, like video edits.

Getting sound in and out:

- **Board → ♪ Sound** on a video: take its sound out into the media library, or put another sound on it (replace the
  clip's own sound or keep it underneath); the result is a new clip in History.
- **Import clip → Sound only** saves just the sound of a link, a PC file or a device file (an .m4a).
- Templates with a `VHS_LoadAudio` node tagged `@…` get a **sound picker**: a sound file or a clip's sound, cut with
  Start / Length. The server hands the loader a file it can open (`app/audioedit.prep`).

Templates that use sound:

| Template | What it does |
|---|---|
| `deck-ltx-t2a` | Sound effects, ambience and foley from a description (LTX-2.5 audio only; no extra models). Sound tab → *Make a sound*. |
| `deck-mmaudio-foley` | **Sound from clip** (Sound tab → *Make a sound*): sound for a clip made from its picture (MMAudio): footsteps, impacts, ambience, timed to what happens. The prompt steers it and keeps music and speech out. Best up to 8 s. |
| `deck-ace-music` | Music, with or without lyrics (ACE-Step 1.5 turbo, `checkpoints/ace_step_1.5_turbo_aio.safetensors`, 9.3 GB from `Comfy-Org/ace_step_1.5_ComfyUI_files`). Sound tab → *Make a sound* → Music. Written by `dev/make_sound_templates.py`. |
| `deck-ltx-a2v` | **Sound to video** (VFX → Generate): a clip that moves to a sound (lips follow speech, movement follows music), optionally from a start image. The sound is frozen while the picture is made, and kept. |
| `deck-ltx-t2v` | now has an optional **Voice**: ~5 s of someone speaking, whose voice the clip's speech takes on (`LTXVReferenceAudio`). |
| `deck-h3-ref2v` | now has two optional **Sound references** (`ref_audios` on `MiniMaxH3ReferenceToVideo`). |

### Voice tools

The Sound tab's **Voice** section cleans a voice out of a mix (music and effects, then echo, then noise:
RoFormer models from [python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator)), keeps saved
voices (a 5–15 s clean cut, what is said in it — **Listen** writes it down with faster-whisper — and a consent tick),
and speaks a script (`Name: line` per line) in those voices with [Qwen3-TTS 1.7B](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base),
laying the lines on the timeline a track per voice.

They run in their own venv so their torch never touches ComfyUI's (`voice/worker.py`, started by `app/voice.py`):

```bash
python3.12 -m venv /mnt/data/comfydeck-voice/.venv
/mnt/data/comfydeck-voice/.venv/bin/pip install torch torchaudio torchvision --index-url https://download.pytorch.org/whl/cu128
/mnt/data/comfydeck-voice/.venv/bin/pip install "audio-separator[gpu]" qwen-tts faster-whisper soundfile audioread "av<16"
# if a dependency swapped torchvision for a CPU build ("operator torchvision::nms does not exist"):
/mnt/data/comfydeck-voice/.venv/bin/pip install --force-reinstall --no-deps "torchvision==0.26.0+cu128" --index-url https://download.pytorch.org/whl/cu128
```

(`av<16`: faster-whisper 1.2 breaks on PyAV 19. Whisper finds the CUDA libraries torch put in the venv; `app/voice.py`
adds them to `LD_LIBRARY_PATH`.)

Models download on first use into `/mnt/data/comfydeck-voice/models` (separation ~0.2–0.9 GB each, Whisper
large-v3-turbo ~1.6 GB, Qwen3-TTS ~4.5 GB). `DECK_VOICE_HOME`, `DECK_VOICE_PY`, `DECK_TTS_MODEL` and
`DECK_WHISPER_MODEL` override the defaults. A run needs the GPU: it waits for an empty ComfyUI queue (it refuses
otherwise) and asks ComfyUI to unload its models first. Saved voices live in `data/voices/`.

Only clone a voice that is yours or that the speaker said you may use, and don't use it to pass as them.

**Delivery.** A script line can say how it is spoken, `Name (whispering, scared): line`, and carry inline tags,
`I told you [sigh] it was fine`. The dialogue's **Engine** decides what is heard:

- **Qwen3-TTS** ignores both.
- **IndexTTS-2** ([index-tts](https://github.com/index-tts/index-tts)) reads the delivery words through its
  emotion model, at the Delivery strength. It drops the tags. About 70 s for three lines, load included.
- **Fish S2 Pro** understands both, with the delivery as a leading tag. It runs through
  [s2.cpp](https://github.com/rodrigomatta/s2.cpp) with the q8_0 GGUF, which is near lossless and fits 12 GB.
  About 25 s for three lines. It needs each voice's transcript.

Every spoken line is evened out to −16 LUFS. Both engines live in `/mnt/data/comfydeck-voice-engines`
(`DECK_VOICE_ENGINES`), each with its own install:

```bash
cd /mnt/data/comfydeck-voice-engines
git clone https://github.com/index-tts/index-tts && (cd index-tts && uv sync --python 3.11)
hf download IndexTeam/IndexTTS-2 --local-dir index-tts/checkpoints
# s2.cpp needs nvcc 12.4+: a CUDA 12.8 toolkit from conda, no sudo
micromamba create -p ./cuda -c nvidia/label/cuda-12.8.1 -c conda-forge cuda-nvcc cuda-cudart-dev libcublas-dev cuda-cccl cuda-version=12.8
git clone --recurse-submodules https://github.com/rodrigomatta/s2.cpp && cd s2.cpp
PATH=../cuda/bin:$PATH cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DS2_CUDA=ON -DCUDAToolkit_ROOT=$PWD/../cuda -DCMAKE_CUDA_ARCHITECTURES=89
cmake --build build && cd ..
hf download rodrigomt/s2-pro-gguf s2-pro-q8_0.gguf tokenizer.json --local-dir models/s2
```

Both licences are non-commercial: IndexTTS-2 is under the bilibili model licence, and Fish S2 Pro under the
Fish Audio Research Licence.

## Prompt helper

The two buttons next to the Generate prompt's label (and in the bar of the touch-screen writing box, also for
Story's shot prompts) call a small local model:

- **Improve** (sparkle icon) rewrites the prompt for a model family and offers three versions. **Expand idea** turns
  a single line into a whole scene. The family follows the template (Krea, Flux Klein, Qwen Image, MOSS, LTX, H3);
  tap another to rewrite for it. Edit templates get an edit instruction; H3 keeps its subject lines, `[Shot N]`
  timestamps, `<d></d>` speech and the two sound lines.
- **Describe a picture** (eye icon) writes a prompt from any input or result, or only its style.

Reference tags (`the first image`, `<Picture 1>`, `<ref_image_0>`, `Picture 1`, `image 1`, `<Subject 1>`),
`@Name` mentions and `{a|b}` wildcards are kept as written. A version that lost one says so. Nothing changes until
a version is tapped, and Undo puts the old prompt back.

**Runtime** (`app/promptaid.py`): [Ollama](https://ollama.com) with `qwen3.5:4b` (vision, Q4_K_M, 3.3 GB in
`~/.ollama/models`). When Ollama is installed but not running, ComfyChair starts `ollama serve` on
127.0.0.1:11434 (its log is `data/tmp/ollama.log`). The settings are `DECK_OLLAMA_URL`, `DECK_PROMPT_MODEL`,
`DECK_OLLAMA_BIN` and `DECK_PROMPT_VRAM_MB`.

**Sharing the GPU**: Auto runs on the graphics card when ComfyUI's queue is empty (about 6 s for three versions).
It takes the voice tools' GPU lock. ComfyUI's models are unloaded only when less than 5.5 GB is free. Ollama is
told to unload the model when it's done (`keep_alive: 0`). While ComfyUI is busy, or a voice or 3D job holds the
card, Auto uses the processor instead: about 45–60 s.

## PhotoCraft and EffectCraft

Work can go to PhotoCraft and EffectCraft with its layers and tracks, to keep editing there
(`app/craft.py`, `web/craft.js`):

- **Image tab → Open in PhotoCraft:** one smart object per layer, cropped, placed and scaled as on the canvas,
  with its name and visibility.
- **Video → Open in EffectCraft:** one comp at the sequence's size and rate. Each clip is a layer with its
  start, trim, position, scale, rotation and opacity. Fades become keyframes, sound levels are in dB, and
  hidden or muted tracks are switched off. Layers are stacked as the tracks are.
- **VFX → Open in EffectCraft:** the source over its trim, the matte (hidden; set it as a track matte),
  and every take, with only the one on show switched on.
- **A result → Open in PhotoCraft / EffectCraft:** what it was made from comes along as a hidden layer.

Documents live in `data/craft/<id>/` and open on this computer's screen. PhotoCraft opens them as tabs.
EffectCraft opens each in a window of its own, started with `--control <port>`, so unsaved work in
another window is never touched. Save there, then **Bring back** (in **Craft documents…**) renders the
saved version into the media library: PNG, MP4, or WebM with transparency. From there it goes into the
Image tab, an input, the timeline or VFX. The apps are found on `PATH`; set `DECK_PHOTOCRAFT`,
`DECK_PHOTOCRAFT_CLI`, `DECK_EFFECTCRAFT` or `DECK_EFFECTCRAFT_CLI` to use others.

## Layout

```
app/main.py          application wiring, generation API, websocket fan-out, saving outputs, reconcile loop
app/routes/          HTTP routers by feature: audio, effects, library, scene, video, web (the app shell); context.py
                     holds what they share
app/accel.py         the Advanced group every template gets: attention backend, live preview, Veda
app/audioedit.py     sound with ffmpeg: extract, the Sound tab's mixdown, laying a sound on a clip
app/civitai.py       Civitai LoRA search + downloads, the API key (data/secrets.json)
app/clipimport.py    Import clip: a piece of an online video, a PC file or a device file
app/comfy.py         ComfyUI HTTP + websocket client
app/config.py        runtime configuration and its environment variables
app/craft.py         open work in PhotoCraft and EffectCraft, bring the result back
app/db.py            SQLite: projects + generations (params, exact workflow, parent lineage)
app/delogo.py        Remove watermark (VFX Quick effect)
app/editsize.py      the Size picker for templates whose output takes its size from the first image
app/h3upscale.py     upscale and Regenerate a finished H3 clip with its own run's settings
app/imageprep.py     crop, megapixel cap, snap to multiple-of-N, video/gif frame grabs
app/keyexpr.py       keyframe curves for renders, in Python and as an ffmpeg expression
app/looks.py         characters' look packs and the look-drift check
app/maskcomp.py      masked edits: put the result back through the painted mask
app/motion.py        human motion files as the 3D tab's motion
app/posefind.py      which finished Pose preview belongs to a clip
app/previews.py      light previews of saved outputs for grids
app/projects.py      list, create, rename, reorder, duplicate and delete projects
app/promptaid.py     prompt helper: a small local model through Ollama
app/sceneasset.py    files imported into the 3D tab (models, splats) and what they refer to
app/stages.py        friendly progress stages for a run
app/storage.py      where ComfyChair's files go, and making sure they go away when deleted
app/store.py         a small JSON document store: saved tabs, presets, created 3D objects, scenes
app/templates.py     @-tag parsing, field typing from /object_info, LoRA chain splicing
app/tracking.py      simple motion tracking of a clip
app/videoedit.py     render the Video tab's timeline with ffmpeg; key and matte filters
app/videoprep.py     trim / crop a video input before ComfyUI loads it
app/voice.py         the voice tools' jobs and saved voices; voice/worker.py runs in its own venv
app/wildcards.py     prompt wildcards {a|b|c}
web/                 the tablet UI (vanilla JS, no build step); web/vendor/ has the third-party libraries
web/app.js           entry point: wires the modules, projects, tab switching
web/ui.js            shared UI kit: h(), api(), toasts, sheets, overlays and the widgets every panel uses
                     (button, iconBtn, seg, field, section, numSlider, rangeField, propNum, mediaCard, cycleBar…)
web/core.js          shared state S, saved snippets, input-image URLs
web/navigation.js    screen state and visits; web/history.js owns browser history and overlay Back behavior
web/world.js         the three spaces (Make, Edit, View) and moving between them
web/layout.js        splitters, maximizable, side navigation, the basics pane
web/tabs.js          the tab system every panel uses
web/modal.js         dialog focus, nested focus scopes and background isolation
web/prefs.js         app-wide settings document
web/projects.js      Settings → Projects
web/notifications.js device notifications, chime and screen wake lock
web/sw.js            service worker (HTTPS only)
web/run-state.js     generation progress and timing; web/generation-data.js queries saved generations
web/run.js           live preview and output viewer
web/make.js          the one way a template run starts
web/kinds.js         what each kind of thing is called and how it is drawn
web/generate.js      Generate: templates and fields, group order, the basics pane
web/gentabs.js       Generate tabs, Defaults
web/phrases.js       prompt phrase chips
web/prompthelp.js    prompt helper panel
web/civitai.js       Civitai LoRA browser
web/vfield.js        the player + trim + crop widget of a video field
web/maskpaint.js     the mask painter for edits
web/useas.js         Use as…: every place an output can go
web/story.js         Story (storyboard: scenes, shots, frames); web/cast.js, web/characters.js, web/shot-words.js: characters and shot words
web/talk.js          talking shots
web/dialogue.js      dialogue scripts for the voice tools
web/editor-engine.js the Image tab's layer stack; web/editor.js the sketch pad (Draw); web/layer-geom.js its layer geometry
web/paint.js         the Image tab's painting (brushes, shapes, fill, selections, undo); web/icons.js line icons
web/imagetools.js    Image tools; web/maps.js the control-map templates shared with the VFX tab
web/inpaint.js       Inpaint and extend
web/view-boxes.js    mark the views on one picture (a character sheet)
web/video.js         the Video tab; web/clip-effects.js clip effects shared with VFX; web/clipimport.js Import clip
web/timeline.js      the timeline the Video and Sound tabs share
web/workarea.js      the work area every timeline shares (web/workarea-math.js: its pure maths)
web/playback.js      the transport bar and keys every player shares
web/keys.js          the keyframe engine; web/keyed.js animatable properties for clips and layers
web/gizmo.js         transform gizmos with grid and snapping; web/gizmo-orient.js axes and pivot maths
web/origin-math.js   a 3D layer's origin: where it draws, and moving it without moving the layer
web/crop-geometry.js crop geometry shared by image and video inputs
web/undo-dock.js     Undo / Redo for the open tab
web/sound.js         the Sound tab
web/vfx.js           the VFX tab
web/track.js         motion tracking sheet; web/track-math.js its maths
web/craft.js         send work to PhotoCraft and EffectCraft
web/board.js         the Board; web/compare.js its compare view; web/media.js lists a project's outputs
web/scene.js         the 3D tab (loaded on demand)
web/scene-ui.js      the 3D panel: object settings, Render sheet
web/scene-data.js    camera and scene data sums
web/scene-modes.js   the 3D panel's modes (Edit scene, Camera, Create object); web/scene-builtin.js the three built in
web/scene-view.js    the stage: geometry, lights and the soft figure
web/scene-keys.js    the key sheet (dope sheet and graph editor)
web/scene-camera.js  camera moves; web/scene-shots.js the Shots row and Prompt from the shots
web/scene-export.js  depth, pose and colour renders
web/scene-import.js  imported models, splats, objects from photos
web/scene-library.js starter scenes
web/scene-model.js   Create object: lathe and other basic modelling; web/model-geom.js its geometry
web/scene-motion.js  motion made elsewhere onto a figure (text to motion, video mocap); web/motion.js the data
web/scene-offscreen.js a 3D scene drawn on its own for the Video tab's compositions; web/scene-comp.js compositions
web/scene-offset.js  the offset layer's panel
web/scene-pose.js    a figure's pose tabs
web/scene-ref.js     a reference picture or clip over the 3D view
web/scene-rig.js     rigged models; web/rig-map.js maps a skeleton onto the figure
web/scene-skin.js    skinned models; web/reskin.js re-skins after a bone is added or deleted
web/scene-scale.js   real size; web/scale-math.js its maths
web/scene-track.js   the layers a motion track makes
web/figure.js        the posable person; web/ik.js its CCD inverse kinematics
web/depth-range.js   near and far of a depth render from sampled depths
web/splat-depth.js   splats in a depth picture; web/splat-levels.js preview levels; web/splat-shape.js size and trim
web/app.css          styles; colours, radii and shadows come from the tokens at the top
templates/         your workflow templates
data/              database, projects/ (saved outputs), local copies of inputs (git-ignored)
dev/mock_comfy.py  fake ComfyUI for UI work without a GPU
tests/             unit tests for the workflow functions: .venv/bin/python -m unittest discover tests
```

Every output is copied into `data/projects/<project name>/<generation id>_<file>`, so each project
is one folder you can browse, and history survives clearing ComfyUI's output folder. ComfyUI's own
copy goes to `output/comfydeck/<project name>/`. Generations made without a project land in
`Unsorted/`. Older installs that used `data/generations/<id>/` are moved over on startup.

When ComfyUI's folder is on the same machine (`../ComfyUI` by default, or `DECK_COMFY_DIR`),
deleting a generation also deletes ComfyUI's copy (only if it's the same size as ComfyChair's), and
one-off crop files unused for 30 days are cleared from its input folder. `DECK_COMFY_DIR=""` turns
that off.

Images you upload, edit or draw are remembered with the project that was open, so the image picker
shows that project's own images and generations first.

### Working on the UI without the GPU

```bash
.venv/bin/python dev/mock_comfy.py --port 8199 --animated
COMFY_URL=http://127.0.0.1:8199 DECK_DATA=/tmp/deckdev ./run.sh
```

The mock can run beside the real ComfyChair: use another port and data folder (e.g.
`--port 8191`, `DECK_DATA=/tmp/deckdev`) and nothing touches the live one.

### Regression checks

```bash
DECK_DATA=$(mktemp -d) DECK_COMFY_DIR="" .venv/bin/python -m pytest -q tests
node --test tests/*.test.mjs
```

Optional browser checks use Playwright as a development tool; the app still has no JavaScript build step:

```bash
npm install --no-save --package-lock=false playwright@1.64.1
npx playwright install chromium
node dev/check_browser.mjs
```

The browser script starts its own mock ComfyUI and app on temporary local ports, with a fresh data folder.
It checks delayed and failed document loads, project switches, keyboard tabs, nested dialogs, focus restoration,
Back navigation and reduced motion. It never connects to the live app. `DECK_PYTHON` and `DECK_CHROME` can
select another Python or Chromium executable; `DECK_PLAYWRIGHT` can name an existing Playwright module URL.

### Debugging the websocket

The ⋯ button shows message counts plus any messages ComfyChair doesn't handle. Use it to see
what a custom node sends. Binary previews are decoded by finding the JPEG/PNG/WebP header in
the payload, so differently framed preview messages still work.

---

## API (for scripting)

| | |
|---|---|
| `GET /api/templates` | templates with their fields |
| `POST /api/generate` | `{template, values: {"<node>.<input>": v}, batch, project_id, parent}`. A seed of `-1` means random |
| `GET /api/projects` · `POST /api/projects` `{name}` | projects in picker order · make one |
| `PATCH /api/projects/{id}` `{name}` · `POST /api/projects/order` `{ids}` | rename · reorder (every id once) |
| `GET /api/projects/stats` | `{id: {bytes, generations}}` |
| `POST /api/projects/{id}/duplicate` · `GET /api/projects/jobs` | copy in the background (`deck_project_job` progress on the websocket) |
| `DELETE /api/projects/{id}?confirm=<name>` | deletes the project, its generations and its folder; 409 for the last project or one with a run waiting/running |
| `GET /api/generations?project_id=` | history |
| `POST /api/generations/{id}/to-input` | `{index, frame: "first"\|"last", mp, multiple}` → ComfyUI input name |
| `POST /api/upload` | multipart `file`, `mp`, `multiple`, `crop` (`{"x","y","w","h"}` as fractions) |
| `POST /api/interrupt` | `{prompt_id}` stops that run (interrupts it if running, removes it if waiting, else nothing); without it, whatever is running |
| `GET /api/jobs` | running and waiting jobs with timings (the running one with its stages), plus recent runs |
| `WS /ws` | ComfyUI's own messages plus `deck_generation` updates; binary = previews |
