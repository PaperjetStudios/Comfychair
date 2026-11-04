"""Projects: list, create, rename, reorder, duplicate and delete (Settings → Projects).

A project is a database row (projects) with its generations, plus a folder: projects/<folder>/ holds
its outputs and its saved documents (.deck/: tabs, scenes, assets...). The folder name is frozen when
the project is made, so renaming never moves files.

Duplicate copies the folder into a hidden .tmp-copy-<job>/ folder in a thread (it can be GBs) and
then moves it into place, rewrites the copied documents' links to point into the new folder, and
copies the generation rows (their outputs pointing into the new folder, links between them mapped to
the new ids). Progress goes out over the websocket as deck_project_job messages.

Delete removes the rows, then the folder. It only ever deletes inside config.PROJECTS_DIR: the folder
must be a direct child of it, and a folder that is a symlink has only the link removed (rmtree never
follows links either). Every change sends deck_projects, so other devices update their pickers."""
import asyncio
import json
import logging
import os
import shutil
import time
import uuid
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Body, HTTPException

from . import config, db, storage, store

log = logging.getLogger("comfydeck.projects")
router = APIRouter(prefix="/api/projects")
notify = None       # async callable(dict); main.py sets it to its websocket broadcast
comfy_copy = None   # main.comfy_copy(g, o, ours): ComfyUI's own copy of an output, removed with the project
JOBS: dict[str, dict] = {}   # duplicate jobs: id -> {id, src, dst, name, done, total, state, error}
TMP_PREFIX = ".tmp-copy-"


async def _tell(**data):
    if notify:
        await notify({"type": "deck_projects", "data": data})


def _job_view(j: dict) -> dict:
    return {k: j[k] for k in ("id", "src", "dst", "name", "done", "total", "state", "error")}


UPGRADING: set[int] = set()   # projects being moved to version 2 right now


def _busy_ids() -> set[int]:
    return {p for j in JOBS.values() if j["state"] == "copying" for p in (j["src"], j["dst"])} | UPGRADING


# ---- paths: only ever inside the projects folder ----------------------------
def project_dir(folder: str | None) -> Path | None:
    """The folder for a frozen folder name, if it is a plain direct child of the projects root."""
    if not folder or folder in (".", "..") or "/" in folder or "\\" in folder or "\0" in folder \
            or folder.lower() == "unsorted" or folder.startswith(TMP_PREFIX):
        return None
    return Path(os.path.abspath(config.PROJECTS_DIR)) / folder


def _inside_root(p: Path) -> bool:
    root = config.PROJECTS_DIR.resolve()
    try:
        return p.parent.resolve() == root and p.name not in ("", ".", "..")
    except OSError:
        return False


def folder_size(p: Path | None) -> int:
    """Bytes in a folder, without following links (a link counts as itself)."""
    if not p or p.is_symlink() or not p.is_dir():
        return 0
    total = 0
    for top, dirs, files in os.walk(p, followlinks=False):
        for f in files:
            try:
                total += os.lstat(os.path.join(top, f)).st_size
            except OSError:
                pass
    return total


def remove_folder(p: Path | None):
    """Delete a project's folder for good. A link is removed as a link (what it points at is left
    alone); anything that isn't a direct child of the projects root is refused."""
    if p is None:
        return
    if p.is_symlink():
        if p.parent.resolve() == config.PROJECTS_DIR.resolve():
            p.unlink()
        return
    if not p.exists():
        return
    if not _inside_root(p) or not p.is_dir():
        raise RuntimeError(f"Refusing to delete {p}: not a folder inside the projects folder")
    shutil.rmtree(p)   # (on Linux this never follows links inside: shutil.rmtree.avoids_symlink_attacks)


def sweep():
    """Leftovers of a duplicate that was cut off (ComfyChair stopped mid-copy). Run at startup."""
    for p in config.PROJECTS_DIR.glob(f"{TMP_PREFIX}*"):
        if p.is_dir() and not p.is_symlink():
            shutil.rmtree(p, ignore_errors=True)


# ---- rewriting a copy's links ---------------------------------------------
def _relinker(old: str, new: str, ids: dict[int, int]):
    """A function that rewrites JSON values copied from folder `old` into folder `new`: file links
    (/files/projects/<old>/...) point into the new folder, and {"generation": <old id>} and {"gen": <old id>}
    references to copied generations use the new ids."""
    pairs = [(f"/files/projects/{quote(old)}/", f"/files/projects/{quote(new)}/"),
             (f"/files/projects/{old}/", f"/files/projects/{new}/")]

    def fix(v):
        if isinstance(v, str):
            for a, b in pairs:
                if a in v:
                    v = v.replace(a, b)
            return v
        if isinstance(v, list):
            return [fix(x) for x in v]
        if isinstance(v, dict):
            out = {}
            for k, x in v.items():
                if k in ("generation", "gen") and isinstance(x, int) and not isinstance(x, bool) and x in ids:
                    out[k] = ids[x]
                else:
                    out[k] = fix(x)
            return out
        return v
    return fix


