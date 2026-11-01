"""ComfyChair server: a touch-first front end that drives ComfyUI through its API."""
import asyncio
import hashlib
import io
import json
import logging
import os
import random
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from html import escape
from pathlib import Path
from urllib.parse import parse_qs, quote

import httpx
from PIL import Image, ImageOps
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import accel, audioedit, civitai, clipimport, craft, delogo, h3upscale, posefind, previews, voice, config, db, editsize, imageprep, motion, stages, tracking, videoedit, videoprep, wildcards
from . import projects, storage, store, network
from . import playable
from . import keyexpr, looks, maskcomp, promptaid, sceneasset
from . import templates as tpl
from .comfy import Comfy, ComfyError
from .routes import audio, effects, library, scene, video, web
from .routes.context import RouteServices
from .routes.web import ui_version
# Existing Python callers use these endpoint functions as well as their HTTP routes.
from .routes.scene import scene_depth_combine
from .routes.effects import pose_find

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("comfydeck")

comfy = Comfy(config.COMFY_URL)
clients: set[WebSocket] = set()
finalizing: set[str] = set()
SEED_MAX = 2**48  # stays exact in JavaScript numbers
MAX_IMAGE_UPLOAD = 200 << 20  # a phone photo is ~5-20 MB; this only stops runaway uploads


# ---------------------------------------------------------------------------
# websocket fan-out to tablets
# ---------------------------------------------------------------------------
async def _send(ws: WebSocket, payload):
    try:
        if isinstance(payload, bytes):
            await asyncio.wait_for(ws.send_bytes(payload), 2)
        else:
            await asyncio.wait_for(ws.send_text(payload), 2)
        return True
    except Exception:
        return False


async def broadcast(payload):
    if not isinstance(payload, bytes):
        payload = json.dumps(payload)
    targets = list(clients)
    results = await asyncio.gather(*(_send(ws, payload) for ws in targets))
    for ws, ok in zip(targets, results):
        if not ok:
            clients.discard(ws)


def fill_facts(g: dict) -> bool:
    """A finished run's outputs with what the UI shows about each (ComfyUI doesn't say): a clip's length, size and
    frame rate, a sound's length, a picture's size, a motion's length and frame rate. An output saved as a plain
    "file" from before the motion and 3D kinds gets its kind. Looked at once per output ("facts"). True when
    something was added."""
    changed = False
    for o in g.get("outputs") or []:
        if o.get("facts"):
            continue
        path = output_file(g, o)
        try:
            if not path.is_file():
                continue
            if o.get("kind") == "file":
                k = imageprep.kind_of(o["filename"])
                if k == "file" and path.suffix.lower() == ".json":
                    try:
                        motion.read(path.read_bytes(), path.name)
                        k = "motion"
                    except ValueError:
                        pass
                o["kind"] = k
            if o["kind"] in ("video", "audio"):
                info = videoedit.probe(path)
                o["duration"] = round(info["duration"], 2)
                if o["kind"] == "video" and info.get("width"):
                    o.update(width=info["width"], height=info["height"], fps=round(info.get("fps") or 0, 3))
            elif o["kind"] == "image":
                with Image.open(path) as im:
                    o["width"], o["height"] = im.size
            elif o["kind"] == "motion":
                m = motion.read(path.read_bytes(), path.name)
                o.update(duration=m["seconds"], fps=m["fps"], frames=len(m["frames"]))
        except (subprocess.SubprocessError, OSError, ValueError, KeyError) as e:
            log.debug("no facts for %s: %s", o.get("filename"), e)
        o["facts"] = 1
        changed = True
    if changed:
        db.update_generation(g["id"], outputs=g["outputs"])
    return changed


def backfill_facts():
    """Runs from before their outputs' facts were kept get them (once: an output that has them is skipped)."""
    n = 0
    for g in db.all_generations():
        if g["status"] == "done" and fill_facts(g):
            n += 1
    if n:
        log.info("added output facts to %d runs", n)


async def push_gen(gid: int):
    g = db.get_generation(gid)
    if g and g["status"] == "done" and await asyncio.to_thread(fill_facts, g):
        g = db.get_generation(gid)
    if g:
        await broadcast({"type": "deck_generation", "data": g})
        if g["status"] == "done":   # the Board's light previews, made now so it opens fast
            asyncio.create_task(previews.warm([o["url"] for o in g["outputs"] if o.get("url") and o["kind"] in ("image", "video", "audio")]))


running_wf: dict[str, dict] = {}  # prompt_id -> workflow, for naming progress stages


def _workflow_for(pid: str) -> dict:
    if pid not in running_wf:
        g = db.get_by_prompt(pid)
        running_wf[pid] = (db.get_workflow(g["id"]) if g else None) or {}
        while len(running_wf) > 50:
            running_wf.pop(next(iter(running_wf)))
    return running_wf[pid]


# The running job's last live previews, so a page that reloads (or a tablet that wakes) gets them at once instead of
# waiting for the next step, and knows the animated layout: VideoHelperSuite's one VHS_latentpreview message and a frame per
# slot ([type][1][1][frame index][16-byte node id][jpeg]), or a single still. Kept for the prompt that is executing only.
LIVE = {"pid": None, "meta": None, "frames": {}, "still": None}


def _live_reset(pid):
    LIVE.update(pid=pid, meta=None, frames={}, still=None)


def _live_frame(payload: bytes):
    if len(payload) >= 32 and int.from_bytes(payload[4:8], "big") == 1 and int.from_bytes(payload[8:12], "big") == 1:
        LIVE["frames"][int.from_bytes(payload[12:16], "big")] = payload   # one slot of an animated preview
        LIVE["still"] = None
    else:
        LIVE["still"], LIVE["frames"] = payload, {}


async def live_replay(ws: WebSocket):
    """The cached previews to one client, after it has resynced (its active prompt is set, so it keeps them)."""
    if not LIVE["pid"]:
        return
    try:
        if LIVE["meta"]:
            await ws.send_text(json.dumps(LIVE["meta"]))
        for i in sorted(LIVE["frames"]):
            await ws.send_bytes(LIVE["frames"][i])
        if LIVE["still"]:
            await ws.send_bytes(LIVE["still"])
    except Exception:  # noqa: BLE001  (the socket closed: its onclose cleans up)
        pass


