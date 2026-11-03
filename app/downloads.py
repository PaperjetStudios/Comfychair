"""Downloads: what's coming in now (progress and Stop, through the clip importer's jobs) and a history of what came in.

The history is data/downloads.json: names, sizes, times and links only, newest first, the last KEEP finished ones. It belongs
to no project or run, so nothing else deletes it: the panel's Clear and ✕ do. A download that was running when the app
stopped is marked interrupted the next time the list is read, and its .part file goes then."""
import asyncio
import json
import os
import re
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException

from . import clipimport, config

router = APIRouter(prefix="/api/downloads", tags=["downloads"])

KEEP = 200
_lock = threading.Lock()
LIVE: dict[str, dict] = {}   # entry id -> {"entry", "job", "key"}, for as long as its thread runs


def _file() -> Path:
    return config.DATA_DIR / "downloads.json"


def _read() -> list[dict]:
    try:
        d = json.loads(_file().read_text())
    except (OSError, ValueError):
        return []
    return d if isinstance(d, list) else []


def _write(items: list[dict]):
    p = _file()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(json.dumps(items, indent=1))
    os.replace(tmp, p)


def _record(entry: dict):
    with _lock:
        items = _read()
        i = next((k for k, e in enumerate(items) if e.get("id") == entry["id"]), None)
        if i is None:
            items.insert(0, dict(entry))
        else:
            items[i] = dict(entry)
        running = [e for e in items if e.get("state") == "running"]
        keep = {id(e) for e in running} | {id(e) for e in [e for e in items if e.get("state") != "running"][:KEEP]}
        _write([e for e in items if id(e) in keep])


def start(work, label: str, *, name: str, folder: Path, key=None, **info) -> dict:
    """clipimport._start for a download: work(job) returns {"file", "skipped"...} and may set job's got/total/speed."""
    eid = uuid.uuid4().hex[:12]
    entry = {"id": eid, "state": "running", "name": name, "folder": str(folder), "started": time.time(), **info}
    live = LIVE[eid] = {"entry": entry, "job": None, "key": key}
    _record(entry)

    def run(job):
        job["download"] = eid
        live["job"] = job
        try:
            result = work(job)
        except Exception as e:
            _end(eid, entry, "stopped" if job["cancel"] else "failed", None if job["cancel"] else str(e), job)
            raise
        entry["file"] = result.get("file")
        entry["skipped"] = bool(result.get("skipped"))
        try:
            entry["size"] = (folder / entry["file"]).stat().st_size
        except (OSError, TypeError):
            pass
        _end(eid, entry, "done", None, job)
        return result

    res = clipimport._start(run, label)
    live["job"] = clipimport.JOBS[res["job"]]
    return res


def _end(eid: str, entry: dict, state: str, error: str | None, job: dict):
    entry.update(state=state, finished=time.time())
    if error:
        entry["error"] = error
    if job.get("got"):
        entry["got"] = job["got"]
    _record(entry)   # (before it leaves LIVE: a read in between must not take it for one that was interrupted)
    LIVE.pop(eid, None)


def running_job(key) -> str | None:
    """The job already fetching this, so a second tap follows it instead of fetching it twice."""
    return next((v["job"]["id"] for v in list(LIVE.values()) if v["job"] and v["key"] == key), None)


def _reconcile():
    with _lock:
        items = _read()
        lost = [e for e in items if e.get("state") == "running" and e.get("id") not in LIVE]
        for e in lost:
            e.update(state="interrupted", finished=time.time())
            if re.fullmatch(r"[0-9a-f]{12}", str(e.get("id"))) and e.get("folder"):
                for p in Path(e["folder"]).glob(f"*.{e['id']}.part"):
                    p.unlink(missing_ok=True)
        if lost:
            _write(items)
        return items


def _active(v: dict) -> dict:
    job, e = v["job"], v["entry"]
    return {"id": e["id"], "job": job["id"], "name": e["name"], "version": e.get("version"), "family": e.get("family"),
            "link": e.get("link"), "started": e["started"], "progress": round(job["progress"], 3), "got": job.get("got", 0),
            "total": job.get("total", 0), "speed": job.get("speed", 0), "stopping": bool(job["cancel"])}


def active() -> list[dict]:
    return [_active(v) for v in list(LIVE.values()) if v["job"]]


def summary() -> dict:
    """For the top bar on every device: how many, and how far along together."""
    a = active()
    got, total = sum(x["got"] for x in a), sum(x["total"] for x in a)
    return {"count": len(a), "progress": round(got / total, 2) if total else 0}


def view() -> dict:
    history = [e for e in _reconcile() if e.get("state") != "running"]
    for e in history:
        if e.get("state") == "done" and e.get("file"):
            e["gone"] = not (Path(e["folder"]) / e["file"]).exists()
    return {"active": active(), "history": history}


@router.get("")
async def downloads():
    return await asyncio.to_thread(view)


def _forget(eid: str | None):
    with _lock:
        _write([e for e in _read() if e.get("state") == "running" or (eid and e.get("id") != eid)])


@router.delete("")
async def clear():
    """Clears the list of what finished. The files themselves stay."""
    await asyncio.to_thread(_forget, None)
    return {"ok": True}


@router.delete("/{eid}")
async def forget(eid: str):
    if eid in LIVE:
        raise HTTPException(409, "That one is still downloading: stop it first")
    await asyncio.to_thread(_forget, eid)
    return {"ok": True}