def _fix_docs(folder: Path, fix):
    """Rewrite the copied documents (.deck/**/*.json) with fix, where it changes anything."""
    deck = folder / ".deck"
    if not deck.is_dir() or deck.is_symlink():
        return
    for p in deck.rglob("*.json"):
        if p.is_symlink() or not p.is_file():
            continue
        try:
            doc = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        new = fix(doc)
        if new != doc:
            tmp = p.with_name(f".tmp-{p.name}")
            tmp.write_text(json.dumps(new))
            os.replace(tmp, p)


def _copy_name(name: str) -> str:
    taken = {p["name"].lower() for p in db.list_projects()}
    base = f"{name} copy"[:120]
    cand, n = base, 2
    while cand.lower() in taken:
        cand, n = f"{base} {n}", n + 1
    return cand


def _row_fixer(old: str, new: str):
    def fix_row(r: dict, ids: dict[int, int]) -> dict:
        relink = _relinker(old, new, ids)
        outs = json.loads(r["outputs"] or "[]")
        for o in outs:
            o.pop("url", None)
            if o.get("path", "").startswith(f"{old}/"):
                o["path"] = new + o["path"][len(old):]
            # ComfyUI's own copy belongs to the original: deleting this copy must leave it alone
            o["comfy"] = {"type": "copied"}
        ch = {"outputs": json.dumps(relink(outs))}
        if r.get("params"):
            ch["params"] = json.dumps(relink(json.loads(r["params"])))
        if r.get("parent"):
            ch["parent"] = json.dumps(relink(json.loads(r["parent"])))
        return ch
    return fix_row


def run_copy(job: dict):
    """The copy itself (runs in a thread): files, then documents' links, then generation rows."""
    src_dir = project_dir(db.project_folder(job["src"]))
    new_folder = db.project_folder(job["dst"])
    dst_dir = project_dir(new_folder)
    if dst_dir is None:
        raise RuntimeError("The copy's folder name isn't usable")
    tmp = Path(os.path.abspath(config.PROJECTS_DIR)) / f"{TMP_PREFIX}{job['id']}"
    have_src = src_dir is not None and src_dir.is_dir() and not src_dir.is_symlink()
    job["total"] = folder_size(src_dir) if have_src else 0

    def copy(a, b):
        shutil.copy2(a, b, follow_symlinks=False)
        try:
            job["done"] += os.lstat(b).st_size
        except OSError:
            pass
    try:
        if have_src:
            shutil.copytree(src_dir, tmp, symlinks=True, copy_function=copy)
            if not dst_dir.exists():
                os.rename(tmp, dst_dir)
            else:   # something was saved into the new project while it copied: keep that, add the rest
                shutil.copytree(tmp, dst_dir, symlinks=True, dirs_exist_ok=True)
                shutil.rmtree(tmp)
        ids = db.copy_generations(job["src"], job["dst"], _row_fixer(db.project_folder(job["src"]), new_folder))
        if have_src:
            _fix_docs(dst_dir, _relinker(db.project_folder(job["src"]), new_folder, ids))
        job["generations"] = len(ids)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


async def _run_job(job: dict):
    async def report():
        while job["state"] == "copying":
            if notify:
                await notify({"type": "deck_project_job", "data": _job_view(job)})
            await asyncio.sleep(0.5)
    reporter = asyncio.create_task(report())
    try:
        await asyncio.to_thread(run_copy, job)
        job["state"] = "done"
    except Exception as e:  # noqa: BLE001 (any failure: undo the half-made copy and say why)
        log.exception("duplicating project %s failed", job["src"])
        job.update(state="error", error=str(e) or type(e).__name__)
        dst = db.get_project(job["dst"])
        try:
            db.delete_project(job["dst"])
            await asyncio.to_thread(remove_folder, project_dir(dst["folder"]) if dst else None)
        except Exception:  # noqa: BLE001 (best effort: the error above is the one to report)
            log.exception("removing the half-made copy")
    finally:
        reporter.cancel()
    if notify:
        await notify({"type": "deck_project_job", "data": _job_view(job)})
    await _tell(reason="duplicated" if job["state"] == "done" else "copy-failed", id=job["dst"], src=job["src"])
    await asyncio.sleep(60)
    JOBS.pop(job["id"], None)


