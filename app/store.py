"""A small JSON document store: saved tabs, presets, created 3D objects, scenes.

Project scope lives with the project's outputs:  projects/<project folder>/.deck/<kind>/<id>.json
Global scope is shared by every project:         library/<kind>/<id>.json
Each file is {"id", "kind", "name", "order", "rev", "updated", "payload"}. The server bumps `rev` on
every write; a client must send the rev it last saw (optimistic concurrency, 409 + current doc if stale).
Reordering changes `order` only and leaves rev alone (order isn't content, so it never makes another
device's save conflict). Deleting moves the file into a `.trash/` folder beside it, so Undo can bring
it back; trashed copies older than 30 days are dropped on the next delete in that folder.

A "tables" payload (the project's canvas of frames): {v:1, view:{x,y,z}, grid:{on,size},
frames:[{id, kind:'image'|'video'|'scene'|'sound'|'note', doc:<store id of edit-tabs|video-tabs|scene-tabs|sound-tabs>,
x,y,w,h,label,locked?,text?,story?:{scene,shot}}], wires?:[{id, from, to, kind, n, on, frame?}] (from/to are frame ids of
the same table; wires hold no run ids or picture names), story?:<story-tabs id>}. The table owns the docs its frames
point at: deleting the table trashes them too, restoring it brings them back.

A "setups" payload (a parameter block's saved values, global so every project sees it): {v:1, key, values, note?}.
`key` names the block (tpl:<template>, edit:<kind>.<op> (old vfx:<op> keys move there), tool:<id>, sound:maker.<id>, sound:voice,
scene:out); `values` is that block's own value map. A setup holds no runs and no files."""
import json
import os
import re
import shutil
import tempfile
import time
import uuid

from urllib.parse import quote

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import JSONResponse

from . import config, db, storage

# The one place that says which kinds exist. Add a name here to start storing a new one.
KINDS = ("gen-tabs", "gen-presets", "edit-tabs", "video-tabs", "sound-tabs", "scene-tabs", "vfx-tabs", "story-tabs", "tables", "characters", "objects", "scenes", "tracks", "prefs", "view-marks", "setups")
MAX_PAYLOAD = 5 * 1024 * 1024
MAX_STILL = 12 * 1024 * 1024
PNG_SIG = b"\x89PNG\r\n\x1a\n"
TRASH_DAYS = 30
ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")

router = APIRouter(prefix="/api/store")
notify = None  # async callable(dict); main.py sets it to its websocket broadcast


def _check_kind(kind: str):
    if kind not in KINDS:
        raise HTTPException(400, f"Unknown kind (allowed: {', '.join(KINDS)})")


def _check_id(did: str):
    if not ID_RE.fullmatch(did):
        raise HTTPException(400, "Bad id: letters, digits, - and _ only, up to 64")


def _dir(kind: str, project_id, scope) -> "os.PathLike":
    """Folder for one kind in one scope. project_id None means the Unsorted folder."""
    _check_kind(kind)
    if scope == "global":
        if project_id is not None:
            raise HTTPException(400, "Use project_id or scope=global, not both")
        return config.LIBRARY_DIR / kind
    if scope not in (None, "project"):
        raise HTTPException(400, "scope must be 'global' or omitted")
    if project_id is not None and not any(p["id"] == project_id for p in db.list_projects()):
        raise HTTPException(404, "No such project")
    return config.PROJECTS_DIR / db.project_folder(project_id) / ".deck" / kind