async def on_comfy(kind, payload):
    if kind == "binary":  # live sampler previews: forward untouched
        if LIVE["pid"]:
            _live_frame(payload)
        await broadcast(payload)
        return
    t, pid = payload.get("type"), (payload.get("data") or {}).get("prompt_id")
    if t == "execution_start" and pid:
        _live_reset(pid)
    elif t == "VHS_latentpreview" and (pid or LIVE["pid"]):
        if pid and pid != LIVE["pid"]:
            _live_reset(pid)
        LIVE["meta"] = payload
    elif t in ("execution_success", "execution_error", "execution_interrupted") or (t == "executing" and (payload.get("data") or {}).get("node") is None):
        if pid == LIVE["pid"]:
            _live_reset(None)
    await broadcast(payload)
    t = payload.get("type")
    data = payload.get("data") or {}
    pid = data.get("prompt_id")
    if not pid:
        return
    if t == "execution_start":
        wf = _workflow_for(pid)
        await broadcast({"type": "deck_stages", "data": {"prompt_id": pid, "stages": stages.stages_in(wf)}})
    elif t == "executing" and data.get("node"):
        await broadcast({"type": "deck_stage", "data": {"prompt_id": pid, **stages.describe_node(_workflow_for(pid), data["node"])}})
    elif t == "execution_cached" and data.get("nodes"):
        wf = _workflow_for(pid)
        await broadcast({"type": "deck_cached", "data": {"prompt_id": pid,
                         "stages": sorted({s for n in data["nodes"] if (s := stages.describe_node(wf, n)["stage"])})}})
    if t == "execution_start":
        g = db.get_by_prompt(pid)
        if g and g["status"] == "queued":
            db.update_generation(g["id"], status="running", started=time.time())
            await push_gen(g["id"])
    elif t == "execution_success" or (t == "executing" and data.get("node") is None):
        asyncio.create_task(finalize(pid))
    elif t == "execution_error":
        g = db.get_by_prompt(pid)
        if g:
            msg = f"{data.get('node_type', '')}: {data.get('exception_message', 'error')}".strip(": ")
            db.update_generation(g["id"], status="error", error=msg, finished=time.time())
            await push_gen(g["id"])
    elif t == "execution_interrupted":
        g = db.get_by_prompt(pid)
        if g:
            db.update_generation(g["id"], status="interrupted", finished=time.time())
            await push_gen(g["id"])


def output_file(g: dict, o: dict) -> Path:
    """Where a generation's output lives on disk (new per-project layout, or the old one)."""
    return config.PROJECTS_DIR / o["path"] if o.get("path") else config.GEN_DIR / str(g["id"]) / o["filename"]


def new_output(g: dict, filename: str) -> tuple[Path, str]:
    """A fresh path in the generation's project folder: projects/<project>/<00042>_<filename>."""
    rel = f"{db.project_folder(g['project_id'])}/{g['id']:05d}_{filename}"
    path = config.PROJECTS_DIR / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    return path, rel


def migrate_outputs():
    """Move outputs saved in the old data/generations/<id>/ layout into their project folders."""
    for g in db.all_generations():
        outs, moved = [], False
        for o in g["outputs"]:
            o = {k: v for k, v in o.items() if k != "url"}
            old = config.GEN_DIR / str(g["id"]) / o["filename"]
            if not o.get("path") and old.is_file():
                dst, o["path"] = new_output(g, o["filename"])
                shutil.move(old, dst)
                moved = True
            outs.append(o)
        if moved:
            db.update_generation(g["id"], outputs=outs)
            shutil.rmtree(config.GEN_DIR / str(g["id"]), ignore_errors=True)
            log.info("moved outputs of #%s into %s", g["id"], db.project_folder(g["project_id"]))


def _collect_outputs(outputs: dict, every: bool = False) -> list[dict]:
    """The files a run reported to keep (every=True: all of them, previews in ComfyUI's temp folder too)."""
    items = []
    for node_id, out in (outputs or {}).items():
        for key, vals in (out or {}).items():
            if not isinstance(vals, list):
                continue
            for it in vals:
                if isinstance(it, dict) and "filename" in it:
                    items.append({**it, "node": node_id, "key": key})
    saved = [i for i in items if i.get("type") == "output"]
    return items if every else saved or items  # templates that only use Preview nodes still get their images kept


async def tidy_comfy(pid: str, reported: list[dict], saved: list[Path], wf: dict | None):
    """After a run (storage.py's rules): ComfyUI keeps no copy of what ComfyChair saved, nor the files it wrote
    beside them; an auto-rig's mesh copy leaves its input folder; the run leaves ComfyUI's history."""
    try:
        if reported:
            await asyncio.to_thread(storage.drop_comfy_outputs, reported, saved)
        if p := storage.rig_input(wf):
            p.unlink(missing_ok=True)
        await comfy.forget(pid)
    except Exception:  # noqa: BLE001  (housekeeping never fails a run)
        log.warning("tidying ComfyUI after %s failed", pid, exc_info=True)


async def finalize(pid: str):
    if pid in finalizing:
        return
    finalizing.add(pid)
    gid = None
    try:
        g = None
        for _ in range(10):  # tiny race: Comfy may finish before we've stored the row
            g = db.get_by_prompt(pid)
            if g:
                break
            await asyncio.sleep(0.3)
        if not g or g["status"] in ("done", "error", "interrupted"):
            return
        gid = g["id"]
        entry = None
        for _ in range(10):
            entry = (await comfy.history(pid)).get(pid)
            if entry:
                break
            await asyncio.sleep(0.5)
        if not entry:
            return  # not finished yet; the reconcile loop will pick it up
        status = entry.get("status") or {}
        if status.get("status_str") == "error":
            msg = "Execution failed"
            for m in status.get("messages", []):
                if isinstance(m, list) and len(m) == 2 and m[0] == "execution_error":
                    msg = m[1].get("exception_message", msg)
            db.update_generation(gid, status="error", error=msg, finished=time.time())
            await tidy_comfy(pid, [], [], db.get_workflow(gid))
            return
        saved, used, wf, got = [], set(), db.get_workflow(gid), []
        for it in _collect_outputs(entry.get("outputs")):
            name = re.sub(r"[^\w.\-]", "_", Path(it["filename"]).name)
            while name in used:
                name = f"{Path(name).stem}_1{Path(name).suffix}"
            used.add(name)
            path, rel = new_output(g, name)
            src = {"filename": it["filename"], "subfolder": it.get("subfolder", ""), "type": it.get("type", "output")}
            await comfy.download(src["filename"], src["subfolder"], src["type"], path)
            got.append(path)
            # "comfy": where ComfyUI kept its own copy (gone once tidy_comfy has run; older runs still have one)
            cls = ((wf or {}).get(str(it["node"])) or {}).get("class_type", "")   # (what saved it: a motion node's .json)
            saved.append({"filename": name, "path": rel, "kind": imageprep.kind_of(name, cls), "node": it["node"], "comfy": src})
        db.update_generation(gid, status="done", outputs=saved, finished=time.time())
        await tidy_comfy(pid, _collect_outputs(entry.get("outputs"), every=True), got, wf)
    except Exception as e:
        log.exception("finalize failed for %s", pid)
        if gid:
            db.update_generation(gid, status="error", error=f"Saving outputs failed: {e}", finished=time.time())
    finally:
        finalizing.discard(pid)
        if gid:
            await push_gen(gid)
    if gid:   # a sheet run with Upscale on: its second pass, made from it (never from an upscale: no loop)
        await effects.sheet_follow_up(db.get_generation(gid))