async def duplicate(pid: int, name: str | None = None) -> dict:
    src = db.get_project(pid)
    if not src:
        raise HTTPException(404, "No such project")
    if pid in _busy_ids():
        raise HTTPException(409, "That project is being copied already")
    dst = db.create_project((name or "").strip()[:120] or _copy_name(src["name"]), after=pid, version=src.get("version") or 1)
    job = {"id": uuid.uuid4().hex[:12], "src": pid, "dst": dst["id"], "name": dst["name"], "done": 0, "total": 0,
           "state": "copying", "error": None, "started": time.time()}
    JOBS[job["id"]] = job
    job["task"] = asyncio.create_task(_run_job(job))
    await _tell(reason="copying", id=dst["id"], src=pid)
    return {"job": _job_view(job), "project": dst}


# ---- a character brought in from another project ----------------------------
def _copy_input(name: str, dst: int) -> str:
    """A picture's own copy for another project: a new name, both of its files, its own row."""
    sub = config.COMFY_INPUT_SUBFOLDER
    new = f"{sub}/{uuid.uuid4().hex}{Path(name).suffix or '.png'}"
    ours = config.INPUT_DIR / Path(name).name
    if not ours.is_file():
        raise FileNotFoundError(name)
    shutil.copy2(ours, config.INPUT_DIR / Path(new).name)
    if config.COMFY_INPUT_DIR:
        target = config.COMFY_INPUT_DIR / new
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ours, target)
    db.add_input(new, dst, "character")
    return new


def _copy_run(gid: int, dst: int) -> int | None:
    """One finished run and its files for another project (as a project's duplicate does): the new id, None if it's gone."""
    g = db.get_generation(gid)
    if not g or g["status"] != "done":
        return None
    old_folder, new_folder = db.project_folder(g["project_id"]), db.project_folder(dst)
    new = db.copy_generation(gid, dst, _row_fixer(old_folder, new_folder))
    for o in g["outputs"] or []:
        src = config.PROJECTS_DIR / o["path"] if o.get("path") else config.GEN_DIR / str(gid) / o["filename"]
        if not src.is_file():
            continue
        target = (config.PROJECTS_DIR / (new_folder + o["path"][len(old_folder):]) if o.get("path", "").startswith(f"{old_folder}/")
                  else config.GEN_DIR / str(new) / o["filename"])
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
    return new


def copy_character(doc: dict, src: int, dst: int) -> dict:
    """The character for project dst, sharing nothing with the original but the voice library: new pictures, new runs, a new id.
    Runs still on their way and results still to review stay with the original. A picture or a run that's gone is left out."""
    payload = {**(doc.get("payload") or {}), "vpending": [], "cands": []}
    names = {n: _copy_input(n, dst) for n in storage.character_pictures(payload) if (config.INPUT_DIR / Path(n).name).is_file()}
    runs: dict[int, int] = {}

    def fix(v):
        if isinstance(v, str):
            return names.get(v, v)
        if isinstance(v, list):
            return [fix(x) for x in v]
        if isinstance(v, dict):
            out = {}
            for k, x in v.items():
                if k in ("generation", "gen") and isinstance(x, int) and not isinstance(x, bool):
                    if x not in runs and (new := _copy_run(x, dst)) is not None:
                        runs[x] = new
                    out[k] = runs.get(x, x)
                else:
                    out[k] = fix(x)
            return out
        return v
    fixed = fix(payload)
    # a run's address moved with it: a media item's link is drawn again from the new run
    for m in fixed.get("media") or []:
        gid = (m.get("src") or {}).get("generation")
        if gid in runs.values():
            g = db.get_generation(gid)
            outs = g["outputs"] if g else []
            i = (m.get("src") or {}).get("index", 0)
            m["url"] = f"/files/projects/{quote(outs[i]['path'])}" if i < len(outs) and outs[i].get("path") else m.get("url", "")
    return {"id": uuid.uuid4().hex[:16], "name": doc.get("name") or "Someone", "payload": fixed}


