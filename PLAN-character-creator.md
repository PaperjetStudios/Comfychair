# Implementation plan: the character creator

A plan to hand to an LLM coding agent, one phase per session. Checked against `main` at `d04cdb0` (2026-11-06).
Each phase stands on its own, can be merged on its own, and ends with tests and a README update. **Do the phases in
order**: later ones assume the earlier ones. Phase 8 is a backlog of what the characters are then used for, not a
phase to build blind.

**What this is for.** Photos and references of a character arrive from different times (hair, clothes and faces
differ), and getting from them to a set of references a shot can use is a long chain of hand steps today: pick a
photo, make a 3D object or a splat, turn it in the 3D tab, render depth, run `deck-h3-ctrl2v`, scrub the clip and
mark angles, upscale and cut out, lay the pictures out as a sheet, then pick the right one for the shot's camera.
The character creator runs that chain by itself and stops at the few points where a look is a judgement call.
Characters aren't only people: the same chain serves animals, props and vehicles.

**What exists already (build on it, don't duplicate it).**
- `web/char-model.js`: a character with several **looks** (each its own words, main picture, `views`, `sheet`,
  `expressions`, `model`, `rig`), an ordered `media` list with roles (`MEDIA_ROLES`: face, body, ref, edit,
  expression, sheet, model, rig, splat, clip), candidates (`cands`) and pending slots (`vpending`). Saved as one
  `characters` document per character (`app/store.py` KINDS).
- `web/characters.js` + `web/charstage.js`: the Story tab's Characters view, **To review** (`runsFor`,
  `setWorkingFor`, `keepCand`, `dropCand`, `reviewRow`), `makeViews` (`deck-krea2-identity`), `makeExpressions`,
  the sheets (`SHEETS` in charstage.js: `deck-h3-charsheet*`), Make a 3D object, Rig. `web/charsend.js`: Use as… →
  a character.
- `web/cast.js`: `VIEWS` / `VIEW_KEYS` (front, three, side, back, face), `VIEW_PROMPTS`, `wantedView(shot)`,
  `refPicture(c, shot)`, `packPictures`, `castLines` (the looks in a prompt).
- `web/markviews.js` + `web/markview-math.js`: mark frames of a finished H3 clip as angles (`ANGLES`), each goes
  through `STEPS` (Upscale, De-light, Cut out) and lands as an input named `view-<angle>.png`; kept per run in the
  `view-marks` store kind.
- `app/looks.py`: `POST /api/looks/sheet` (views side by side on grey), `POST /api/looks/check` (DFN CLIP + hue
  match against a pack, `judge()` → score / drift), `GET /api/looks/status`.
- The 3D tab: objects from photos (`deck-3d-object` Pixal3D, `-trellis`, `-hunyuan21`, `-multi`, `-splat` Idol; the
  panel in `web/scene-import.js`, rules in `web/object-rules.js`), camera moves (`web/scene-camera.js` `MOVES`,
  `writeMove`), renders (`web/scene-export.js` `renderDepthVideo`, `renderColorVideo`, `renderPoseVideo`), rigs
  (`deck-autorig-human`, `deck-autorig-any`; `web/scene-rig.js`, `web/scene-skin.js`), the Mixamo-style posable figure.
- The table: frames and wires (`web/table-model.js`, `web/wire-rules.js`), a workflow per frame (`frame.make`,
  `web/make-panel.js` `runFrame`), chain runs and staleness (`web/chain-run.js`, `web/chain-rules.js`), a 3D frame's
  render pins (`web/frame-outs.js`), and the **story table** precedent: a table whose payload says `story: <id>` lays
  rows out and keeps a sidebar pane in step (`web/frame-story.js`, rules in `web/shot-rows.js`).
- Recorded actions (`web/actions.js`, `web/action-rules.js`): a saved set of runs played on frames or layers.

**Decisions taken (2026-11-08).**
- A character gets a **table of its own** (payload `character: <id>`), laid out as one row per stage, and a
  **character frame** on any other table that stands for it and puts its views and sheets out as pins.
- Variants are the existing **looks**. A new media role **detail** (a tattoo, a scar, a prop) carries a label.
- 3D stage: **run the default (TRELLIS.2), then try another and compare** (Idol splat, Hunyuan 2.1, Pixal3D; multi-view
  when two or more sides are there). Pixal3D hasn't worked on this box yet; Hunyuan is hit or miss.
- Gates that stop by default: **after the look grouping** and **after the views**. Everything else runs on. Per
  character, any stage can be made a gate.
