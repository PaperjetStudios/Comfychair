"""A small JSON document store: saved tabs, presets, created 3D objects, scenes.

Project scope lives with the project's outputs:  projects/<project folder>/.deck/<kind>/<id>.json
Global scope is shared by every project:         library/<kind>/<id>.json
Each file is {"id", "kind", "name", "order", "rev", "updated", "payload"}. The server bumps `rev` on
every write; a client must send the rev it last saw (optimistic concurrency, 409 + current doc if stale).
Reordering changes `order` only and leaves rev alone (order isn't content, so it never makes another
device's save conflict). Deleting moves the file into a `.trash/` folder beside it, so Undo can bring
it back; trashed copies older than 30 days are dropped on the next delete in that folder."""
import json
import os
import re
import tempfile
import time

from urllib.parse import quote

from fastapi import APIRouter, Body, HTTPException, Request
from fastapi.responses import JSONResponse

from . import config, db

# The one place that says which kinds exist. Add a name here to start storing a new one.
KINDS = ("gen-tabs", "gen-presets", "edit-tabs", "video-tabs", "scene-tabs", "objects", "scenes")
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
async def list_docs(kind: str, project_id: int | None = None, scope: str | None = None):
    d = _dir(kind, project_id, scope)
    return [{k: x.get(k) for k in ("id", "name", "order", "rev", "updated", "still")} for x in _docs(d)]


@router.get("/{kind}/{did}")
async def get_doc(kind: str, did: str, project_id: int | None = None, scope: str | None = None):
    d = _dir(kind, project_id, scope)
    _check_id(did)
    doc = _read(d / f"{did}.json")
    if not doc:
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
            old.unlink(missing_ok=True)
            old.with_suffix(".png").unlink(missing_ok=True)
    ts = time.time_ns()
    os.replace(path, d / ".trash" / f"{did}.{ts}.json")
    if (d / f"{did}.png").exists():  # its still goes with it, same timestamp
        os.replace(d / f"{did}.png", d / ".trash" / f"{did}.{ts}.png")
    await _tell(kind, did, doc["rev"], project_id, scope, deleted=True)
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
    src = copies[-1][1]
    still = src.with_suffix(".png")
    if still.exists():
        os.replace(still, d / f"{did}.png")
    doc = _read(src)
    doc["rev"] += 1
    doc["updated"] = time.time()
    _write(path, doc)
    src.unlink()
    await _tell(kind, did, doc["rev"], project_id, scope)
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
# Lives beside the doc as <id>.png and is served by the /files/projects mount. Writing one never bumps the
# doc's rev (it isn't content), so it can't make another device's save conflict.
def _still_url(path, rev):
    rel = path.relative_to(config.PROJECTS_DIR).as_posix()
    return f"/files/projects/{quote(rel)}?v={rev}"


@router.put("/{kind}/{did}/still")
async def put_still(kind: str, did: str, request: Request, project_id: int | None = None, scope: str | None = None):
    if scope == "global":
        raise HTTPException(400, "Stills are for project documents")
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