@router.post("/{pid}/characters/copy")
async def character_copy(pid: int, body: dict = Body(...)):
    """{from_project, id}: a copy of that project's character in this one -> the new document."""
    src = body.get("from_project")
    if not db.get_project(pid) or (src is not None and not db.get_project(src)):
        raise HTTPException(404, "No such project")
    if src == pid:
        raise HTTPException(400, "That character is in this project already")
    did = str(body.get("id") or "")
    store._check_id(did)
    doc = store._read(store._dir("characters", src, None) / f"{did}.json")
    if not doc:
        raise HTTPException(404, "No such character")
    fresh = await asyncio.to_thread(copy_character, doc, src, pid)
    target = store._dir("characters", pid, None)
    now = time.time()
    new = {"id": fresh["id"], "kind": "characters", "name": fresh["name"], "order": 0, "rev": 1, "updated": now, "payload": fresh["payload"]}
    store._write(target / f"{fresh['id']}.json", new)
    await store._tell("characters", fresh["id"], 1, pid, None)
    return new


# ---- routes ------------------------------------------------------------------
def _listed():
    copying = {j["dst"]: j for j in JOBS.values() if j["state"] == "copying"}
    return [{**p, "copying": (copying[p["id"]]["id"] if p["id"] in copying else None)} for p in db.list_projects()]


@router.get("")
async def list_all():
    return _listed()


@router.post("")
async def create(body: dict = Body(...)):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Name required")
    p = db.create_project(name[:120])
    await _tell(reason="created", id=p["id"])
    return p


@router.get("/stats")
async def stats():
    """{project id: {bytes, generations}}: what Settings → Projects shows. Walking big folders takes a
    moment, so it's done in a thread."""
    counts = db.project_counts()
    rows = db.list_projects()

    def sizes():
        return {p["id"]: folder_size(project_dir(p["folder"])) if p.get("folder") else 0 for p in rows}
    by = await asyncio.to_thread(sizes)
    return {str(p["id"]): {"bytes": by[p["id"]], "generations": counts.get(p["id"], 0)} for p in rows}


@router.get("/jobs")
async def jobs():
    return [_job_view(j) for j in JOBS.values()]


@router.post("/order")
async def order(body: dict = Body(...)):
    ids = body.get("ids")
    if not isinstance(ids, list) or not all(isinstance(i, int) and not isinstance(i, bool) for i in ids):
        raise HTTPException(400, "ids must be a list of project ids")
    try:
        db.order_projects(ids)
    except ValueError as e:
        raise HTTPException(409, str(e)) from None
    await _tell(reason="order")
    return _listed()


@router.patch("/{pid}")
async def rename(pid: int, body: dict = Body(...)):
    """{name?, version?}: a rename and/or version 2 (never back to 1)."""
    p = db.get_project(pid)
    if not p:
        raise HTTPException(404, "No such project")
    if "version" in body:
        v = body["version"]
        if isinstance(v, bool) or v != 2:
            raise HTTPException(400, "version can only be set to 2")
    name = (body.get("name") or "").strip()
    if not name and "version" not in body:
        raise HTTPException(400, "Name required")
    if name:
        db.rename_project(pid, name[:120])
    if name:
        await _tell(reason="renamed", id=pid)
    if "version" in body:
        await run_upgrade(pid)   # same path as POST /upgrade: existing documents land on a table
    return db.get_project(pid)


FRAME_KINDS = (("edit-tabs", "image"), ("video-tabs", "video"), ("scene-tabs", "scene"), ("sound-tabs", "sound"))
FRAME_DEFAULT, FRAME_GAP = 1024, 64


def _frame_size(kind: str, payload: dict) -> tuple[int, int]:
    def num(v):
        return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else None
    w = h = None
    if kind in ("edit-tabs", "video-tabs"):
        sz = payload.get("size")
        if isinstance(sz, dict):
            w, h = num(sz.get("w")), num(sz.get("h"))
    elif kind == "scene-tabs":
        w, h = num(payload.get("width")), num(payload.get("height"))
    return w or FRAME_DEFAULT, h or FRAME_DEFAULT


def upgrade_project(pid: int) -> dict:
    """Version 1 to 2: one "Imported" table with a frame per tab doc (a row per kind), one empty table per story.
    All or nothing: a failure removes the tables already written and re-raises."""
    base = store._dir("tables", pid, None)
    now = time.time()
    order = max((x.get("order", 0) for x in store._docs(base)), default=-1) + 1
    made = []

    def put(name, payload):
        did = uuid.uuid4().hex[:12]
        store._write(base / f"{did}.json", {"id": did, "kind": "tables", "name": name, "order": order + len(made), "rev": 1,
                                            "updated": now, "payload": payload})
        made.append(did)

    try:
        frames, y = [], 0
        for kind, fk in FRAME_KINDS:
            row_h, x = 0, 0
            for doc in store._docs(store._dir(kind, pid, None)):
                w, h = _frame_size(kind, doc.get("payload") or {})
                frames.append({"id": uuid.uuid4().hex[:12], "kind": fk, "doc": doc["id"], "x": x, "y": y, "w": w, "h": h,
                               "label": doc.get("name") or ""})
                x += w + FRAME_GAP
                row_h = max(row_h, h)
            if row_h:
                y += row_h + FRAME_GAP
        if frames:
            put("Imported", {"v": 1, "view": {"x": 0, "y": 0, "z": 1}, "grid": {"on": True, "size": 64}, "frames": frames})
        for st in store._docs(store._dir("story-tabs", pid, None)):
            put(st.get("name") or "Story", {"v": 1, "view": {"x": 0, "y": 0, "z": 1}, "grid": {"on": True, "size": 64},
                                            "frames": [], "story": st["id"]})
        db.set_project_version(pid, 2)
    except BaseException:
        for did in made:
            (base / f"{did}.json").unlink(missing_ok=True)
        raise
    return {"tables": made}