- The plain H3 charsheet stays as the **quick sheet** path when no 3D is wanted.
- **Elements** (2026-11-08): a character can hold parts that are things in their own right: a backpack, a hand, a
  helmet, a sword. An element is a character document of its own (`c.partOf = { character, look? }`, usually
  `kind: 'object'`), so it has its own references, 3D object, turntable, views and sheets through the same chain with no
  new machinery, and it shows on its parent's table as a row of character frames (one per element, each opening its own
  table). A single picture that needs no chain of its own stays a **detail** media item. The Story tab's cast lists
  elements under their parent, not as characters of the story.
- Work happens on branch `character-creator`. Uncommitted work on the PC at the time was small; merge conflicts
  are expected and are dealt with at merge time.

---

## 0. Rules for every phase (read first)

Everything in `PLAN-3d-mocap-shots.md` §0 applies (imports with `from`, no `innerHTML`, `h()` and the shared controls,
one key engine, every edit ends in `save()`, old documents load unchanged, templates in `templates/*.json` with
`@N Label` titles, custom nodes in `comfy_nodes/deck_*`, tests in `tests/`, README and NOTES, commits in the repo's
style, verify in a browser against `dev/mock_comfy.py`). And `CLAUDE.md`. On top of those:

- **A character document is the record.** Everything the pipeline knows (stage, gates, which run made which view,
  scores) lives on the `characters` document, in the look (`look.pipe`, phase 3), never only in the browser. A
  reload, or another device, picks it up from the document and History (as `story.js` `catchUp` does for shots).