def _read(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except ValueError:
        raise HTTPException(500, f"Unreadable document {path.name}")


def _write(path, doc: dict):
    """Write to a temp file in the same folder, fsync, then rename over the target."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _docs(d) -> list[dict]:
    out = []
    for p in d.glob("*.json") if d.is_dir() else []:
        try:
            out.append(json.loads(p.read_text(encoding="utf-8")))
        except ValueError:
            continue
    return sorted(out, key=lambda x: (x.get("order", 0), (x.get("name") or "").lower(), x["id"]))


async def _tell(kind, did, rev, project_id, scope, **extra):
    if notify:
        msg = {"type": "store", "kind": kind, "id": did, "rev": rev,
               "project_id": project_id, "scope": "global" if scope == "global" else "project", **extra}
        await notify(msg)


def _conflict(cur):
    return JSONResponse({"detail": "Stale rev", "doc": cur}, status_code=409)


@router.get("/{kind}")
async def list_docs(kind: str, project_id: int | None = None, scope: str | None = None, full: bool = False):
    """The documents' headers; full=true adds each payload (small kinds such as setups, read in one call)."""
    d = _dir(kind, project_id, scope)
    keys = ("id", "name", "order", "rev", "updated", "still") + (("payload",) if full else ())
    return [{k: x.get(k) for k in keys} for x in _docs(d)]


@router.get("/{kind}/{did}")
async def get_doc(kind: str, did: str, project_id: int | None = None, scope: str | None = None, optional: bool = False):
    """A document; optional=true answers null for one not saved yet (the app's settings before the first change)."""
    d = _dir(kind, project_id, scope)
    _check_id(did)
    doc = _read(d / f"{did}.json")
    if not doc:
        if optional:
            return None
        raise HTTPException(404, "Not found")
    return doc


@router.put("/{kind}/{did}")
async def put_doc(kind: str, did: str, body: dict = Body(...), project_id: int | None = None, scope: str | None = None):
    d = _dir(kind, project_id, scope)
    _check_id(did)
    name, order, payload, rev = (body.get(k) for k in ("name", "order", "payload", "rev"))
    if name is not None and not isinstance(name, str):
        raise HTTPException(400, "name must be text")
    if order is not None and (isinstance(order, bool) or not isinstance(order, (int, float))):
        raise HTTPException(400, "order must be a number")
    if payload is not None and not isinstance(payload, dict):
        raise HTTPException(400, "payload must be an object")
    if rev is not None and (isinstance(rev, bool) or not isinstance(rev, int)):
        raise HTTPException(400, "rev must be an integer")
    if payload is not None and len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > MAX_PAYLOAD:
        raise HTTPException(413, "Payload too large (5 MB max)")
    path = d / f"{did}.json"
    cur = _read(path)
    if kind == "tables" and payload is not None:   # one table per document: a copied payload must go through /duplicate
        mine = set(_owned_docs({"payload": payload}, story=False))
        if mine:
            taken = set()   # one pass over the tables dir
            for other in _docs(d):
                if other.get("id") != did:
                    taken.update(_owned_docs(other, story=False))
            if mine & taken:   # (no `doc` key: the client tells this from a stale rev by that)
                raise HTTPException(409, detail="Those documents belong to another table")
    if cur is not None and name is None and payload is None and order is not None:
        doc = {**cur, "order": order, "updated": time.time()}  # order-only: no rev check, no rev bump
        _write(path, doc)
        await _tell(kind, did, doc["rev"], project_id, scope, order=True)
        return doc
    if cur is None:
        if rev not in (None, 0):
            return _conflict(None)  # saved from a copy that has since been deleted
        order = order if order is not None else max((x.get("order", 0) for x in _docs(d)), default=-1) + 1
        doc = {"id": did, "kind": kind, "name": (name or did)[:120], "order": order, "rev": 1,
               "updated": time.time(), "payload": payload or {}}
    else:
        if rev != cur["rev"]:
            return _conflict(cur)
        doc = {**cur, "rev": cur["rev"] + 1, "updated": time.time()}
        if name is not None:
            doc["name"] = name[:120]
        if order is not None:
            doc["order"] = order
        if payload is not None:
            doc["payload"] = payload
    _write(path, doc)
    await _tell(kind, did, doc["rev"], project_id, scope)
    return doc


FRAME_DOC_KINDS = {"image": "edit-tabs", "video": "video-tabs", "scene": "scene-tabs", "sound": "sound-tabs"}


def _owned_docs(doc: dict, story: bool = True) -> list[tuple[str, str]]:
    """(kind, id) of the documents a table owns: each frame's doc and (story=True) its story-tabs doc (payload.story). The
    one-owner check passes story=False: that is not a frame doc. (A video frame's old VFX document, frame.vfx, is read into
    the frame's own state and trashed by the page when its table opens: it is not owned here.)"""
    out = []
    pl = doc.get("payload") or {}
    st = pl.get("story")
    if story and isinstance(st, str) and ID_RE.fullmatch(st):
        out.append(("story-tabs", st))
    frames = pl.get("frames")
    if not isinstance(frames, list):
        return out
    for f in frames:
        if not isinstance(f, dict):
            continue
        k, i = FRAME_DOC_KINDS.get(f.get("kind")), f.get("doc")
        if k and isinstance(i, str) and ID_RE.fullmatch(i) and (k, i) not in out:
            out.append((k, i))
    return out


def _trash_file(d, kind, did, ts=None):
    """Move one document (and its still) into d/.trash; False if there is none."""
    path = d / f"{did}.json"
    if not path.exists():
        return False
    (d / ".trash").mkdir(exist_ok=True)
    ts = ts or time.time_ns()
    os.replace(path, d / ".trash" / f"{did}.{ts}.json")
    if (d / f"{did}.png").exists():
        os.replace(d / f"{did}.png", d / ".trash" / f"{did}.{ts}.png")
    return True


def _restore_file(d, did, ts=None):
    """Bring the newest trashed copy of did back unless one exists (only the copy trashed at ts, if given); True if restored."""
    path = d / f"{did}.json"
    if path.exists() or not (d / ".trash").is_dir():
        return False
    copies = sorted(((int(p.name[len(did) + 1:-5]), p) for p in (d / ".trash").glob(f"{did}.*.json")
                     if p.name[len(did) + 1:-5].isdigit()), key=lambda t: t[0])
    if ts is not None:
        copies = [c for c in copies if c[0] == ts]
    if not copies:
        return False
    src = copies[-1][1]
    still = src.with_suffix(".png")
    if still.exists():
        os.replace(still, d / f"{did}.png")
    doc = _read(src)
    doc["rev"] += 1
    doc["updated"] = time.time()
    _write(path, doc)
    src.unlink()
    return True


@router.delete("/{kind}/{did}")
async def delete_doc(kind: str, did: str, project_id: int | None = None, scope: str | None = None):
    d = _dir(kind, project_id, scope)
    _check_id(did)
    path = d / f"{did}.json"
    doc = _read(path)
    if not doc:
        raise HTTPException(404, "Not found")
    (d / ".trash").mkdir(exist_ok=True)
    cutoff = time.time_ns() - TRASH_DAYS * 86400 * 10**9
    for old in (d / ".trash").glob("*.json"):
        ts = old.name[:-5].rpartition(".")[2]
        if ts.isdigit() and int(ts) < cutoff:
            if kind == "characters":   # gone for good: its pictures go too (storage.py), unless something else uses them
                storage.drop_character_pictures((_read(old) or {}).get("payload") or {})
            old.unlink(missing_ok=True)
            old.with_suffix(".png").unlink(missing_ok=True)
    ts = time.time_ns()
    unlink = kind == "story-tabs" and scope != "global"
    owned = _owned_docs(doc) if kind == "tables" and scope != "global" else []   # (global tables own nothing)
    _trash_file(d, kind, did, ts)   # its still goes with it, same timestamp
    await _tell(kind, did, doc["rev"], project_id, scope, deleted=True)
    for k, i in owned:   # the docs its frames own go with it, same timestamp (a missing one is fine)
        od = _dir(k, project_id, scope)
        gone = _read(od / f"{i}.json")
        if gone and _trash_file(od, k, i, ts):
            await _tell(k, i, gone["rev"], project_id, scope, deleted=True)
    if unlink:   # a table that pointed at this story forgets it (so the client stops retrying)
        for t in _docs(_dir("tables", project_id, scope)):
            pl = t.get("payload")
            if isinstance(pl, dict) and pl.get("story") == did:
                pl = {k: v for k, v in pl.items() if k != "story"}
                t = {**t, "payload": pl, "rev": t["rev"] + 1, "updated": time.time()}
                _write(_dir("tables", project_id, scope) / f"{t['id']}.json", t)
                await _tell("tables", t["id"], t["rev"], project_id, scope)
    return doc


@router.post("/{kind}/{did}/restore")
async def restore_doc(kind: str, did: str, project_id: int | None = None, scope: str | None = None):
    d = _dir(kind, project_id, scope)
    _check_id(did)
    path = d / f"{did}.json"
    if path.exists():
        raise HTTPException(409, "A document with that id exists")
    # sort by the timestamp in the name: newest trashed copy wins
    copies = sorted(((int(p.name[len(did) + 1:-5]), p) for p in (d / ".trash").glob(f"{did}.*.json")
                     if p.name[len(did) + 1:-5].isdigit()), key=lambda t: t[0]) if (d / ".trash").is_dir() else []
    if not copies:
        raise HTTPException(404, "Nothing to restore")
    ts, src = copies[-1]
    still = src.with_suffix(".png")
    if still.exists():
        os.replace(still, d / f"{did}.png")
    doc = _read(src)
    doc["rev"] += 1
    doc["updated"] = time.time()
    _write(path, doc)
    src.unlink()
    await _tell(kind, did, doc["rev"], project_id, scope)
    if kind == "tables" and scope != "global":   # only the docs trashed together with this table
        for k, i in _owned_docs(doc):
            od = _dir(k, project_id, scope)
            if _restore_file(od, i, ts):
                await _tell(k, i, (_read(od / f"{i}.json") or {}).get("rev", 0), project_id, scope)
    return doc


@router.post("/tables/{did}/duplicate")
async def duplicate_table(did: str, project_id: int | None = None, scope: str | None = None):
    """A copy of a table that owns copies of its documents: {the new table doc}. Frames point at the copies (new frame ids too)."""
    d = _dir("tables", project_id, scope)
    _check_id(did)
    src = _read(d / f"{did}.json")
    if not src:
        raise HTTPException(404, "Not found")
    payload = json.loads(json.dumps(src.get("payload") or {}))
    payload.pop("story", None)   # the copy has no story: two tables must not drive one
    now = time.time()
    made = {}   # (kind, old id) -> new id
    if scope != "global":
        for k, i in _owned_docs(src, story=False):
            od = _dir(k, project_id, scope)
            old = _read(od / f"{i}.json")
            if not old:
                continue
            new = uuid.uuid4().hex[:12]
            doc = {**old, "id": new, "rev": 1, "updated": now}
            doc.pop("still", None)
            png = od / f"{i}.png"
            if png.exists():
                shutil.copyfile(png, od / f"{new}.png")
                st = old.get("still") or {}
                doc["still"] = {**st, "url": _still_url(od / f"{new}.png", 1), "rev": 1}
            _write(od / f"{new}.json", doc)
            made[(k, i)] = new
    idmap = {}   # old frame id -> new frame id, so wires follow their frames
    if isinstance(payload.get("frames"), list):
        for f in payload["frames"]:
            if not isinstance(f, dict):
                continue
            old_id = f.get("id")
            f["id"] = uuid.uuid4().hex[:12]
            if isinstance(old_id, str):
                idmap[old_id] = f["id"]
            k = FRAME_DOC_KINDS.get(f.get("kind"))
            if (k, f.get("doc")) in made:
                f["doc"] = made[(k, f["doc"])]
            if ("vfx-tabs", f.get("vfx")) in made:
                f["vfx"] = made[("vfx-tabs", f["vfx"])]
    if isinstance(payload.get("wires"), list):
        wires = []
        for w in payload["wires"]:
            if not isinstance(w, dict) or idmap.get(w.get("from")) is None or idmap.get(w.get("to")) is None:
                continue
            wires.append({**w, "id": uuid.uuid4().hex[:12], "from": idmap[w["from"]], "to": idmap[w["to"]]})
        payload["wires"] = wires
    new = uuid.uuid4().hex[:12]
    doc = {"id": new, "kind": "tables", "name": f"{src.get('name') or did} copy"[:120],
           "order": max((x.get("order", 0) for x in _docs(d)), default=-1) + 1, "rev": 1, "updated": now, "payload": payload}
    _write(d / f"{new}.json", doc)
    for (k, _), i in made.items():
        await _tell(k, i, 1, project_id, scope)
    await _tell("tables", new, 1, project_id, scope)
    return doc


@router.post("/{kind}/reorder")
async def reorder(kind: str, body: dict = Body(...), project_id: int | None = None, scope: str | None = None):
    d = _dir(kind, project_id, scope)
    ids = body.get("ids")
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids) or len(set(ids)) != len(ids):
        raise HTTPException(400, "ids must be a list of distinct ids")
    for i in ids:
        _check_id(i)
    docs = {}
    for i in ids:
        docs[i] = _read(d / f"{i}.json")
        if not docs[i]:
            raise HTTPException(404, f"Not found: {i}")
    now = time.time()
    for n, i in enumerate(ids):
        doc = docs[i]
        doc.update(order=n, updated=now)  # rev stays: order isn't content
        _write(d / f"{i}.json", doc)
    await _tell(kind, None, None, project_id, scope, ids=ids)
    return [{k: docs[i][k] for k in ("id", "name", "order", "rev", "updated")} for i in ids]


