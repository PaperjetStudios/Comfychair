# ComfyDeck

A touch-first front end for ComfyUI. ComfyUI runs headless on your Linux box; ComfyDeck serves a
tablet-friendly page on your LAN and drives ComfyUI through its API.

```
tablet ──http/ws──▶ ComfyDeck :8190 ──http/ws──▶ ComfyUI :8188 (can stay on 127.0.0.1)
```

**v1 (this scaffold):** template system, generate screen with live (animated) sampler previews,
LoRA stacks, image upload with megapixel cap, projects, history with full lineage, reuse settings,
send any output (or a video's first/last frame) back in as an input. **Editor** tab: crop images and
join them side by side, stacked or in a grid, then save the result as an input. Any image field
has **Draw**: a full-screen sketch pad with pen pressure and palm rejection (once a pen touches it,
finger touches are ignored), e.g. to sketch the source for the `-i2i` templates. **Video** tab: trim
generated clips, order them and export one video (ffmpeg); the result lands in History. **Board**:
every image and video in the project as a pin board, with pins, filters and a tile-size slider.
**☑ Select** (or long-press a tile) picks several: **New edit** puts the images in the Editor as a
fresh layout (Undo brings the old one back), **To video** adds them to the timeline, **Delete**
removes their generations (it asks first). **⤓ Import clip** (also "From a link or big file…" in every
video picker) cuts a piece out of a YouTube/Reddit/X/Vimeo link, a video file on the PC, or a file on
the device, and saves it to the media library (see *Importing clips* under Setup).
**Compare** (select two tiles on the Board) shows them full screen as a wipe (drag the line: the split shows as a
percentage) or side by side, two clips playing in step. **Sound** tab: a multi-track sound editor (see *Sound* below).
Every slider is a number box with a bar behind it: hold it, then pull sideways to change it (a swipe scrolls past it), or
tap to type.
**3D** tab: block out a shot with soft mannequins, boxes and a room, keyframe them and the camera, and
render it as a depth video for `deck-h3-ctrl2v` (see below).
The preview pinch/wheel-zooms, the picker has a camera button, and ⛶ goes full screen.

**Next:** crop/compose tool (character sheets) → scenes/shots/takes → editor tab → extend/bridge shots.

---

## Setup

```bash
sudo apt install python3-venv ffmpeg      # ffmpeg is used to grab frames from videos
cd ~/comfydeck
./run.sh                                  # first run creates .venv and installs deps
```

Open `http://<linux-box-ip>:8190` on the tablet, then "Add to Home screen" for fullscreen.

ComfyUI no longer needs `--listen`: ComfyDeck proxies everything, so ComfyUI can stay on
localhost. Keep `--listen` if you still want the normal ComfyUI UI from other machines.

**Previews:** ComfyDeck asks ComfyUI for live previews on every run, so no launch flag is needed.
Images use TAESD when a decoder for the model is in `models/vae_approx` (`taef2_decoder` for
Flux2/MOSS/Klein, `taeh3-comfy` for MiniMax H3), otherwise latent2rgb. Video runs default to
VideoHelperSuite's animated preview (low-res, shows motion); **Advanced → Live preview** switches
to one sharp TAE frame per step. Change the defaults with `DECK_PREVIEW` / `DECK_VIDEO_PREVIEW`.
Krea2 (Wan latent) and Qwen Image 2.1 (RGBA TAE) currently crash ComfyUI's TAESD previewer, so
don't put `lighttaew2_1` or `taeqi2_1_decoder` in `vae_approx`.

**Run on boot (terminal-only mode):** `deploy/` has the systemd units. The "ComfyUI" GRUB entry
boots `comfyui.target`: no desktop, ComfyUI plus ComfyDeck. Install or update them with:

```bash
sudo bash deploy/install-services.sh        # backs up the old units, installs, reloads systemd
journalctl -u comfyui -u comfydeck -f        # logs
```

Before starting, ComfyUI waits up to 90 s for the drive(s) its extra model folders are on. It reads
the `base_path`s in `extra_model_paths.yaml` and matches them to `/etc/fstab`, so moving the models
again needs no change here. It retries the mount, then starts anyway, so a missing drive only costs
you the models on it. The models are on NTFS (`/mnt/data`): if Windows ever runs on that disk, turn
off Fast Startup there, or ntfs-3g can refuse to mount it. ComfyDeck reconnects to ComfyUI on
its own, so the start order between them doesn't matter.

**HTTPS (optional, recommended):** over HTTPS the tablet can use the real screen wake-lock, show
"done" notifications, and install ComfyDeck as an app (with an offline page when the box is off).
Over plain http ComfyDeck keeps the screen on during runs with a tiny silent video instead, and
signals a finished run with a chime and a ✓ in the tab title. To make a certificate with openssl:

```bash
deploy/make-cert.sh                       # makes certs/comfydeck-ca.crt + the server certificate
SSL_CERT=certs/deck.pem SSL_KEY=certs/deck-key.pem ./run.sh
```

Install `certs/comfydeck-ca.crt` on each tablet once (the script prints how). Re-run the script if
the box's IP changes; the CA stays the same, so the tablets don't need it again.

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
  stream relayed through ComfyDeck while a small whole-video copy downloads (a few seconds for a 10-minute
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
| `@1 Prompt` | a leading number sets the group's position |
| `@LoRAs` on a **LoraLoader** or **LoraLoaderModelOnly** | a LoRA stack: add/remove/disable, strength sliders. At run time the node is chained N times, or bypassed if the stack is empty |
| `@Start frame` on a **LoadImage** | image picker: a gallery of input images and generated outputs, plus upload (with megapixel cap). Left empty, the node is removed and whatever it fed is unplugged, so it works for optional inputs (reference images, first/last frames) |
| the same `@References` title on several nodes | one group; the fields are numbered (Image 1, Image 2…) |

A **Primitive** node (`PrimitiveInt`, `PrimitiveFloat`…) shows as one number labelled with its title, e.g.
`@3 Length (seconds)` feeding a math node that converts seconds to frames (see `templates/deck-h3-i2v.json`).

**VFX templates** (the **VFX** tab). Each effect runs one template by id (`deck-ltx-ripple`,
`deck-ltx-v2v-lora`, `deck-ltx-alpha`, `deck-sam3-video-mask`, `deck-ltx-cleanplate`, `deck-ltx-t2v`,
`deck-ltx-layout`, `deck-ltx-tracks`, `deck-ltx-ingredients`, `deck-ltx-upscale`; see `EFFECTS` in
`web/vfx.js`). An effect whose template is missing shows a note instead of Run. The tab fills these
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
| Pose preview | `deck-pose-video` | DWPose only (CPU): what the drive effects follow |

They come from `dev/make_perf_templates.py`. Viggle needs `minimax_h3_ref2va_viggle_pruned_int8_convrot`,
`viggle_animate_dmd_lora_r64` and the `fixed_embed_fwd_anyframe` text conditioning (ComfyUI-Viggle-Animate-H3).

**Face crop** (`comfy_nodes/deck_facecrop`): Deck Face Crop follows a face through a clip from a face mask
(DWPose face points are enough). Frames without a face take their neighbours' box, the square keeps one
size, and edges are padded. Deck Face Uncrop pastes processed crops back through a soft outline of each
frame's face points plus the forehead; Chin below 1 lifts its lower edge off the neck and collar. Link it like the TAPNext++ node below
(`ln -s ~/Programs/comfydeck/comfy_nodes/deck_facecrop ~/Programs/ComfyUI/custom_nodes/deck_facecrop`) and
restart ComfyUI.

**Keying** needs no template: the Video tab's **Key…** button on a clip, and the VFX tab's **Colour key**
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

The Track motion sheet then offers **Tracker: TAPNext++**. ComfyDeck cuts the clip to about 640 px wide
and queues it on ComfyUI, so it waits behind any running generation. A 20×20 grid of points (inside the
track box, outside the ignore box) is followed through every frame. The camera is fitted to those tracks
the same way as with Simple tracking.

**Character sheets** (`deck-h3-charsheet`): give it a picture of a character as Reference 1 and it
makes a 12 s portrait clip: a 6 s orbit on a grey studio backdrop, then cuts at 6, 7.5, 9 and 10.5 s to
close-ups (face front, three-quarter, profile, waist up). It saves the clip plus a sheet: frames
`4,54,96,120` (front, side, back, other side: H3 eases into the orbit, so these aren't evenly spaced) and
one from each close-up (`162,198,234,270`), 4 per row.
Pick the sheet as a reference in `deck-h3-ref2v` for the next video. With a fixed seed the same
character gives the same sheet; if the orbit runs fast or slow, change **Sheet frames** (frame = seconds × 24).
The length is fixed, so changing the shot timestamps in the prompt also means changing the frames.
`deck-h3-objectsheet` is the same for props and other objects: the close-ups are front, three-quarter,
the top (high angle) and a small detail.

**Blocking a shot** (`deck-h3-ctrl2v` + the **3D** tab): ref2v plus H3's Fun ControlNet, driven by a
control video. The 3D tab works like the Editor: **+ Add** people (soft, featureless mannequins), boxes,
balls, cylinders, walls or a room; the layer list holds the Camera, the Room and the objects (◉ hides
one), and under it are the selected layer's settings. Everything but the camera can be deleted (with
Undo). Tap an object to select it and get a gizmo; tap it again (or W / E / R, or the toolbar) to switch
between Move, Rotate and Scale. Tap empty space to go back to the camera: the view is the camera, so
drag to orbit, two fingers to pan and zoom. **◆ Key** keyframes the selected object (or the camera) at
the playhead; once something has keys, changing it writes a key where the playhead is. The key sheet
under the view has a row per layer: drag a key along its row to retime it, tap a row to scrub (←/→ step
a frame, Shift+←/→ jump between keys). With **Auto key** off (K), a change to something animated is only
held until ◆ Key or the playhead moves, so you can look around without touching the keys. ↶ / ↷ (Ctrl+Z,
Ctrl+Shift+Z) undo and redo.
**Posable person**: a low-poly figure with joints. Tap it to show its joint dots, tap a dot to pose that
joint (Rotate), or drag a hand or foot (Move) and the arm or leg follows (IK). Its settings are in tabs:
**Poses** (about 60 with pictures: standing, bending, moving, sitting and kneeling, on the floor, fitness;
**Pairs** pose it with the nearest other figure: hug, kiss, holding hands, carry, lying together…;
**Mine** keeps your own, per project or for all; apply to the whole, upper or lower body), **Adjust**
(parameters on top of the pose, on/off: lean, head turn, legs apart, bend knees…; walk and run cycles
whose steps follow how far the figure moves; squat/sit/kneel as 0–100%), **Moves** (one tap keys a walk,
jump, sit down, push-ups, wave… from the playhead), **Joints** (a body map and sliders) and **Place**
(planted on the floor, the pivot the gizmo turns it around). A pose is keyed like anything else.
**Render pose video** draws the posable people as OpenPose stick figures for a pose control video
(**Render both** makes the depth and pose videos of the same shot). **Prompt from the poses** writes
what each `<Subject N>` does, in order, to copy or add to the Generate prompt.
**🖼 Photo in 3D…** (in + Add) turns a picture into a mesh with MoGe in ComfyUI (a model from
`Comfy-Org/MoGe` in `ComfyUI/models/geometry_estimation`) and puts it where the shot camera is, seen
through the photo's lens; key a small camera move and render the depth video. The mesh is also in
History (**Add to 3D**).
**Render depth video** puts the clip in History (near = white, far = black, the range fixed over the
clip), and **Use in H3 control** opens `deck-h3-ctrl2v` with it, the size and the length set. Strength 1
with End 0.4 keeps the layout and camera move but lets H3 draw real people and furniture; ending later
copies the blockout's shapes (and overrides the references), lower strength loses the camera. Keep the
walls about where the real ones should be: H3 sizes the room from them. **Soften edges** blurs the
depth so the shapes are followed less literally. **📷 Save frame** saves a lit clay frame as an input.
The control video is fitted to the output's size (centre crop) and length (the last frame is held).

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

The main prompt has **Build from parts**: Subject / Action / Camera / Style / Lighting / Sound
(video) or Subject / Setting / Style / Lighting / Camera (images), joined into the prompt. Each part
has saved snippets (💾 save, ◀ ▶ cycle, 🗑 delete), stored on the server so every device and template
shares them. The builder is one shared state for all templates (subjects carry over when you switch
workflow), and **Prompt set** saves/cycles the whole thing (all subjects and parts) by name. Subjects are separate slots (+ Add subject), each cycling the same library of saved
characters; the prompt gets "Subject 1: …", "Subject 2: …" labels added for you, and a slot can be tied
to a reference picture ("(as in <Picture 2>)"). Tag chips above the prompt insert the model's reference tags at the cursor: H3
`<Picture N>` (+ "Subject N" labels), Klein `<ref_image_N>` / `<obj_N>`, Qwen edit `Picture N`.

**Wildcards:** `{red|green|blue}` in any text field picks one option at random for every run, so a
batch of 4 gets 4 different picks. Options can be empty (`{rainy |}`) and nest (`{a {big|small} dog|a cat}`);
braces without a `|` are left as they are. History shows the prompt that actually ran; **Edit** brings
back the wildcards, **Run again** repeats the same picks. On a tablet the text popup has keys for them:
**{ }** starts a group (or wraps the selected text as its first option), **|** adds an option, and
**}→** jumps past the end of the group.

**Shots** (the bar above the groups) save the whole template: the prompt and its builder parts, the
images and crops, LoRAs and every setting. ◀ ▶ load the previous/next shot (Undo brings back what you
had), 💾 saves over the loaded one, ＋ saves a new one, 🗑 deletes it, ↺ goes back to the template's own
prompt and settings (the tablet otherwise keeps what you last typed, even after the template file
changes). They're per workflow and stored on the server.

**Presets** sit at the top of each settings group (Seed, Sampler, LoRAs, Turbo LoRA, size…) and keep
only that group's numbers and choices, not prompts or images: ◀ ▶ cycle, 💾 save over the one shown, ＋ save new, 🗑 delete. The first entry is always the template's
default. A save is for this workflow, this model, or everywhere; model and everywhere saves match by
node type + input, so a KSampler or LoRA-stack save also turns up in other templates using them.

While a run is going, the strip under the progress bar shows its stages (loading models, preparing
images, encoding prompt, sampling, decoding, saving) with step counts and times. Drag the bar between
the preview and the settings to resize them (double-tap resets).

**Queue** (top bar): running and waiting jobs with elapsed time and an ETA from recent runs of the
same template, Stop/Cancel, and recent run times. History shows how long each run took; **Replay &
edit** loads a run's settings (prompt and builder parts, fixed seed, images, LoRAs) into Generate,
and **Run again** re-queues it unchanged.

Every template gets an **Advanced** group: attention backend (sage from the launch flag, Comfy
Kitchen INT8, or plain PyTorch), live preview type for video, and Veda sparse attention for H3.
These are inserted in front of the sampler at run time; templates don't need extra nodes.

Seeds get Random / Fixed / +1 modes automatically (any `seed` or `noise_seed` input).
Without an explicit order number, groups are ordered prompts → images → LoRAs → sampler →
size → model loaders.

**A typical image-to-video template** might tag:
`@1 Prompt`, `@2 Negative`, `@3 Start frame` (LoadImage), `@4 LoRAs` (LoraLoaderModelOnly after the
UNet loader), `@5 Sampler [seed,steps,cfg]`, `@6 Video [width,height,length]` (the image-to-video
latent node), and maybe `@9 Model` on the UNet loader if you switch high/low-noise models.

If a template looks wrong, open a generation in History → **Workflow JSON** and drag it into
desktop ComfyUI. It's the exact graph that ran, with LoRAs expanded.

---

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
python3.12 -m venv ~/Programs/comfydeck-voice/.venv
~/Programs/comfydeck-voice/.venv/bin/pip install torch torchaudio torchvision --index-url https://download.pytorch.org/whl/cu128
~/Programs/comfydeck-voice/.venv/bin/pip install "audio-separator[gpu]" qwen-tts faster-whisper soundfile audioread "av<16"
# if a dependency swapped torchvision for a CPU build ("operator torchvision::nms does not exist"):
~/Programs/comfydeck-voice/.venv/bin/pip install --force-reinstall --no-deps "torchvision==0.26.0+cu128" --index-url https://download.pytorch.org/whl/cu128
```

(`av<16`: faster-whisper 1.2 breaks on PyAV 19. Whisper finds the CUDA libraries torch put in the venv; `app/voice.py`
adds them to `LD_LIBRARY_PATH`.)

Models download on first use into `~/Programs/comfydeck-voice/models` (separation ~0.2–0.9 GB each, Whisper
large-v3-turbo ~1.6 GB, Qwen3-TTS ~4.5 GB). `DECK_VOICE_HOME`, `DECK_VOICE_PY`, `DECK_TTS_MODEL` and
`DECK_WHISPER_MODEL` override the defaults. A run needs the GPU: it waits for an empty ComfyUI queue (it refuses
otherwise) and asks ComfyUI to unload its models first. Saved voices live in `data/voices/`.

Only clone a voice that is yours or that the speaker said you may use, and don't use it to pass as them.

## Layout

```
app/main.py        API routes, websocket fan-out, saving outputs, reconcile loop
app/comfy.py       ComfyUI HTTP + websocket client
app/templates.py   @-tag parsing, field typing from /object_info, LoRA chain splicing
app/imageprep.py   crop, megapixel cap, snap to multiple-of-N, video/gif frame grabs
app/db.py          SQLite: projects + generations (params, exact workflow, parent lineage)
app/audioedit.py   sound with ffmpeg: extract, the Sound tab's mixdown, laying a sound on a clip
app/voice.py       the voice tools' jobs and saved voices; voice/worker.py runs in its own venv
web/               the tablet UI (vanilla JS, no build step)
web/ui.js          shared UI kit: h(), api(), toasts, sheets, overlays and the widgets every panel uses
                   (button, iconBtn, seg, field, section, numSlider, rangeField, propNum, mediaCard, cycleBar…)
web/app.js         Generate, Editor, Video, Board, History; web/scene.js the 3D tab (loaded on demand)
web/sound.js       the Sound tab; web/compare.js the Board's compare view
web/app.css        styles; colours, radii and shadows come from the tokens at the top
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
deleting a generation also deletes ComfyUI's copy (only if it's the same size as ComfyDeck's), and
one-off crop files unused for 30 days are cleared from its input folder. `DECK_COMFY_DIR=""` turns
that off.

Images you upload, edit or draw are remembered with the project that was open, so the image picker
shows that project's own images and generations first.

### Working on the UI without the GPU

```bash
.venv/bin/python dev/mock_comfy.py --port 8199 --animated
COMFY_URL=http://127.0.0.1:8199 DECK_DATA=/tmp/deckdev ./run.sh
```

The mock can run beside the real ComfyDeck: use another port and data folder (e.g.
`--port 8191`, `DECK_DATA=/tmp/deckdev`) and nothing touches the live one.

### Debugging the websocket

The ⋯ button shows message counts plus any messages ComfyDeck doesn't handle. Use it to see
what a custom node sends. Binary previews are decoded by finding the JPEG/PNG/WebP header in
the payload, so differently framed preview messages still work.

---

## API (for scripting)

| | |
|---|---|
| `GET /api/templates` | templates with their fields |
| `POST /api/generate` | `{template, values: {"<node>.<input>": v}, batch, project_id, parent}`. A seed of `-1` means random |
| `GET /api/generations?project_id=` | history |
| `POST /api/generations/{id}/to-input` | `{index, frame: "first"\|"last", mp, multiple}` → ComfyUI input name |
| `POST /api/upload` | multipart `file`, `mp`, `multiple`, `crop` (`{"x","y","w","h"}` as fractions) |
| `POST /api/interrupt` | `{prompt_id}` stops that run (interrupts it if running, removes it if waiting, else nothing); without it, whatever is running |
| `GET /api/jobs` | running and waiting jobs with timings (the running one with its stages), plus recent runs |
| `WS /ws` | ComfyUI's own messages plus `deck_generation` updates; binary = previews |
