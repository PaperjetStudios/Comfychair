# ComfyDeck review notes (2026-10-24)

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
- **Connection banner**: tells "can't reach ComfyDeck" apart from "ComfyUI not connected". `api()`
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
  the same size as ComfyDeck's copy, and never outside the output folder.
- **Old crop files are cleared**: `crop_*.png` in `ComfyUI/input/comfydeck/` that haven't been used
  for 30 days are removed at startup. Replaying a cropped run older than that needs the crop redone.
- **Outputs are streamed to disk** while saving (`comfy.download`) instead of held in memory.
- ComfyUI's folder defaults to `../ComfyUI` next to ComfyDeck; `DECK_COMFY_DIR` overrides it, and
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