async def run_upgrade(pid: int) -> dict:
    """The upgrade under the project's busy mark: {"already": true} for version 2, 409 if a copy or upgrade is running."""
    p = db.get_project(pid)
    if not p:
        raise HTTPException(404, "No such project")
    if pid in _busy_ids():
        raise HTTPException(409, "That project is being copied or upgraded: wait for it to finish")
    if (p.get("version") or 1) >= 2:
        return {"already": True}
    UPGRADING.add(pid)
    try:
        out = await asyncio.to_thread(upgrade_project, pid)
    finally:
        UPGRADING.discard(pid)
    await _tell(reason="upgraded", id=pid)
    return {"ok": True, **out, "project": db.get_project(pid)}


@router.post("/{pid}/upgrade")
async def upgrade(pid: int):
    """Version 1 to 2. Returns {"ok": true, "tables": [ids made], "project": row}, or {"already": true} for a version-2 project."""
    return await run_upgrade(pid)


@router.post("/{pid}/duplicate")
async def duplicate_route(pid: int, body: dict = Body(default={})):
    return await duplicate(pid, (body or {}).get("name"))


@router.delete("/{pid}")
async def delete(pid: int, confirm: str = ""):
    """Deletes the project, its generations and its folder, for good. `confirm` must be the project's
    name (what the confirm step had typed), so a stray call can't do it."""
    p = db.get_project(pid)
    if not p:
        raise HTTPException(404, "No such project")
    if confirm.strip() != p["name"].strip():
        raise HTTPException(400, "Type the project's name to delete it")
    if pid in _busy_ids():
        raise HTTPException(409, "That project is being copied: wait for the copy to finish")
    folder = p.get("folder")
    pictures = [r["name"] for r in db.project_inputs(pid)]
    # another project naming the same folder (only possible in a hand-edited database): keep the files
    shared = folder and any((q.get("folder") or "").lower() == folder.lower() for q in db.list_projects() if q["id"] != pid)
    try:
        gens = db.delete_project(pid)
    except LookupError:
        raise HTTPException(404, "No such project") from None
    except ValueError as e:
        raise HTTPException(409, str(e)) from None

    def files():
        for g in gens:   # ComfyUI's own copies of the outputs (only where recorded, and the same size as ours)
            for o in g["outputs"]:
                ours = config.PROJECTS_DIR / o["path"] if o.get("path") else config.GEN_DIR / str(g["id"]) / o["filename"]
                storage.drop_caches(ours.resolve())   # (its thumbnails and previews)
                if not o.get("comfy"):   # (older outputs are looked up by name, which needs the project row: leave them)
                    continue
                try:
                    theirs = comfy_copy(g, o, ours) if comfy_copy else None
                    if theirs:
                        storage.remove(storage.family(theirs))
                except OSError:
                    pass
            old = config.GEN_DIR / str(g["id"])
            if old.is_dir() and not old.is_symlink():
                shutil.rmtree(old, ignore_errors=True)
        if not shared:
            remove_folder(project_dir(folder))
        for name in pictures:   # its pictures, every copy, unless another project's runs or tabs use them (storage.py)
            if not storage.input_used(name):
                storage.delete_input(name)
    try:
        await asyncio.to_thread(files)
    except Exception as e:  # noqa: BLE001
        log.exception("deleting project %s's files", pid)
        await _tell(reason="deleted", id=pid)
        raise HTTPException(500, f"The project is gone but some files weren't deleted: {e}") from None
    log.info("deleted project %s (%s): %d generations, folder %s", pid, p["name"], len(gens), folder)
    await _tell(reason="deleted", id=pid, name=p["name"])
    return {"ok": True, "generations": len(gens)}