async def reconcile_loop():
    """Safety net for missed websocket events (e.g. ComfyChair restarted mid-run). A run that ComfyUI
    has neither queued nor finished was lost (ComfyUI restarted mid-run), so it's marked interrupted
    instead of showing as running forever."""
    lost_since: dict[str, float] = {}
    while True:
        await asyncio.sleep(10)
        if not comfy.connected:
            continue
        try:
            pending = [g for g in db.pending_generations() if time.time() - g["created"] > 5
                       and not g["prompt_id"].startswith("edit-")]
            if not pending:
                lost_since.clear()
                continue
            q = await comfy.queue_state()
            known = {it[1] for it in q.get("queue_running", []) + q.get("queue_pending", [])}
            for g in pending:
                pid = g["prompt_id"]
                if (await comfy.history(pid)).get(pid):
                    lost_since.pop(pid, None)
                    await finalize(pid)
                elif pid in known:
                    lost_since.pop(pid, None)
                elif time.time() - lost_since.setdefault(pid, time.time()) > 25:  # two passes, so no race with finishing
                    lost_since.pop(pid, None)
                    db.update_generation(g["id"], status="interrupted", error="Lost: ComfyUI restarted or dropped the run",
                                         finished=time.time())
                    await push_gen(g["id"])
                    log.info("marked #%s as lost (not in ComfyUI's queue or history)", g["id"])
        except Exception:
            log.debug("reconcile pass failed", exc_info=True)


def comfy_copy(g: dict, o: dict, ours: Path) -> Path | None:
    """ComfyUI's own copy of an output (in its output folder), if it's on this machine. Newer outputs
    record where it is; for older ones it's looked up by name. Either way it only counts if it's
    the same size as ComfyChair's copy, so a different file that happens to share the name is kept."""
    out = config.COMFY_OUTPUT_DIR
    if not out or not ours.is_file():
        return None
    c = o.get("comfy")
    if c:
        if c.get("type") != "output":
            return None
        cands = [out / c.get("subfolder", "") / c["filename"]]
    else:
        sub = config.COMFY_INPUT_SUBFOLDER
        cands = [out / sub / db.project_folder(g["project_id"]) / o["filename"], out / sub / o["filename"]]
    size = ours.stat().st_size
    for p in cands:
        try:
            p = p.resolve()
            if p.is_relative_to(out) and p.is_file() and p.stat().st_size == size:
                return p
        except OSError:
            continue
    return None


