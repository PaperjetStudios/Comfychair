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
removes their generations (it asks first).
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
joint (Rotate), or drag a hand or foot (Move) and the arm or leg follows (IK). Pose presets (stand, walk,
run, sit, point, wave…) and Mirror are in its settings, and a pose is keyed like anything else.
**Render pose video** draws the posable people as OpenPose stick figures for a pose control video.
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

## Layout

```
app/main.py        API routes, websocket fan-out, saving outputs, reconcile loop
app/comfy.py       ComfyUI HTTP + websocket client
app/templates.py   @-tag parsing, field typing from /object_info, LoRA chain splicing
app/imageprep.py   crop, megapixel cap, snap to multiple-of-N, video/gif frame grabs
app/db.py          SQLite: projects + generations (params, exact workflow, parent lineage)
web/               the tablet UI (vanilla JS, no build step)
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
