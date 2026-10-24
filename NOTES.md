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
- Unit tests: 13 pass.
- API against the mock on :8191: scoped stop of running, queued and finished runs; lost-run marking
  after a simulated ComfyUI restart (about 36 s); token gate for http and the websocket; 400 on bad
  numbers.
- Headless Chrome, tablet viewport (31 checks): live preview; reload mid-run picks the run back up
  and shows the result; a second device's run doesn't take over; Stop doesn't touch the other
  device's run; the back gesture closes sheets and the sketch (asks with strokes); history adds one
  card without redrawing; your own Stop; the banner when the server goes down and comes back; Undo
  for Editor Clear all. No JS errors.

## Still open
- **Not tried on a real tablet**: whether the keep-awake video holds the screen on your device,
  notifications (need HTTPS and the CA installed), and the feel of the bigger touch targets.
- **ComfyUI's own output copy** (`output/comfydeck/<project>/`) isn't deleted with a generation:
  ComfyDeck doesn't know ComfyUI's output path. `crop_*.png` in ComfyUI's input folder also builds up.
- **`comfy.view` holds whole videos in memory** while saving outputs. This is fine at current sizes.