def prune_crops(max_age_days=30):
    """Crops are made per run (crop_<hash>.png in ComfyUI's input folder) and remade when needed, so
    clear the ones not used for a month."""
    if not config.COMFY_INPUT_DIR:
        return
    cutoff = time.time() - max_age_days * 86400
    for p in (config.COMFY_INPUT_DIR / config.COMFY_INPUT_SUBFOLDER).glob("crop_*.png"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:
            pass


def prune_thumbs(max_age_days=30):
    """Thumbnails are cheap to remake, so drop the ones nobody has asked for in a month."""
    cutoff = time.time() - max_age_days * 86400
    for p in config.THUMB_DIR.glob("*.jpg"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    await asyncio.to_thread(migrate_outputs)
    await asyncio.to_thread(projects.sweep)   # a project copy cut off by a restart
    await asyncio.to_thread(prune_thumbs)
    await asyncio.to_thread(prune_crops)
    await asyncio.to_thread(videoprep.prune)
    await asyncio.to_thread(storage.prune_canvas)
    await asyncio.to_thread(audioedit.prune)
    for g in db.pending_generations():  # Video-tab renders run inside a request: a restart ends them
        if g["prompt_id"].startswith("edit-"):
            db.update_generation(g["id"], status="error", error="ComfyChair restarted during the render", finished=time.time())
    comfy.listeners.add(on_comfy)
    await comfy.start()
    task = asyncio.create_task(reconcile_loop())
    sweeper = asyncio.create_task(clipimport.sweeper())   # the clip importer's previews and leftovers
    painter = asyncio.create_task(paint_pruner())   # the Editor's paint files no tab names any more
    asyncio.create_task(asyncio.to_thread(backfill_facts))
    log.info("ComfyChair ready. ComfyUI at %s", config.COMFY_URL)
    yield
    task.cancel()
    sweeper.cancel()
    painter.cancel()
    await comfy.stop()


app = FastAPI(title="ComfyChair", lifespan=lifespan)
store.notify = broadcast  # the JSON document store (tabs, presets, objects...) tells every device when it saves
projects.notify = broadcast  # project list changes (made, renamed, reordered, copied, deleted)
projects.comfy_copy = comfy_copy
app.include_router(projects.router)
app.include_router(store.router)
app.include_router(sceneasset.router)
app.include_router(tracking.router)
app.include_router(network.router)
app.include_router(clipimport.router)
app.include_router(civitai.router)
app.include_router(voice.router)
app.include_router(craft.router)
app.include_router(previews.router)
app.include_router(promptaid.router)
app.include_router(looks.router)


class TokenGate:
    """With DECK_TOKEN set, every request (pages, files, API, websocket) needs the deck_token cookie.
    Opening any page with ?token=<token> sets it and redirects to the same page without it."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if not config.TOKEN or scope["type"] not in ("http", "websocket"):
            return await self.inner(scope, receive, send)
        cookies = {}
        for k, v in scope.get("headers", []):
            if k == b"cookie":
                for part in v.decode("latin-1").split(";"):
                    name, _, val = part.strip().partition("=")
                    cookies[name] = val
        if cookies.get("deck_token") == config.TOKEN:
            return await self.inner(scope, receive, send)
        query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
        if scope["type"] == "http" and query.get("token", [""])[0] == config.TOKEN:
            await send({"type": "http.response.start", "status": 303, "headers": [
                (b"location", (scope.get("path") or "/").encode()),
                (b"set-cookie", f"deck_token={config.TOKEN}; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly".encode())]})
            return await send({"type": "http.response.body", "body": b""})
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 4401})
        body = b"ComfyChair needs its access link: open http://<this box>:8190/?token=<DECK_TOKEN> once on this device."
        await send({"type": "http.response.start", "status": 401, "headers": [(b"content-type", b"text/plain; charset=utf-8")]})
        await send({"type": "http.response.body", "body": body})


app.add_middleware(TokenGate)


@app.exception_handler(httpx.HTTPError)
async def comfy_unreachable(request: Request, exc: httpx.HTTPError):
    # a file ComfyUI doesn't have is a 404 here too (not a failed request): a deleted input, say
    if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 404:
        return JSONResponse({"detail": "Not found in ComfyUI"}, status_code=404)
    return JSONResponse({"detail": f"ComfyUI request failed: {exc}"}, status_code=502)


async def object_info_or_none(refresh=False):
    try:
        return await comfy.object_info(refresh=refresh)
    except Exception:
        return None


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------


@app.get("/api/status")
async def status():
    return {"comfy_connected": comfy.connected, "comfy_url": config.COMFY_URL,
            "ffmpeg": imageprep.ffmpeg_available(), "ui_version": ui_version()}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    await ws.send_text(json.dumps({"type": "deck_comfy_status", "data": {"connected": comfy.connected}}))
    try:
        while True:
            msg = await ws.receive_text()  # pings keep the socket alive; "preview" asks for the running job's last previews
            if msg == "preview":
                await live_replay(ws)
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)


@app.get("/api/templates")
async def list_templates(refresh: bool = False):
    oi = await object_info_or_none(refresh)
    return [tpl.describe(t, oi) for t in tpl.load_all(config.TEMPLATES_DIR)]


@app.get("/api/templates/{tid}/workflow")
async def template_workflow(tid: str):
    t = tpl.get(config.TEMPLATES_DIR, tid)
    if not t:
        raise HTTPException(404, "Template not found")
    return t.workflow


LINEAGE_KINDS = ("video", "image", "audio")


def lineage(fields: list[dict], values: dict) -> dict | None:
    """What a run is made from, when its caller doesn't say: the first of its inputs that came from an
    output, a video input before a picture before a sound, each kind in the template's field order. A
    clip or sound is picked as its source ({generation, index}); a picture by its input name, whose
    origin was kept when an output was sent in (db.input_origins). One rule for every tab, and it holds
    after a reload or a second run of the same settings."""
    for kind in LINEAGE_KINDS:
        for f in fields:
            v = values.get(f["key"]) if f["kind"] == kind else None
            if isinstance(v, dict) and v.get("generation") is not None:
                return {"generation": v["generation"], "index": v.get("index", 0), "frame": None}
            if kind == "image" and isinstance(v, str) and v and (o := db.input_origin(v)):
                return o
    return None


async def _mask_dims(run: dict, flist: list[dict]) -> tuple[int, int] | None:
    """The picture's size, for a mask with Crop to mask (the box is placed in its pixels)."""
    mf = next((f for f in flist if f["kind"] == "mask"), None)
    m = mf and maskcomp.mask_of(run, mf)
    name = m and m.get("fit") and run.get(mf["image_key"])
    if not name:
        return None
    try:
        data = await input_bytes(name)
        return await asyncio.to_thread(lambda: ImageOps.exif_transpose(Image.open(io.BytesIO(data))).size)
    except Exception:
        return None   # (then it runs on the whole picture)


@app.post("/api/generate")
async def generate(body: dict = Body(...)):
    t = tpl.get(config.TEMPLATES_DIR, body.get("template", ""))
    if not t or t.error:
        raise HTTPException(400, t.error if t else "Template not found")
    oi = await object_info_or_none()
    fields = {f["key"]: f for f in tpl.describe(t, oi)["fields"]}
    values = body.get("values") or {}
    batch = max(1, min(int(body.get("batch", 1)), 32))
    project_id = body.get("project_id")
    parent = body.get("parent")

    created = []
    for i in range(batch):
        resolved, raw = {}, {}
        for key, f in fields.items():
            v = values.get(key, f["value"])
            if f["kind"] == "text" and wildcards.has(v):  # {a|b|c}: a fresh pick for every run
                raw[key] = v
                v = wildcards.expand(v)
            elif f["kind"] == "seed":
                v = int(v) if v not in (None, "") else -1
                v = random.randint(0, SEED_MAX) if v < 0 else v + i  # batches of a fixed seed step +1
            elif f["kind"] in ("int", "float") and v not in (None, ""):
                try:
                    v = int(v) if f["kind"] == "int" else float(v)
                except (TypeError, ValueError):
                    raise HTTPException(400, f"{f['group']} · {f['label']}: {v!r} isn't a number")
            resolved[key] = v
        run = dict(resolved)
        for key, f in fields.items():  # a picked video: params keep the source, ComfyUI gets the path
            if f["kind"] == "video" and resolved.get(key) and not isinstance(resolved[key], dict):
                raise HTTPException(400, f"{f['group']} · {f['label']}: pick the video again")
            if f["kind"] == "video" and isinstance(resolved.get(key), dict):
                path, kind = await _timeline_path(resolved[key], None)
                if kind != "video":
                    raise HTTPException(400, f"{f['group']} · {f['label']}: that isn't a video")
                spec = resolved[key]
                node = key.rpartition(".")[0]
                loader = {**t.workflow[node]["inputs"], **{k.rpartition(".")[2]: v for k, v in run.items() if k.rpartition(".")[0] == node}}
                try:  # trim/crop: the loader's own inputs, or a derived copy
                    vp = await asyncio.to_thread(videoprep.plan, path, spec.get("trim"), spec.get("crop"), loader)
                    if takes_sound(t.workflow, node):   # it keeps the clip's sound: a clip without one gets a silent track
                        vp["path"] = await asyncio.to_thread(videoprep.with_sound, Path(vp["path"]))
                except (ValueError, subprocess.SubprocessError) as e:
                    raise HTTPException(400, f"{f['group']} · {f['label']}: {e}")
                run[key] = str(vp["path"])
                run.update({f"{node}.{k}": v for k, v in vp["inputs"].items()})
            if f["kind"] == "audio" and resolved.get(key) and not isinstance(resolved[key], dict):
                raise HTTPException(400, f"{f['group']} · {f['label']}: pick the sound again")
            if f["kind"] == "audio" and isinstance(resolved.get(key), dict):
                path, kind = await _timeline_path(resolved[key], None)
                if kind not in ("audio", "video"):
                    raise HTTPException(400, f"{f['group']} · {f['label']}: that isn't a sound or a clip")
                try:  # a sound file as it is; a clip's sound, or a cut, as a FLAC copy the loader can open
                    run[key] = str(await asyncio.to_thread(audioedit.prep, path, resolved[key].get("trim")))
                except (ValueError, RuntimeError, subprocess.SubprocessError) as e:
                    raise HTTPException(400, f"{f['group']} · {f['label']}: {e}")
        if i == 0 and not parent:
            parent = lineage(list(fields.values()), resolved)
        flist = list(fields.values())
        if why := maskcomp.missing(run, flist):   # an inpaint template without its mask
            raise HTTPException(400, why)
        run = maskcomp.prefill(run, flist, t.workflow)   # a mask input of the template's own takes the painted mask
        wf = editsize.inject(accel.inject(tpl.apply(t.workflow, run), run), run, flist)
        wf = maskcomp.inject(wf, run, flist, await _mask_dims(run, flist))
        wf = h3upscale.apply_pose(h3upscale.drop_turbo_under_regen(wf), run)
        folder = db.project_folder(project_id)
        for node in wf.values():  # ComfyUI's own copy goes to output/comfydeck/<project>/ too
            fp = node["inputs"].get("filename_prefix")
            if isinstance(fp, str):
                node["inputs"]["filename_prefix"] = f"{config.COMFY_INPUT_SUBFOLDER}/{folder}/{fp.rsplit('/', 1)[-1]}"
        try:
            res = await comfy.queue(wf, preview=resolved.get(accel.PREVIEW))
        except ComfyError as e:
            if created:  # earlier runs of the batch are queued: say so, so the tablet can follow them
                raise HTTPException(400, {"message": f"Run {i + 1} of {batch} failed: {e}", "created": created})
            raise HTTPException(400, str(e))
        if body.get("builder"):  # the prompt builder's parts, so History can restore them for editing
            resolved["__builder"] = body["builder"]
        if isinstance(body.get("face"), dict):  # the tab that ran it and its settings there (e.g. a VFX effect), so Edit reopens it there
            resolved["__face"] = body["face"]
        if raw:  # the prompts as written, so Edit restores the wildcards (Run again keeps this run's picks)
            resolved["__wildcards"] = raw
        gid = db.create_generation(project_id, t.id, resolved, wf, res["prompt_id"], parent)
        created.append(db.get_generation(gid))
        await push_gen(gid)
    return created


@app.post("/api/interrupt")
async def interrupt(body: dict = Body(default={})):
    """Stop a run. With a prompt_id, only that run: interrupted if it's running, taken out of the
    queue if it's waiting, left alone if it's already over (so a late tap can't stop someone else's)."""
    pid = (body or {}).get("prompt_id")
    if not pid:
        await comfy.interrupt()
        return {"ok": True, "stopped": "current"}
    q = await comfy.queue_state()
    if pid in {it[1] for it in q.get("queue_running", [])}:
        await comfy.interrupt()
        return {"ok": True, "stopped": "running"}
    if pid in {it[1] for it in q.get("queue_pending", [])}:
        await comfy.delete_queued([pid])
        g = db.get_by_prompt(pid)
        if g and g["status"] == "queued":
            db.update_generation(g["id"], status="interrupted", error="Cancelled", finished=time.time())
            await push_gen(g["id"])
        return {"ok": True, "stopped": "queued"}
    return {"ok": True, "stopped": None}


@app.get("/api/queue")
async def queue_state():
    return await comfy.queue_state()


@app.post("/api/queue/cancel")
async def cancel_queued(body: dict = Body(...)):
    pid = body.get("prompt_id")
    await comfy.delete_queued([pid])
    g = db.get_by_prompt(pid)
    if g and g["status"] == "queued":
        db.update_generation(g["id"], status="interrupted", error="Cancelled", finished=time.time())
        await push_gen(g["id"])
    return {"ok": True}


# ---- history (projects: app/projects.py) ------------------------------------
@app.get("/api/generations")
async def generations(project_id: int | None = None, limit: int = 60, before: int | None = None,
                      edit_tab: str | None = None, status: str | None = None):
    return db.list_generations(project_id, min(limit, 200), before, edit_tab, status)


@app.get("/api/generations/{gid}")
async def generation(gid: int):
    g = db.get_generation(gid)
    if not g:
        raise HTTPException(404)
    return g


@app.get("/api/generations/{gid}/workflow")
async def generation_workflow(gid: int):
    """The exact workflow that ran. Drag the downloaded file into desktop ComfyUI to debug it."""
    wf = db.get_workflow(gid)
    if wf is None:
        raise HTTPException(404)
    return Response(json.dumps(wf, indent=2), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="comfydeck_{gid}.json"'})


@app.delete("/api/generations/{gid}")
async def delete_generation(gid: int):
    g = db.get_generation(gid)
    if not g:
        raise HTTPException(404)
    folder = db.project_folder(g["project_id"])
    db.delete_generation(gid)
    storage.drop_view_marks(folder, gid)
    for o in g["outputs"]:   # every copy (storage.py): ours, ComfyUI's (older runs still have one) and what it wrote
        ours = output_file(g, o)   # beside it, a mesh copied in for rigging, and the thumbnails and previews of it
        gone = [ours]
        if theirs := comfy_copy(g, o, ours):
            gone += storage.family(theirs)
        if config.COMFY_INPUT_DIR and ours.is_file():
            copy = config.COMFY_INPUT_DIR / "3d" / (re.sub(r"[^\w.\-]+", "_", ours.name)[:80] or "model.glb")
            if copy.is_file() and copy.stat().st_size == ours.stat().st_size:
                gone.append(copy)
        storage.drop_caches(ours.resolve())
        storage.remove(gone)
    shutil.rmtree(config.GEN_DIR / str(gid), ignore_errors=True)
    if g.get("prompt_id") and not g["prompt_id"].startswith("edit-"):
        await comfy.forget(g["prompt_id"])
    await broadcast({"type": "deck_generation_deleted", "data": {"id": gid}})
    return {"ok": True}


# ---- images -----------------------------------------------------------------
async def upload_prepared(png: bytes, project_id=None, source="upload") -> str:
    fname = f"{uuid.uuid4().hex[:12]}.png"
    (config.INPUT_DIR / fname).write_bytes(png)
    name = await comfy.upload_image(png, fname, config.COMFY_INPUT_SUBFOLDER)
    db.add_input(name, project_id, source)
    return name


def _project(v):
    return int(v) if v not in (None, "", "null") else None


@app.post("/api/upload")
async def upload(file: UploadFile = File(...), mp: float = Form(0), multiple: int = Form(8), crop: str = Form(""),
                 project_id: str = Form(""), source: str = Form("upload")):
    data = await file.read(MAX_IMAGE_UPLOAD + 1)
    if len(data) > MAX_IMAGE_UPLOAD:
        raise HTTPException(413, f"That image is over {MAX_IMAGE_UPLOAD >> 20} MB")
    crop_box = json.loads(crop) if crop else None
    try:
        png, w, h = await asyncio.to_thread(imageprep.prep, data, mp, multiple, crop_box)
    except Exception as e:
        raise HTTPException(400, f"Couldn't read that image: {e}")
    name = await upload_prepared(png, _project(project_id), source[:20])
    return {"name": name, "width": w, "height": h}


PAINT_SUB = "paint"   # the Editor's painted layers: kept here only, out of ComfyUI and the input galleries
MASK_SUB = "mask"     # masks painted over a Generate picture: here and in ComfyUI, out of the input galleries


def local_input(name: str) -> Path | None:
    """The local copy of one of ComfyChair's own input images (an upload or a painted layer), if there is one."""
    sub, _, fname = name.rpartition("/")
    fname = Path(fname).name
    if sub == config.COMFY_INPUT_SUBFOLDER:
        p = config.INPUT_DIR / fname
    elif sub in (f"{config.COMFY_INPUT_SUBFOLDER}/{PAINT_SUB}", f"{config.COMFY_INPUT_SUBFOLDER}/{MASK_SUB}"):
        p = config.INPUT_DIR / sub.rpartition("/")[2] / fname
    else:
        return None
    return p if p.is_file() else None


async def input_bytes(name: str) -> bytes:
    """An image in ComfyUI's input folder (ComfyChair's own uploads come from the local copies)."""
    local = local_input(name)
    if local:
        return local.read_bytes()
    sub, _, fname = name.rpartition("/")
    data, _ = await comfy.view(fname, sub, "input")
    return data


@app.post("/api/paint")
async def save_paint(request: Request):
    """A painted Editor layer (the PNG as the body). Named after its content, so a file never changes once
    written: undo, a duplicated tab or an older copy of the tab still find the pixels they had."""
    data = await request.body()
    if len(data) > MAX_IMAGE_UPLOAD:
        raise HTTPException(413, f"That image is over {MAX_IMAGE_UPLOAD >> 20} MB")

    def check():
        im = Image.open(io.BytesIO(data))
        if im.format != "PNG" or max(im.size) > 16384:
            raise ValueError("not a PNG of a usable size")
        im.verify()
        return im.size
    try:
        w, h = await asyncio.to_thread(check)
    except Exception as e:
        raise HTTPException(400, f"Couldn't read that image: {e}")
    fname = f"{hashlib.sha1(data).hexdigest()[:20]}.png"
    folder = config.INPUT_DIR / PAINT_SUB
    folder.mkdir(exist_ok=True)
    if not (folder / fname).is_file():
        tmp = folder / f".{fname}.tmp"
        tmp.write_bytes(data)
        tmp.replace(folder / fname)
    else:
        os.utime(folder / fname)   # the same pixels again: fresh, so prune_paint leaves it until its tab names it
    return {"name": f"{config.COMFY_INPUT_SUBFOLDER}/{PAINT_SUB}/{fname}", "width": w, "height": h}


@app.post("/api/inputs/mask")
async def save_mask(request: Request):
    """A mask painted over a Generate picture (the PNG as the body; white = change). Kept as greyscale, named after
    its content, here and in ComfyUI's input folder (the run loads it); it stays out of the input galleries."""
    data = await request.body()
    if len(data) > MAX_IMAGE_UPLOAD:
        raise HTTPException(413, f"That mask is over {MAX_IMAGE_UPLOAD >> 20} MB")

    def grey():
        im = Image.open(io.BytesIO(data))
        if im.format != "PNG" or max(im.size) > 16384:
            raise ValueError("not a PNG of a usable size")
        out = io.BytesIO()
        im.convert("L").save(out, "PNG", optimize=True)
        return out.getvalue(), im.size
    try:
        png, (w, h) = await asyncio.to_thread(grey)
    except Exception as e:
        raise HTTPException(400, f"Couldn't read that mask: {e}")
    fname = f"{hashlib.sha1(png).hexdigest()[:20]}.png"
    folder = config.INPUT_DIR / MASK_SUB
    folder.mkdir(exist_ok=True)
    (folder / fname).write_bytes(png)
    name = await comfy.upload_image(png, fname, f"{config.COMFY_INPUT_SUBFOLDER}/{MASK_SUB}")
    return {"name": name, "width": w, "height": h}


PAINT_KINDS = ("edit-tabs", "story-tabs")   # the store kinds whose documents name paint files
PAINT_NAME = re.compile(rf"{re.escape(PAINT_SUB)}/([0-9a-f]{{20}}\.png)")


def prune_paint(max_age_days=30):
    """Delete paint files older than a month that no Editor tab or story names: every project's and the library's
    edit tabs and stories (a shot's canvas: its layers and its picture), and their trashed copies still inside
    store.TRASH_DAYS (Undo can bring those back)."""
    folder = config.INPUT_DIR / PAINT_SUB
    if not folder.is_dir():
        return
    keep: set[str] = set()
    trash_cutoff = time.time_ns() - store.TRASH_DAYS * 86400 * 10**9
    dirs = [config.LIBRARY_DIR / k for k in PAINT_KINDS] + [d for k in PAINT_KINDS for d in config.PROJECTS_DIR.glob(f"*/.deck/{k}")]
    for d in dirs:
        docs = list(d.glob("*.json"))
        for p in (d / ".trash").glob("*.json") if (d / ".trash").is_dir() else []:
            ts = p.name[:-5].rpartition(".")[2]
            if not ts.isdigit() or int(ts) >= trash_cutoff:   # (an odd name: kept to be safe)
                docs.append(p)
        for p in docs:
            try:
                keep.update(PAINT_NAME.findall(p.read_text(errors="replace")))
            except OSError:
                return   # a doc we can't read might name any of them: delete nothing this time
    cutoff = time.time() - max_age_days * 86400
    for p in folder.glob("*.png"):
        try:
            if p.name not in keep and p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:
            pass


async def paint_pruner():
    """main.py's lifespan runs this: prune_paint() now and once a day."""
    while True:
        try:
            await asyncio.to_thread(prune_paint)
        except Exception:
            log.exception("pruning paint files failed")
        await asyncio.sleep(86400)


@app.post("/api/inputs/crop")
async def crop_input(body: dict = Body(...)):
    """Crop an input image ({name, crop: {x,y,w,h} fractions, mp, multiple}) for one run. The copy is
    named after the image and the crop, so the same crop reuses one file, and it stays out of the
    galleries (no local copy, no database row)."""
    name = body.get("name") or ""
    crop, mp, multiple = body.get("crop"), float(body.get("mp", 0)), int(body.get("multiple", 8))
    try:
        data = await input_bytes(name)
        key = hashlib.sha1(data + json.dumps([crop, mp, multiple], sort_keys=True).encode()).hexdigest()[:16]
        png, w, h = await video.crop_png(data, crop, mp, multiple)
    except Exception as e:
        raise HTTPException(400, f"Couldn't crop that image: {e}")
    origin = db.input_origin(body.get("name") or "")
    name = await comfy.upload_image(png, f"crop_{key}.png", config.COMFY_INPUT_SUBFOLDER)
    db.set_input_origin(name, origin)   # a cropped picture is still made from the same output
    return {"name": name, "width": w, "height": h}


@app.post("/api/generations/{gid}/to-input")
async def generation_to_input(gid: int, body: dict = Body(default={})):
    """Send an output (or a frame of a video: "first", "last" or an index like 96) back to ComfyUI as an input image."""
    g = db.get_generation(gid)
    if not g or not g["outputs"]:
        raise HTTPException(404, "No outputs")
    idx = int(body.get("index", 0))
    if not 0 <= idx < len(g["outputs"]):
        raise HTTPException(400, "Bad output index")
    out = g["outputs"][idx]
    path = output_file(g, out)
    which = body.get("frame", "last")
    try:
        if out["kind"] == "video":
            raw = await asyncio.to_thread(imageprep.frame_from_video, path, which)
        elif out["kind"] == "image":
            raw = await asyncio.to_thread(imageprep.frame_from_image, path, which)
        else:
            raise HTTPException(400, "That output isn't an image or video")
        png, w, h = await asyncio.to_thread(imageprep.prep, raw, float(body.get("mp", 0)),
                                            int(body.get("multiple", 8)), body.get("crop"))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))
    name = await upload_prepared(png, g["project_id"], "generation")
    source = {"generation": gid, "index": idx, "frame": which if out["kind"] == "video" else None}
    db.set_input_origin(name, source)
    return {"name": name, "width": w, "height": h, "source": source}


@app.get("/api/generations/{gid}/sheet-marks")
async def generation_sheet_marks(gid: int):
    """The frames a sheet run cut its picture from, as angles: where Mark views starts on that clip."""
    return h3upscale.sheet_marks(db.get_workflow(gid) or {})


# what the media library takes: pictures, clips and sounds (imageprep.KINDS)
MEDIA_KINDS = {ext: k for k in ("video", "audio", "image") for ext in imageprep.KINDS[k]}


def _media_entry(p: Path) -> dict:
    e = {"name": p.name, "url": f"/files/media/{quote(p.name)}", "kind": MEDIA_KINDS[p.suffix.lower()],
         "label": p.name.split("_", 1)[-1], "created": p.stat().st_mtime}
    play = playable.path_for(p.name)
    if play.is_file():   # a clip the browser can't play: the player gets the copy, the original stays for ffmpeg
        e["source"], e["url"] = e["url"], f"/files/playable/{quote(play.name)}"
    return e


@app.get("/api/media")
async def list_media():
    """Files uploaded for the Video tab (music, voice-overs, outside clips), newest first."""
    files = [p for p in config.MEDIA_DIR.iterdir() if p.is_file() and p.suffix.lower() in MEDIA_KINDS]
    return [_media_entry(p) for p in sorted(files, key=lambda p: p.stat().st_mtime, reverse=True)]


@app.post("/api/media")
async def upload_media(file: UploadFile = File(...)):
    stem, ext = Path(file.filename or "file").stem, Path(file.filename or "").suffix.lower()
    if ext not in MEDIA_KINDS:
        raise HTTPException(400, f"Can't use {ext or 'that'} files: try mp3, wav, m4a, mp4, webm, png or jpg")
    safe = re.sub(r"[^\w.-]+", "_", stem)[:60] or "file"
    path = config.MEDIA_DIR / f"{uuid.uuid4().hex[:8]}_{safe}{ext}"
    with path.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    if MEDIA_KINDS[ext] == "video":
        await asyncio.to_thread(playable.ensure, path)
    return _media_entry(path)


@app.delete("/api/media")
async def delete_media(name: str):
    """A media-library file and every cache made from it (its browser-playable copy, thumbnails, previews)."""
    path = config.MEDIA_DIR / Path(name).name
    if not path.is_file():
        raise HTTPException(404, "That file is gone")
    if (user := storage.media_used(path.name)):
        raise HTTPException(409, f"Project “{user}” uses this file: remove it there first")
    path.unlink()
    storage.drop_caches(path.name, path.resolve())
    return {"ok": True}


@app.post("/api/media/to-project")
async def media_to_project(body: dict = Body(...)):
    """A media-library file ({name, project_id}) copied into a project as an "import": it shows on the Board and in
    History like a generation, and every picker offers it."""
    path = config.MEDIA_DIR / Path(str(body.get("name") or "")).name
    if not path.is_file() or path.suffix.lower() not in MEDIA_KINDS:
        raise HTTPException(404, "That file is gone")
    kind = MEDIA_KINDS[path.suffix.lower()]
    label = path.name.split("_", 1)[-1]
    gid = db.create_generation(body.get("project_id"), "import", {"media": path.name, "label": label}, {},
                               f"import-{uuid.uuid4().hex}", None)
    out, rel = new_output(db.get_generation(gid), path.name.split("_", 1)[-1])
    await asyncio.to_thread(shutil.copy2, path, out)
    o = {"filename": out.name, "path": rel, "kind": kind, "node": "import"}
    if kind in ("video", "audio"):
        try:
            o["duration"] = round((await asyncio.to_thread(videoedit.probe, out))["duration"], 2)
        except (subprocess.SubprocessError, OSError, ValueError, KeyError):
            pass
    db.update_generation(gid, status="done", finished=time.time(), outputs=[o])
    await push_gen(gid)
    return db.get_generation(gid)


def takes_sound(wf: dict, loader: str) -> bool:
    """Whether a workflow uses a video loader's sound (VHS_LoadVideoPath's third output)."""
    return any(isinstance(v, list) and len(v) == 2 and v[0] == loader and v[1] == 2
               for n in wf.values() for v in (n.get("inputs") or {}).values())


async def _timeline_path(src: dict, tmp: Path) -> tuple[Path, str]:
    """(file on disk, kind) for a timeline clip's source: a generation output, an input image or
    an uploaded media file."""
    if src.get("generation") is not None:
        g = db.get_generation(int(src["generation"]))
        idx = int(src.get("index", 0))
        if not g or not 0 <= idx < len(g["outputs"]):
            raise HTTPException(400, f"Output #{src.get('generation')} is gone")
        o = g["outputs"][idx]
        return output_file(g, o), o["kind"]
    if src.get("input"):
        path = tmp / f"{uuid.uuid4().hex[:8]}.png"
        path.write_bytes(await input_bytes(src["input"]))
        return path, "image"
    if src.get("clip"):  # a 3D composition the browser rendered for this export (POST /api/scene/clip)
        path = config.SCENE_CLIP_DIR / Path(str(src["clip"])).name
        if not path.is_file():
            raise HTTPException(400, "A 3D scene clip wasn't rendered: export again")
        return path, "video"
    if src.get("canvas"):   # a clip put on a bigger canvas for Extend frame (POST /api/video/canvas), and its mask
        name = str(src["canvas"])   # <tag>-canvas_<key>_v (or <key>_v, made before the files carried the clip's tag)
        path = config.VIDEOPREP_DIR / (f"{name}.mp4" if re.fullmatch(r"[0-9a-f]{12}-canvas_[0-9a-f]{20}_[vm]", name) else f"canvas_{name}.mp4")
        if not re.fullmatch(r"([0-9a-f]{12}-canvas_)?[0-9a-f]{20}_[vm]", name) or not path.is_file():
            raise HTTPException(400, "The extended frame is gone: set it up again")
        return path, "video"
    if src.get("media"):
        path = config.MEDIA_DIR / Path(src["media"]).name
        if not path.is_file():
            raise HTTPException(400, f"{src['media']} is gone")
        return path, MEDIA_KINDS.get(path.suffix.lower(), "video")
    raise HTTPException(400, "Unknown clip source")


clipimport.media_entry = _media_entry  # cut clips land in the media library
voice.media_entry = _media_entry      # so do cleaned voices and spoken lines
voice.resolve_src = _timeline_path
promptaid.read_input = input_bytes   # Describe reads any input picture
tracking.resolve_src = _timeline_path  # motion tracking finds its clip the way the Video tab does
craft.resolve_src = _timeline_path     # so do documents sent to PhotoCraft / EffectCraft
craft.media_entry = _media_entry       # and what they bring back lands in the media library
craft.save_input = upload_prepared
looks.save_input = upload_prepared      # character sheets are input pictures
looks.input_bytes = input_bytes
looks.local_input = local_input
looks.output_path = output_file
tracking.comfy = comfy


@app.get("/api/lora-info")
async def lora_info(name: str, fetch: bool = False):
    """Civitai name, trigger words, base model, link and example media for a LoRA (needs rgthree-comfy)."""
    info = await comfy.lora_info(name, fetch)
    if info is None:
        raise HTTPException(404, "LoRA info needs the rgthree-comfy custom node in ComfyUI")
    if not fetch and not info.get("links"):
        info = await comfy.lora_info(name, True) or info
    civ = (info.get("raw") or {}).get("civitai") or {}
    return {
        "file": name, "name": info.get("name") or name.rsplit("/", 1)[-1],
        "base_model": info.get("baseModel"), "sha256": info.get("sha256"),
        "trained_words": [w.get("word") for w in info.get("trainedWords") or [] if w.get("word")],
        "link": next((l for l in info.get("links") or [] if "/models/" in l), None),
        "description": civ.get("description") or (civ.get("model") or {}).get("description"),
        "media": [{"url": i.get("url"), "type": i.get("type") or "image"} for i in (info.get("images") or [])[:8] if i.get("url")],
        "found": bool(info.get("links")),
    }


@app.get("/api/jobs")
async def jobs():
    """What's running and waiting (in ComfyUI's order) with timings, plus recent runs."""
    try:
        q = await comfy.queue_state()
    except Exception:
        q = {}
    order = [it[1] for it in q.get("queue_running", [])] + \
            [it[1] for it in sorted(q.get("queue_pending", []), key=lambda it: it[0])]
    now, avg_cache, active = time.time(), {}, []

    def avg(template):
        if template not in avg_cache:
            ts = db.run_times(template)
            avg_cache[template] = sum(ts) / len(ts) if ts else None
        return avg_cache[template]

    for pos, pid in enumerate(order):
        g = db.get_by_prompt(pid)
        if not g:
            active.append({"prompt_id": pid, "template": "(started outside ComfyChair)", "status": "running" if pos == 0 and q.get("queue_running") else "queued"})
            continue
        running = g["status"] == "running" or (pos == 0 and bool(q.get("queue_running")))
        active.append({**g, "status": "running" if running else "queued", "position": pos,
                       "elapsed": now - (g.get("started") or g["created"]) if running else None,
                       "waiting": now - g["created"], "typical": avg(g["template"]),
                       # so a tablet that reconnects mid-run can redraw its stage strip
                       "stages": stages.stages_in(_workflow_for(pid)) if running else None})
    # rough ETA: what's left of the running job plus the typical time of everything ahead
    t = 0.0
    for j in active:
        typ = j.get("typical")
        if j["status"] == "running":
            t += max(0.0, (typ or 0) - (j.get("elapsed") or 0))
        else:
            t += typ or 0
        j["eta"] = t if typ else None
    recent = [{**g, "duration": (g["finished"] - (g.get("started") or g["created"])) if g.get("finished") else None}
              for g in db.recent_finished()]
    return {"active": active, "recent": recent}


@app.post("/api/generations/{gid}/pin")
async def pin_generation(gid: int, body: dict = Body(default={})):
    if not db.get_generation(gid):
        raise HTTPException(404)
    db.update_generation(gid, pinned=1 if body.get("pinned", True) else 0)
    await push_gen(gid)
    return db.get_generation(gid)


@app.get("/api/inputs")
async def list_inputs(project_id: str = ""):
    """{"project": inputs made for this project (newest first, with when), "all": every input image}.
    ComfyUI's own list skips subfolders, so ComfyChair's uploads come from the local copies."""
    names = await comfy.input_images()
    prefix = config.COMFY_INPUT_SUBFOLDER + "/"
    local = sorted((p for p in config.INPUT_DIR.iterdir() if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)
    mine = [{"name": r["name"], "created": r["created"], "source": r["source"]}
            for r in db.project_inputs(_project(project_id)) if (config.INPUT_DIR / r["name"].rsplit("/", 1)[-1]).is_file()]
    return {"project": mine,
            "all": [prefix + p.name for p in local] + [n for n in names if not n.startswith(prefix)]}


@app.delete("/api/inputs")
async def delete_input(name: str):
    """A picture, for good: ComfyChair's copy, ComfyUI's, its thumbnails and its row (storage.delete_input). Runs
    that used it keep their record; running them again needs another picture."""
    if not name.startswith(config.COMFY_INPUT_SUBFOLDER + "/") or ".." in name.split("/"):
        raise HTTPException(400, "That isn't one of ComfyChair's pictures")
    freed = await asyncio.to_thread(storage.delete_input, name)
    await broadcast({"type": "deck_input_deleted", "data": {"name": name}})
    return {"ok": True, "freed": freed}


@app.get("/api/input")
async def input_image(name: str, thumb: int = 0):
    """Preview of an image in ComfyUI's input folder. thumb=N returns a cached JPEG at most N px wide."""
    sub, _, fname = name.rpartition("/")
    local = local_input(name)
    if thumb:
        thumb = max(64, min(thumb, 1024))
        cached = config.THUMB_DIR / f"{storage.tag(name)}-{thumb}.jpg"   # (storage.drop_caches finds it by the name)
        if not cached.is_file():
            if local:
                data = local.read_bytes()
            else:
                data, _ = await comfy.view(fname, sub, "input")
            try:
                cached.write_bytes(await asyncio.to_thread(imageprep.thumbnail, data, thumb))
            except Exception as e:
                raise HTTPException(415, f"Not an image: {e}")
        return Response(cached.read_bytes(), media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})
    if local:
        return Response(local.read_bytes(), media_type="image/png")
    data, ctype = await comfy.view(fname, sub, "input")
    return Response(data, media_type=ctype, headers={"Cache-Control": "max-age=3600"})


# Feature routers receive only the services they use; they never import the application.
route_services = RouteServices(
    comfy=comfy,
    output_file=output_file,
    new_output=new_output,
    push_gen=push_gen,
    upload_prepared=upload_prepared,
    input_bytes=input_bytes,
    timeline_path=_timeline_path,
    media_entry=_media_entry,
    project=_project,
    object_info_or_none=object_info_or_none,
)
for routes in (audio, effects, library, scene, video):
    routes.configure(route_services)
    app.include_router(routes.router)
web.install(app)