# ---- stills: a picture of a document (an edit tab's composite), for pickers ----
# Lives beside the doc as <id>.png and is served by the /files/projects (or, for global documents, /files/library) mount. Writing one never bumps the
# doc's rev (it isn't content), so it can't make another device's save conflict.
def _still_url(path, rev):
    if path.is_relative_to(config.LIBRARY_DIR):  # a global document's: served by the /files/library mount
        return f"/files/library/{quote(path.relative_to(config.LIBRARY_DIR).as_posix())}?v={rev}"
    rel = path.relative_to(config.PROJECTS_DIR).as_posix()
    return f"/files/projects/{quote(rel)}?v={rev}"


@router.put("/{kind}/{did}/still")
async def put_still(kind: str, did: str, request: Request, project_id: int | None = None, scope: str | None = None):
    d = _dir(kind, project_id, scope)
    _check_id(did)
    data = b""
    async for chunk in request.stream():
        data += chunk
        if len(data) > MAX_STILL:
            raise HTTPException(413, f"Still too large ({MAX_STILL >> 20} MB max)")
    if len(data) < 24 or not data.startswith(PNG_SIG) or data[12:16] != b"IHDR":
        raise HTTPException(400, "Body must be a PNG")
    w, hh = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    path, png = d / f"{did}.json", d / f"{did}.png"
    if not _read(path):
        raise HTTPException(404, "Not found")
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp-", suffix=".part")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, png)
    doc = _read(path)  # again: no await from here to the write, so a concurrent save can't be overwritten
    if not doc:
        png.unlink(missing_ok=True)
        raise HTTPException(404, "Not found")
    rev = ((doc.get("still") or {}).get("rev") or 0) + 1
    doc["still"] = {"url": _still_url(png, rev), "rev": rev, "w": w, "h": hh}
    _write(path, doc)
    return doc["still"]


@router.delete("/{kind}/{did}/still")
async def delete_still(kind: str, did: str, project_id: int | None = None, scope: str | None = None):
    d = _dir(kind, project_id, scope)
    _check_id(did)
    doc = _read(d / f"{did}.json")
    if not doc:
        raise HTTPException(404, "Not found")
    (d / f"{did}.png").unlink(missing_ok=True)
    if doc.pop("still", None) is not None:
        _write(d / f"{did}.json", doc)
    return {"ok": True}
