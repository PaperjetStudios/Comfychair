# ComfyChair (comfydeck): rules for anyone changing this code

## The user's content stays on this PC, and deleted means gone

- Never commit or push images, video, audio, models or other user content. `.gitignore` blocks media; keep it that way.
- Never send user content to an outside service.
- **ComfyUI keeps nothing.** Once ComfyChair has its own copy of a run's outputs, ComfyUI's copies go: the
  reported files and the ones written beside them, the run's `run-<token>/` folder, and the run's ComfyUI history entry.
  - `main.tidy_comfy` and `storage.drop_comfy_outputs` do this.
  - `comfy.once` gives every queued run its own save folder, so a repeated prompt saves again instead of
    pointing at deleted files.
- **Anything new that writes a file must be removed when its owner is deleted.** That covers a node, a route and a
  cache. Put the rule in `app/storage.py` and add a test to `tests/test_storage.py`. Specifically:
  - A cache file name starts with `storage.tag(source)-` so `storage.drop_caches` finds it.
  - A file copied into ComfyUI's input folder is deleted after the run that read it (as with `storage.rig_input`)
    or with its owner.
  - A custom node that receives a file path from another node moves the file rather than copying it, and
    removes that node's other files, as `comfy_nodes/deck_rigsave` does.
- Deleting a picture (`DELETE /api/inputs`) removes every copy, unless a character uses it: that's refused until it's
  taken out of them. Deleting a project removes its pictures unless another project's runs or saved documents use them.
- **A run in use can't be deleted.** `storage.attachments` lists what every saved document uses; `DELETE
  /api/generations/{id}` refuses those with a 409 and `POST /api/generations/delete` keeps them. A new document kind that
  points at a run with `generation` or `gen`, or at a picture made from one, is covered by this without more code.
- Settings → Projects → **Clean up leftovers** (`storage.sweep`) handles anything left over:
  - It lists before deleting.
  - It covers only ComfyChair's own folders in ComfyUI.
  - It never takes a file ComfyChair has no other copy of.

## The UI

- Help text goes only behind an ⓘ button (`ui.js` `info()`, `help()`, `withHelp()`). Never show inline descriptions.
- Every new panel or area uses `layout.js`: `wireSplitters()` for resizable areas, `maximizable()` for a full-screen
  toggle and `sideNav()` for a side panel's icon tabs.
- Every transform gets a grid and snapping (`gizmo.js` `snap`/`snapBar`, `snap3`/`snapBar3`).
- A layer stack's rules (groups, masks, undo states) live in `web/layer-stack.js`; a character's in `web/char-model.js`.

## The card takes one thing at a time

- Anything heavy outside ComfyUI (a new GPU worker, a big Blender job) runs inside `with gpu.card(label, job):`
  (`app/gpu.py`), and is stoppable (`sceneasset._run_stoppable`). It then appears in the Queue panel by itself.
- Everything goes to ComfyUI through `comfy.queue`, never its own `POST /prompt`: that's what holds a run back while an
  outside job has the card.

## Working on it

- Tests never touch the live `data/` folder. Run them with a scratch `DECK_DATA`:
  `DECK_DATA=$(mktemp -d) .venv/bin/python -m pytest -q tests` and `node --test tests/*.test.mjs`.
- Ask before pushing, merging to `main`, restarting the live app or ComfyUI, or deleting the user's files.