- **Rules without DOM first.** Every new decision (which frames a character table needs, which view a shot wants,
  which stage is next, what a turntable's marks are) is a pure module with a `tests/*.test.mjs` file, then the DOM
  module drives it. Follow `shot-rows.js` / `frame-story.js` and `frame-outs.js` as the pattern.
- **Nothing runs on the card outside `comfy.queue`** or `gpu.card`. The pipeline queues runs through
  `make.js` `queueRun` / `make-panel.js` `runFrame` like everything else and waits for them to land. One pipeline
  step at a time on this box; several characters queue one after another.
- **Files made for a character are the character's.** A per-shot sheet, a cutout, a tagging cache: name it with
  `storage.tag(source)-` or record it on the document so `storage.attachments` / `storage.drop_caches` cover it, and
  add the case to `tests/test_storage.py`.
- **Old characters, old looks, old view keys keep working.** `fromDoc` in `char-model.js` upgrades; nothing reads a
  new field without a default.
- **Each phase's "Done when" is checked in a browser** with the mock, screenshots in the PR, no console errors, on a
  tablet viewport as well as desktop.

---

## Phase 1: a character on the table (frame kind + character table)

**Goal.** A `character` frame kind on any table, standing for one character; opening it goes to that character's own
table, laid out as rows (one per stage) of ordinary frames; its views and sheets are pins other frames' Make inputs can
take, like a 3D frame's renders.

### 1.1 Data

- `web/table-model.js`: `KINDS` gains `'character'`; `KIND_LABEL.character = 'Character'`; `CHAR_DOC = 'characters'`.
  **Not** in `DOC_KIND`: a character frame stands for a character and never owns it, so none of the generic frame code
  (delete → trash the document, rename, stills, the server's `_owned_docs`) touches the character. Not in `HAS_OUTPUT`
  (its output is pins, not a size). `migrateTable` already keeps unknown fields; `newFrame('character', rect, { doc:
  <character id>, label: <name> })`. *(done on `character-creator`)*
- The table payload may say `character: <character id>` (a **character table**), next to the existing `story`. A
  character table's frames carry `char: { stage, slot?, look? }` the way story frames carry `story: { scene, shot }`:
  - `stage`: `refs` | `canon` | `object` | `turn` | `views` | `sheets` (phase 3 adds `review` badges, not a stage)
  - `slot`: what the frame holds for that stage (`'model'`, `'depth'`, a view key, a sheet name)
  - `look`: the look id (every row set belongs to one look; the table shows the active look's rows, phase 1 shows one
    look and the look switcher comes with phase 2)
- `web/frame-outs.js` is a 3D frame's; a character's pins are their own pure module **`web/char-outs.js`**
  *(done)*: `pinsOf(c, lookId?)` → `[{ id, kind: 'image', label, input }]`: `main`, each kept view (`view:<key>`),
  `sheet` and the other sheets (`sheet:<media id>`), each expression (`expr:<key>`), each `detail` media item
  (`detail:<media id>`). The character document changes elsewhere, so the frame keeps a copy: `frame.pins`, written by
  `mirrorPins(frame, c)` when the character changes (frame-character.js does this) and read by `charPins(frame)` /
  `charPin(frame, id)`. `wire-rules.js` `outKinds` / `outPins` / `outPin` / `pinLabelOf` dispatch by frame kind
  *(done)*, and `frame-source.js` `outImage` / `outThumb` resolve a character pin to its input *(done)*; a wire from a
  character pin keeps `wire.out = pin id` as today, so a view made again goes down the wires already plugged in.
- **Elements**: `char-model.js` gains `partOf: { character, look? } | null` (kept by `fromDoc` / `payloadOf`;
  `isElement(c)`; `elementsOf(list, c)` the elements of a character, in `media` order of their `partOf` or by name).
  An element is made from its parent's table (**+ Element**: a name and a kind, phase 7's kinds; `object` until then)
  or by **Use as… → Element of…** on any picture. `characters.js` `loadCharacters` keeps elements in the same list;
  `castSection` and `charstage.js` show them under their parent and leave them out of `mentioned` / `castLines`
  unless the shot names them. Deleting a parent asks about its elements (delete too, or keep as characters).
- **`web/char-rows.js`** (pure, like `shot-rows.js`) *(done)*: `STAGES` (`refs`, `elements`, `canon`, `object`,
  `turn`, `views`, `sheets`) and their labels; `wanted(c, lookId, { elements })` → the frames a character table should
  have for that look (`[{ stage, slot, kind, label, input? | doc?, item? }]`); `planReconcile(want, frames, { look })`
  → `{ missing, missingNotes, remove, copies, renew }`; `stageFrame` / `stageNote` make the frames (`frame.char = {
  stage, slot, look, item?, input?, auto }`); `charLayout(frames)` lays each stage's note then its frames in the table's
  own order (`table-model.js` `rowLayout`). Phase 1 fills **References** (an image frame per media item of role face /
  body / ref / edit / detail, its document an edit with that picture as the one layer, read-only until phase 2),
  **Elements** (a character frame per element, opening that element's own table) and **Views** / **Sheets** (an image
  frame per kept view and sheet). Every stage has its note from the start; the other rows fill with their phases.

### 1.2 Table and sidebar

- `web/table.js` draws a character tile: the main picture (or the first `pics`), the name, the active look's name as a
  chip, and the pins down its right edge as 3D frames show theirs. Double-tap / **Open** goes to the character table
  (made on first open, payload `{ ...blankTable(), character: c.id }`, as `frame-story.js` makes a story's); the table
  picker lists character tables under the character's name; **Back** returns to the table it came from (keep the id on
  the way in, as the story table does).
- **`web/frame-character.js`** (DOM, like `frame-story.js`): keeps a character table and its character in step: the
  character changed (a picture added in the Story tab, a view kept) → rows re-laid; a frame deleted on the table takes
  that media item out of the character (Undo brings both back); a reference frame duplicated is a copy of the picture.
  The sidebar gets a **Character** pane: the existing side panel from `charstage.js` (extract `characterPanel(c)` from
  it so both places use one), with the look's words, looks, voice and To review.
- **+ Add → Character** on any table: pick a character of the project (or New) → a character frame. **Use as… →
  Character** stays as it is (`charsend.js`).
- Settings: nothing new.

### 1.3 Server

- `app/store.py`: a table whose payload says `character` is owned like a story table (`_owned_docs` lists the
  reference frames' edit documents). Deleting a character (`DELETE /api/store/characters/<id>`) deletes its table and
  the frames' documents (the pictures stay with the character's media rule: `storage` already refuses deleting a picture
  a character uses). Add the case to `tests/test_storage.py`.

### 1.4 Tests and done-when

- `tests/char_outs.test.mjs`: pins for a character with no pictures (none), one main picture, views, a sheet, two
  looks (the active look's pins; `withLook`), a view removed (pin gone, wires to it are dropped by `migrateWires`).
- `tests/char_rows.test.mjs`: rows for an empty character, one with five references and three views, missing / extra
  after a view is kept, layout order left to right.
- `tests/table_model.test.mjs`: a `character` frame survives `migrateTable`; `foreignFrames` on `characters` documents.
- `tests/wire_rules.test.mjs`: a wire from a character pin plugs an image field; `pinLabelOf` names the view.
- **Done when:** a character frame can be added to the main table, wired into a Make frame's picture field, and a run
  reads the view it points at; opening it shows the character table with the References and Views rows; adding a
  picture in the Story tab adds a frame to the row; deleting a reference frame removes the picture from the character
  and Undo brings both back; on a tablet the tile and the pins are reachable by touch.

---

## Phase 2: references in, looks proposed, details

**Goal.** Drop photos on the References row; the server tags each (angle, elevation, lighting, a look embedding) and
proposes which belong to which look; the first gate confirms it. A `detail` role carries a label into prompts.

### 2.1 Tagging (`app/charrefs.py`, new; mount in `app/main.py` beside `looks.router`)

- `POST /api/characters/tag {pictures: [input names], project_id}` → per picture `{ angle: 'front' | 'three' |
  'side' | 'back' | null, side: 'left' | 'right' | null, elev: 'high' | 'eye' | 'low' | null, light: 'flat' | 'hard'
  | 'dark' | null, sharp: number, box: [x,y,w,h] | null, vec: [..], hist: [..] }`.
  - Angle and elevation from DWPose keypoints of the largest person (the detector `looks.py` already starts:
    `DECK_LOOK_DET`; the YOLOX + DWPose files it uses are ComfyUI's): shoulders' apparent width over hip width and
    the nose's side of the shoulder midpoint give the yaw bucket; the eye-to-chin over face height gives the pitch
    bucket. With no person (an animal, a prop): `angle` null, the box from BiRefNet's alpha (`deck-cutout-image` is a
    run; here use a plain threshold on the picture's own alpha if it has one, else null). Don't guess.
  - `light`: luminance histogram spread; `sharp`: Laplacian variance of the face crop (or the whole box).
  - `vec` and `hist` from `looks.py` `scorer().embed` and the hue histogram it already computes.
  - Results cached as `storage.tag(input)-tags.json` beside the character's other caches (`storage.drop_caches`).
- **Grouping** (`charrefs.group(tags) → [[input names]]`): agglomerative on cosine of `vec` with a hue-match veto
  (`looks.hue_match` below `COLOUR_MIN` splits), threshold `DECK_LOOK_GROUP` (default 0.82). Pure Python, tested.

### 2.2 Character model

- `web/char-model.js`: `MEDIA_ROLES` gains `['detail', 'Detail']`; `PHOTO_ROLES` includes it; an item may carry
  `label` (already a field) and `tags` (the server's). `cleanItem` keeps `tags` when it's an object. A **look proposal**
  is not stored: it's applied as `addLook` + moving items' `look`.
- `web/cast.js` `castLines`: a look's detail items add `, with <label> (as in <Picture N>)` using the model's picture
  tag (`pictureTag`), after the look's words; `packPictures` appends the detail pictures after the views (they are
  references too). Tests in `tests/cast.test.mjs`.

### 2.3 UI

- References row: **+** opens the picker (several), **Tag** runs tagging on untagged items (progress in the row's
  note), each tile shows its role and tag chips (angle · elevation · lighting), a tap on the role cycles it, long-press
  / pencil sets a detail's label.
- **Gate 1 — Looks** (`web/look-groups.js`, a sheet opened from the row's note or by the pipeline, phase 3): the
  proposed groups as columns of tiles; drag a tile between columns; name a column; **Keep** makes the looks (`addLook`,
  items' `look`), the first column stays the look the pictures were in; **One look** collapses all. The sheet shows
  the look's words box so the user can write them while they look at the pictures.
- The character table shows one look at a time: a look switcher in the Character pane (reuse the Story tab's) and the
  rows re-lay for it.

### 2.4 Tests and done-when

- `tests/test_charrefs.py`: yaw / pitch buckets from synthetic keypoints (front, 3/4 left, side, back, high, low);
  grouping on synthetic vectors (two clear clusters; one cluster with a hue split; a single picture).
- `tests/char_model.test.mjs`: detail role round-trips, tags kept, upgrade of an old document.
- `tests/cast.test.mjs`: a detail line in `castLines`, detail pictures in `packPictures`.
- **Done when:** twelve mixed photos dropped on the row are tagged and proposed as two looks; the user moves one,
  names both, keeps; the Story tab shows the same two looks with the right pictures; a detail labelled "scar over the
  left eyebrow" appears in Redraw's prompt and its picture in the references.

---

## Phase 3: the pipeline runner and its gates

**Goal.** One **Prepare** button runs the chain for a look, stage by stage, through the table's frames and wires, and
stops at gates. It survives reloads and runs for several characters in turn.

### 3.1 Data (`web/char-model.js`, `look.pipe`)

```
look.pipe = {
  v: 1,
  kind: 'person' | 'creature' | 'object' | 'vehicle',         // phase 7 reads it; phase 3 stores 'person'
  gates: { looks: true, canon: false, object: false, turn: false, views: true, sheets: false },
  stage: 'refs' | 'canon' | 'object' | 'turn' | 'views' | 'sheets' | 'done',
  state: 'idle' | 'running' | 'waiting' | 'failed',            // waiting = at a gate
  runs: { canon: [gen ids], object: [gen ids], turn: [gen ids], views: { <view key>: [gen ids] }, sheets: [gen ids] },
  settings: { objectTemplate: 'deck-3d-object-trellis', turntable: 'eye', steps: { up: true, delight: false, cut: true }, retries: 2 },
  error?: string
}
```

`blankLook` fills `pipe` with the defaults above; `fromDoc` upgrades.

### 3.2 Rules (`web/char-pipeline-rules.js`, pure)

- `nextStage(look)`: the stage after the current one that has work (a look with a kept model skips `object`; a look
  whose views are all kept skips `views`).
- `gateBefore(look, stage)`: whether the pipeline stops before `stage`.
- `staleFrom(look, change)`: after a reference is added, a canon picture changed or a model replaced, which stage to
  go back to (the same idea as `chain-rules.js` `staleInfo`: what downstream read it).
- `planFor(look, c)`: the frames and wires the next stage needs on the character table (phase 1's `char-rows.js` gives
  the rows; this gives what to run: `[{ frameId, template, fields }]`).
- `canonPick(items)`: the best canon reference from the tags: front, eye level, sharpest, flat light; ties by order.

### 3.3 Runner (`web/char-pipeline.js`, DOM)

- `prepare(c, lookId)`: sets `state: 'running'`, then loops `nextStage` → `planFor` → runs through `chain-run.js`
  `runChain` on the stage's frames (every run goes through `make-panel.js` `runFrame`, so through `queueRun` and
  `comfy.queue`), waits for them to land, records the gen ids in `pipe.runs`, hands results to To review
  (`characters.js` `setWorkingFor` with the slot, `keepCand` on an auto-keep), then either stops at a gate (`state:
  'waiting'`, a toast and a Review badge) or goes on. **Resume**: on load, a look in `running` with runs that have
  finished in History is settled (`catchUp`, as `story.js` does) and the loop continues; one in `waiting` shows its
  gate.
- Stage **canon** (phase 3 builds this one): `canonPick`; then the saved recorded-actions set named **Canon** when one
  exists (default: Face restore when a face is found, Cut out), played on the canon frame through `actions.js`; the
  result is the look's `main`. With `gates.canon` the user confirms or picks another.
- **Prepare** on a character frame's menu, in the Character pane, and on the cast's line-up for several (a queue in
  `char-pipeline.js`: one look at a time, next starts when the one before is `waiting` or `done`).
- The stage notes on the character table show state ("Running · depth render", "Waiting for you · 3 views to
  review", "Failed · <error>"); the table's pending badge on the running frame (`edit:pending`) works as it does for
  chains.

### 3.4 Tests and done-when

- `tests/char_pipeline_rules.test.mjs`: `nextStage` through a fresh look, a look with a model, with kept views; gates
  on and off; `staleFrom` for a new reference, a changed canon, a replaced model; `canonPick` on tagged items.
- **Done when:** Prepare on a look with tagged references runs canon and stops at the Looks gate when `gates.looks`,
  else goes on to the stages phases 4–5 add (in phase 3 alone it ends after canon with `stage: 'object'`,
  `state: 'waiting'`, since there is no object stage yet: say so in the note); a reload mid-run resumes; two
  characters queued run one after the other.

---

## Phase 4: 3D, turntable, exact views

**Goal.** From the canon picture (and sides when there are some) make a 3D object with the default model and, on
request, the others to compare; put it in a scene with a turntable camera whose angles are known; render depth; run
H3 control-to-video with the look's references; read the views straight off the turntable's marks and make the
pictures.

### 4.1 Object stage

- Templates (all present): default `deck-3d-object-trellis`; alternatives `deck-3d-object-splat` (Idol),
  `deck-3d-object-hunyuan21`, `deck-3d-object` (Pixal3D); `deck-3d-object-multi` when the look has two or more
  tagged sides (front + side / back): fill its Front / Left / Back / Right from the tags (`object-rules.js` has the
  slot logic the panel uses: call it, don't copy it). **Check the fields' names on the live templates before wiring
  them** (`comfy.object_info()`, the `@N` titles in each JSON).
- The runner queues the default; the result lands as the look's `model` (or `splat`) through the existing object
  flow (`scene-import.js` `objectTarget` lands a run in a 3D frame: the character table's **Object** row has one 3D
  frame per look, `char: { stage: 'object', slot: 'model' }`). **Try another** in To review runs one more template
  on the same pictures; **Compare** (the Board's compare, two tiles) shows two models' turntable colour renders side by
  side once phase 4.2 has run on both; **Keep** picks one, the others stay in the character's media as versions
  (`char-model.js` already keeps model versions).
- `PLAN-gpu-recheck.md` §1 is a dependency: Pixal3D on the GPU hasn't been proven on this box. Phase 4 doesn't
  depend on it (TRELLIS.2 is the default) but its "try another" does; note the state in the README table.

### 4.2 Turntable (`web/turntable.js`, pure; `web/scene-turntable.js`, DOM)

- A turntable is a camera on an orbit around the object's centre at a chosen elevation, with **holds**: it stops at
  each angle for `hold` frames so H3 has still frames to copy and the marks fall on clean frames. `turntable(preset,
  { fps: 24, stops, hold, travel, size })` → `{ keys: [...camera keys for scene-data.js], marks: [{ frame, angle,
  elev, label }], frames }`. Presets: **Eye level** (8 stops every 45°, elevation 0°), **High angle** (+30°: looked
  down on; the sitting case), **Low angle** (−20°), **Head** (eye level, the camera close on the head, 8 stops), **Top
  and detail** (for objects: front, three-quarter, high angle, one close detail), and **Custom** (stops, elevation).
  Angles use `markview-math.js` `ANGLES` labels so the views' files are named the same way they are today. Writes
  through `scene-camera.js` (`writeMove` with `orbit-left` and `pedestal` / `tilt` for the elevation, the holds as
  flat segments) and `scene-data.js` `setKey`; no second key system.
- The **Turn** row: one 3D frame per look (`slot: 'turn'`) with the object placed (the Object row's model layer,
  fitted and standing, `scene-import.js` does the fitting) and the turntable keys; its render pins carry the depth
  video (`frame-outs.js` as today). The runner renders depth with `scene-export.js` `renderDepthVideo` (Depth from
  **3D shapes** for a mesh; a splat gets **The picture**, since a splat is only a box in shape depth — the README
  says so). Then a video frame (`slot: 'h3'`) with `deck-h3-ctrl2v` (or `-hold` when `settings.hold`), the depth
  video wired from the pin, the look's references (canon first, then the tagged sides, then detail pictures) in its
  reference slots, a prompt from the look's words plus a fixed turntable line (grey studio, even light, the figure
  turning, no camera move but the orbit), length = the turntable's frames on H3's grid (17k+5 at 24 fps:
  `turntable()` rounds the hold so the total fits; the maths is in `h3upscale.py` for refine — move the grid
  function somewhere both can import, or copy the one-liner with a comment).
- **Reuse across looks**: the depth render belongs to the model, not the look. A second look on the same model
  (`look.model` equal) finds the Turn frame's depth take and runs only the H3 step. `char-pipeline-rules.js`
  `planFor` decides this.

### 4.3 Views from marks (no scrubbing)

- `markviews.js` today asks the user to scrub and mark. Add `marksFromTurntable(g, marks)`: the `view-marks` document
  for the H3 run is written from `turntable().marks` (frame → label), then `makeAll` runs the ticked `STEPS` on each,
  landing inputs named `view-<label>.png` as today; the pipeline reads `pipe.settings.steps`. Keep the manual sheet
  for a clip that didn't come from a turntable.
- View keys widen: `cast.js` `VIEW_KEYS` stays the five canonical keys for the old code paths; a look's `views` may
  also hold generalised keys `a<angle>e<elev>` (e.g. `a45e30`), and `char-model.js` maps the canonical ones onto them
  (`front` = `a0e0`, `three` = `a45e0`, `side` = `a90e0`, `back` = `a180e0`, `face` = the Head preset's `a0e0`).
  `viewLabel` reads both. Old documents are untouched.
- **Gate 2 — Views** (default on): the views land in To review with their angle labels; keep / make again (a
  make-again re-runs only that mark's steps, or, with **Again from H3**, the H3 step with a new seed) / throw away.

### 4.4 Tests and done-when

- `tests/turntable.test.mjs`: each preset's marks (count, angles, elevation), holds land on whole frames, total
  frames on H3's grid, keys are monotonic in frame, the Custom preset with 12 stops.
- `tests/markviews.test.mjs`: marks written from a turntable make the same files `setMark` would.
- `tests/char_pipeline_rules.test.mjs`: a second look on the same model plans only the H3 step.
- **Done when:** on the GPU, Prepare on a look with a canon picture makes a TRELLIS.2 object, a turntable depth video,
  an H3 clip, and eight cut-out views that land in To review with the right labels; **Try another** on the object adds
  an Idol splat and Compare shows both turntables; a second look reuses the depth and finishes in the H3 step's time
  alone. Times and VRAM for each step go in the README table.

---

## Phase 5: machine review and sheets

**Goal.** Views that drift are re-made before the user sees them; the sheets are assembled from approved views; the
quick sheet path joins the same review.

### 5.1 Scoring

- After each view lands, the runner calls `POST /api/looks/check` with `{ image: { input }, characters: [{ id,
  pictures: <the look's references> }] }` (the route exists). `looks.py` `check` gains `mode: 'person' | 'cutout'`:
  `cutout` embeds the whole picture's non-transparent box instead of each detected person (for creatures and props,
  phase 7; phase 5 passes `person` for kind person and `cutout` otherwise).
- Below `DECK_LOOK_MIN` (or `pipe.settings.minScore`), the runner re-runs that mark's **Again from H3** step with a new
  seed up to `settings.retries` times and keeps the best-scoring one; the others go to the candidates list with their
  scores so the user can still pick one. Scores show on the To review rows (`reviewRow` extra) and on the view tiles.
- **Confidence-gated gate**: with `gates.views === 'auto'`, the gate is skipped when every view scored above
  `minScore + 0.05`; otherwise it stops. (`gates.*` becomes `true | false | 'auto'`; rules in
  `char-pipeline-rules.js`.)

### 5.2 Sheets

- The **Sheets** row: one image frame per sheet kind the look wants: **Full** (the orbit's 8), **Bust** (front, side,
  back, face front, face three-quarter from the Head turntable when it ran), **Head** (the Head preset's 8), **Object**
  (front, three-quarter, high, detail), and **Expressions** (`makeExpressions`, as today, from the kept face). Assembled
  with `POST /api/looks/sheet` from the kept views (`char-outs.js` lists which); the look's `sheet` stays the Full one
  for the old paths, and the others are media items of role `sheet` with a `label` (`char-outs.js` makes a pin each).
- **Quick sheet**: Prepare with `settings.objectTemplate: 'none'` skips Object and Turn and runs the matching
  `deck-h3-charsheet*` / `deck-h3-objectsheet` template on the canon picture; its sheet frames (`h3upscale.py`
  `sheet_marks` knows them) are written as marks and go through 4.3's steps and 5.1's scoring like turntable views.
  So one review flow for both paths.

### 5.3 Tests and done-when

- `tests/test_looks.py`: `judge` in `cutout` mode on a synthetic picture with alpha; `check` refuses a mode it doesn't
  know.
- `tests/char_pipeline_rules.test.mjs`: retries stop at `retries`; best-of selection; `'auto'` gate skipped / held.
- **Done when:** a look whose H3 clip turned a back view into a face gets that view re-made twice and the best kept;
  the sheets row fills with Full, Head and Expressions; a character prepared with the quick sheet path lands the same
  kinds of views and sheets; the Story tab's Redraw sees the new sheets as references.

---

## Phase 6: the right references for a shot

**Goal.** A shot gets the views its camera wants, worked out from the real camera when there is one, stitched into a
per-shot sheet, shown and overridable.

### 6.1 Rules (`web/ref-pick.js`, pure; `cast.js` `refPicture` calls it)

- `pickRefs(c, look, shot, { camera })` → `{ views: [view keys in order], details: [input names], why }`:
  - `camera`: `{ azimuth, elevation, distance }` of the shot's camera relative to the character, when the character is
    a layer in the shot's 3D scene (a rigged / skinned / model layer whose `char` field names the character: phase 6
    adds `layer.char = { id, look }` when a character's model is placed from the character table or the Add list).
    `web/scene-geom.js` (new, pure): `relativeCamera(cameraPose, layerPose)` from `scene-data.js` `current()` at the
    frame. Without a scene, fall back to `wantedView(shot)` (text), then to `front`.
  - Picks the nearest kept views by angular distance (two or three: the nearest, and the neighbours on each side when
    the shot is a close-up), the Head views for a close shot, detail pictures the shot's text names (`@scar` or the
    label's words) first. **Elements** the shot names (`@backpack`, or the element's name in the text) get the same
    pick on their own views at the same camera and join the references after their parent's; an element not named
    stays out unless its parent's look lists it as always worn (`look.wears: [element ids]`, phase 6 adds it).
- `sheetFor(picks)`: the per-shot sheet is `POST /api/looks/sheet` on the picked views, cached by the sorted names
  (`storage.tag`), so the same picks don't stitch twice.

### 6.2 UI

- Redraw / Video **Reference pictures** (Story) shows the picks per character with the reason ("camera 40° left, 25°
  above") and a pencil to pick others; on the main table a character frame wired into a Make frame gets a pin **For
  this shot** whose picture is the per-shot sheet (`char-outs.js` adds it when the target frame has a camera: a
  3D frame upstream, or the shot's scene).
- Several characters: one sheet each, in `castLines` order; H3's reference slots fill in that order, and the prompt
  names them (`<Subject N> is the person in <Picture N>`), as the head sheet's README paragraph does.

### 6.3 Tests and done-when

- `tests/ref_pick.test.mjs`: camera straight on → front; 135° left, 30° up → back 3/4 left + high views when kept,
  else the nearest eye-level ones; a close shot → head views; text fallbacks unchanged from `cast.test.mjs`.
- `tests/scene_geom.test.mjs`: relative camera for a few poses (in front, behind, above).
- **Done when:** a shot whose scene has the character's rigged model with the camera above and behind gets the back
  3/4 high view and its neighbours, stitched, and the Redraw result passes the look check; changing the camera and
  re-running Redraw changes the pick; the override sticks for that shot.

---

## Phase 7: creatures, objects, vehicles

**Goal.** The same chain for anything that isn't a person.

- `char-model.js`: `c.kind` (`person` default; `creature`, `object`, `vehicle`), with a table **`web/char-kinds.js`**
  (pure): the angle set and default turntable preset (`object` → Top and detail; `vehicle` → Eye level 8 plus a
  high), whether face views and expressions apply, the default object template, the rigger (`deck-autorig-human` for
  people, `deck-autorig-any` otherwise), the look-check mode (5.1), the sheet kinds (5.2), the tagging mode (2.1: no
  DWPose; angle from the user or from the multi-view slots).
- `cast.js` `castLines`: a kind's words ("the dog in <Picture 1>", "the truck in …"); `VIEW_PROMPTS` get per-kind
  variants for the `deck-krea2-identity` path (`ALONE` is written for a person).
- UI: the kind on the New character sheet and the Character pane; the rows re-lay when it changes (`char-rows.js`
  reads the kind).
- Tests: `tests/char_kinds.test.mjs` (every kind has every field; `object` has no face views), `cast.test.mjs` (kind
  lines), `char_pipeline_rules.test.mjs` (an object skips the canon face steps).
- **Done when:** a product photo prepared as `object` makes a TRELLIS.2 model, a Top-and-detail turntable, four views
  and an Object sheet, with cutout scoring; a dog as `creature` gets eye-level views and `deck-autorig-any`.

---

## Phase 8: what the characters are then for (backlog, not specified)

These come after the chain works and depend on things not yet proven on this box. Each needs its own research note
before a plan. Pointers to what exists:

- **Drive a character with another clip's motion.** `deck-h3-drive` / `deck-ltx-drive` (DWPose from the clip as the
  control video) and `-posed` exist; mocap into the 3D tab (`app/motion.py`, SAM 3D Body, `PLAN-3d-mocap-shots.md`
  phase 2) is **untested on the GPU** (`PLAN-gpu-recheck.md`). Depth control works today. The character creator adds the
  per-shot sheet as the references and the rigged model as a pose source; nothing else new until mocap is checked.
- **Put a character into footage.** `app/solve.py` solves a clip's camera (PnP / DA3) into a 3D scene; the character's
  rigged layer stands in it; render a **matte** of the layer (new render kind in `scene-export.js` and
  `frame-outs.js` OUT_KINDS: `'matte'`), run H3 with the depth + the footage, key by the matte in VFX (the keying and
  matte templates exist). "Transparent video layers" on the Video tab means a clip with an alpha or a paired matte;
  the timeline's compositing of such clips doesn't exist yet and is its own piece of work.
- **Expressions and lines** per look are there (`makeExpressions`, voices); a dialogue shot could pick the expression
  the line implies (`dialogue.js`) as it picks a view.
- **Several characters in one 3D scene** sharing a turntable for a group sheet.
- **Overnight batch** across projects, and a daily "what's waiting for review" list on the Board.

---

## Model and node checklist (fill in during each phase, then copy to the README tables)

| Phase | Template / node | Status on this box | Time, VRAM |
|---|---|---|---|
| 4.1 | `deck-3d-object-trellis` | works (2026-11-05 NOTES) | |
| 4.1 | `deck-3d-object-splat` (Idol) | works sometimes | |
| 4.1 | `deck-3d-object-hunyuan21` | hit or miss | |
| 4.1 | `deck-3d-object` (Pixal3D) | never finished on the GPU; see PLAN-gpu-recheck §1 | |
| 4.1 | `deck-3d-object-multi` | untested here | |
| 4.2 | `deck-h3-ctrl2v`, `-hold` | ctrl2v works; `-hold` untested on a GPU (README) | |
| 4.3 | `deck-upscale-image`, `deck-cutout-image`, De-light step | work (Mark views) | |
| 5.2 | `deck-h3-charsheet*`, `deck-h3-objectsheet` | work; bust/head frames "untested on a GPU" (README) | |
| 2.1 | DWPose / YOLOX through `looks.py`'s venv | works on the CPU (look check) | |
| 7 | `deck-autorig-human`, `deck-autorig-any` | work (13 min on the CPU once; GPU untested) | |

## Open questions (answer as they come up; defaults in brackets)

- Where a character table lives when a character is **brought in from another project** (`Bring in from a project`):
  copy the table too, or lay it out fresh from the copied media? [fresh]
- Should the per-shot sheet be a **saved** picture the shot's frame points at (so the Board shows it in use) or a
  cache only? [cache, phase 6; revisit if people want to edit them]
- The turntable's **hold** length: how many still frames does H3 need to copy a pose cleanly at 24 fps? [5; measure
  in phase 4 and put the number in `turntable.js`]
- **Idol splat depth**: "The picture" depth estimate is slow on a 12 GB card; is a splat's box depth good enough for
  a turntable (the background is flat grey anyway)? [try shapes first in 4.2, measure]
- Whether the Looks gate should also propose **merging** two looks the user split by hand later (a hair colour that
  turns out to be lighting). [no, phase 2 only proposes once]
