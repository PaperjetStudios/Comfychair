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
from PIL import Image
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import accel, audioedit, clipimport, craft, delogo, h3upscale, posefind, previews, voice, config, db, editsize, imageprep, motion, stages, tracking, videoedit, videoprep, wildcards
from . import projects, store
from . import keyexpr, sceneasset
from . import templates as tpl
from .comfy import Comfy, ComfyError

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


async def on_comfy(kind, payload):
    if kind == "binary":  # live sampler previews: forward untouched
        await broadcast(payload)
        return
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


def _collect_outputs(outputs: dict) -> list[dict]:
    items = []
    for node_id, out in (outputs or {}).items():
        for key, vals in (out or {}).items():
            if not isinstance(vals, list):
                continue
            for it in vals:
                if isinstance(it, dict) and "filename" in it:
                    items.append({**it, "node": node_id, "key": key})
    saved = [i for i in items if i.get("type") == "output"]
    return saved or items  # templates that only use Preview nodes still get their images kept


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
            return
        saved, used, wf = [], set(), db.get_workflow(gid)
        for it in _collect_outputs(entry.get("outputs")):
            name = re.sub(r"[^\w.\-]", "_", Path(it["filename"]).name)
            while name in used:
                name = f"{Path(name).stem}_1{Path(name).suffix}"
            used.add(name)
            path, rel = new_output(g, name)
            src = {"filename": it["filename"], "subfolder": it.get("subfolder", ""), "type": it.get("type", "output")}
            await comfy.download(src["filename"], src["subfolder"], src["type"], path)
            # "comfy": where ComfyUI keeps its own copy, so deleting the generation can remove that too
            cls = ((wf or {}).get(str(it["node"])) or {}).get("class_type", "")   # (what saved it: a motion node's .json)
            saved.append({"filename": name, "path": rel, "kind": imageprep.kind_of(name, cls), "node": it["node"], "comfy": src})
        db.update_generation(gid, status="done", outputs=saved, finished=time.time())
    except Exception as e:
        log.exception("finalize failed for %s", pid)
        if gid:
            db.update_generation(gid, status="error", error=f"Saving outputs failed: {e}", finished=time.time())
    finally:
        finalizing.discard(pid)
        if gid:
            await push_gen(gid)


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
app.include_router(clipimport.router)
app.include_router(voice.router)
app.include_router(craft.router)
app.include_router(previews.router)


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
def ui_version() -> int:
    """Newest change to the UI's files: an open (installed) app compares it with what it loaded
    and offers a reload when they differ."""
    return int(max(f.stat().st_mtime for f in config.WEB_DIR.rglob("*") if f.is_file()))


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
            await ws.receive_text()  # we don't expect messages; this just keeps the socket alive
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
        wf = editsize.inject(accel.inject(tpl.apply(t.workflow, run), run), run, list(fields.values()))
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
    db.delete_generation(gid)
    for o in g["outputs"]:
        ours = output_file(g, o)
        theirs = comfy_copy(g, o, ours)
        if theirs:
            theirs.unlink(missing_ok=True)
        ours.unlink(missing_ok=True)
    shutil.rmtree(config.GEN_DIR / str(gid), ignore_errors=True)
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


def local_input(name: str) -> Path | None:
    """The local copy of one of ComfyChair's own input images (an upload or a painted layer), if there is one."""
    sub, _, fname = name.rpartition("/")
    fname = Path(fname).name
    if sub == config.COMFY_INPUT_SUBFOLDER:
        p = config.INPUT_DIR / fname
    elif sub == f"{config.COMFY_INPUT_SUBFOLDER}/{PAINT_SUB}":
        p = config.INPUT_DIR / PAINT_SUB / fname
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


PAINT_NAME = re.compile(rf"{re.escape(PAINT_SUB)}/([0-9a-f]{{20}}\.png)")


def prune_paint(max_age_days=30):
    """Delete paint files older than a month that no Editor tab names: every project's and the library's
    edit tabs, and their trashed copies still inside store.TRASH_DAYS (Undo can bring those back)."""
    folder = config.INPUT_DIR / PAINT_SUB
    if not folder.is_dir():
        return
    keep: set[str] = set()
    trash_cutoff = time.time_ns() - store.TRASH_DAYS * 86400 * 10**9
    dirs = [config.LIBRARY_DIR / "edit-tabs", *config.PROJECTS_DIR.glob("*/.deck/edit-tabs")]
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
        png, w, h = await asyncio.to_thread(imageprep.prep, data, mp, multiple, crop)
    except Exception as e:
        raise HTTPException(400, f"Couldn't crop that image: {e}")
    origin = db.input_origin(body.get("name") or "")
    name = await comfy.upload_image(png, f"crop_{key}.png", config.COMFY_INPUT_SUBFOLDER)
    db.set_input_origin(name, origin)   # a cropped picture is still made from the same output
    return {"name": name, "width": w, "height": h}


@app.post("/api/generations/{gid}/to-input")
async def generation_to_input(gid: int, body: dict = Body(default={})):
    """Send an output (or the first/last frame of a video) back to ComfyUI as an input image."""
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


# what the media library takes: pictures, clips and sounds (imageprep.KINDS)
MEDIA_KINDS = {ext: k for k in ("video", "audio", "image") for ext in imageprep.KINDS[k]}


def _media_entry(p: Path) -> dict:
    return {"name": p.name, "url": f"/files/media/{quote(p.name)}", "kind": MEDIA_KINDS[p.suffix.lower()],
            "label": p.name.split("_", 1)[-1], "created": p.stat().st_mtime}


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
    return _media_entry(path)


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
        name = str(src["canvas"])
        path = config.VIDEOPREP_DIR / f"canvas_{name}.mp4"
        if not re.fullmatch(r"[0-9a-f]{20}_[vm]", name) or not path.is_file():
            raise HTTPException(400, "The extended frame is gone: set it up again")
        return path, "video"
    if src.get("media"):
        path = config.MEDIA_DIR / Path(src["media"]).name
        if not path.is_file():
            raise HTTPException(400, f"{src['media']} is gone")
        return path, MEDIA_KINDS.get(path.suffix.lower(), "video")
    raise HTTPException(400, "Unknown clip source")


@app.post("/api/video/canvas")
async def video_canvas(body: dict = Body(...)):
    """A clip on a bigger (or differently shaped) canvas, for Extend frame: {source, trim, aspect (w / h), scale, cx,
    cy} -> {video, mask (sources for the inpaint template), plan}. The mask is white where the canvas is to be
    painted. Made once per clip and settings (data/tmp/videoprep)."""
    src = body.get("source") or {}
    path, kind = await _timeline_path(src, None)
    if kind != "video":
        raise HTTPException(400, "Extend frame needs a video clip")
    info = await asyncio.to_thread(videoedit.probe, path)
    try:
        plan = videoedit.canvas_plan(info["width"], info["height"], float(body.get("aspect") or info["width"] / info["height"]),
                                     float(body.get("scale") or 1), float(body.get("cx", 0.5)), float(body.get("cy", 0.5)))
    except (TypeError, ValueError, ZeroDivisionError) as e:
        raise HTTPException(400, f"Bad canvas settings: {e}")
    trim = body.get("trim") if isinstance(body.get("trim"), dict) else None
    st = path.stat()
    key = hashlib.sha1(json.dumps([str(path), st.st_size, st.st_mtime_ns, trim, plan], sort_keys=True).encode()).hexdigest()[:20]
    v, m = config.VIDEOPREP_DIR / f"canvas_{key}_v.mp4", config.VIDEOPREP_DIR / f"canvas_{key}_m.mp4"
    if not (v.is_file() and m.is_file()):
        try:
            await asyncio.to_thread(videoedit.canvas_clip, path, v, m, plan, trim)
        except Exception as e:
            v.unlink(missing_ok=True); m.unlink(missing_ok=True)
            raise HTTPException(400, str(e))
    return {"video": {"canvas": f"{key}_v"}, "mask": {"canvas": f"{key}_m"}, "plan": plan}


@app.post("/api/videos/probe")
async def video_probe(body: dict = Body(...)):
    """Size, length and rate of a picked video ({source: {generation, index} | {media}}), for the trim UI."""
    path, kind = await _timeline_path(body.get("source") or {}, None)
    if kind != "video":
        raise HTTPException(400, "That isn't a video")
    try:
        info = await asyncio.to_thread(videoedit.probe, path)
    except (subprocess.SubprocessError, OSError, ValueError, KeyError) as e:
        raise HTTPException(400, f"Couldn't read that video: {e}")
    return {**info, "frames": round(info["duration"] * info["fps"])}


@app.post("/api/videos/prep")
async def video_prep(body: dict = Body(...)):
    """A trimmed/cropped copy of a picked video ({source, trim: {start, len} seconds, crop: {x,y,w,h}
    fractions}) in data/tmp/videoprep, named after source+params so the same edit reuses one file.
    generate() does the same by itself; this is for trying it. Returns {path, width, height, duration, cached}."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed on the server")
    path, kind = await _timeline_path(body.get("source") or {}, None)
    if kind != "video":
        raise HTTPException(400, "That isn't a video")
    try:
        r = await asyncio.to_thread(videoprep.prep, path, body.get("trim"), body.get("crop"))
    except (ValueError, subprocess.SubprocessError, OSError) as e:
        raise HTTPException(400, str(e))
    return {**r, "path": str(r["path"])}


clipimport.media_entry = _media_entry  # cut clips land in the media library
voice.media_entry = _media_entry      # so do cleaned voices and spoken lines
voice.resolve_src = _timeline_path
tracking.resolve_src = _timeline_path  # motion tracking finds its clip the way the Video tab does
craft.resolve_src = _timeline_path     # so do documents sent to PhotoCraft / EffectCraft
craft.media_entry = _media_entry       # and what they bring back lands in the media library
craft.save_input = upload_prepared
tracking.comfy = comfy


@app.post("/api/video/render")
async def video_render(body: dict = Body(...)):
    """Render the Video tab's timeline ({tracks, items, width, height, fps}) into a new video in History."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    tracks = {t["id"]: t for t in body.get("tracks") or []}
    z_of = {tid: i for i, tid in enumerate(t["id"] for t in body.get("tracks") or [] if t.get("kind") == "video")}
    with tempfile.TemporaryDirectory() as td:
        items, sources, scenes = [], [], []
        for it in body.get("items") or []:
            tr = tracks.get(it.get("track"))
            if not tr:
                continue
            path, kind = await _timeline_path(it.get("src") or {}, Path(td))
            if kind not in ("video", "image", "audio"):
                raise HTTPException(400, f"{path.name} isn't a video, image or sound")
            items.append({**{k: it.get(k) for k in ("at", "in", "out", "x", "y", "scale", "fit", "opacity",
                                                    "volume", "fade_in", "fade_out", "rotation",
                                                    "anchor_x", "anchor_y", "chans")},   # chans: its keys (keyexpr.py)
                          "path": str(path), "kind": kind, "track": tr["id"], "z": z_of.get(tr["id"], 0),
                          "hidden": bool(tr.get("hidden")), "muted": bool(tr.get("muted"))})
            if (it.get("src") or {}).get("clip") and it.get("scene"):   # (an Editor animation's clip names no scene)
                scenes.append({k: (it.get("scene") or {}).get(k) for k in ("id", "name", "look", "rev")})
            if (it.get("src") or {}).get("generation") is not None:
                sources.append({"generation": it["src"]["generation"], "index": it["src"].get("index", 0),
                                "start": it.get("in"), "end": it.get("out")})
        if not items:
            raise HTTPException(400, "Add some clips first")
        size = f"{body['width']}×{body['height']}" if body.get("width") else "first clip's size"
        params = {"timeline": f"{len(items)} clips on {len(tracks)} tracks", "frame": size,
                  "fps": body.get("fps") or "first clip's", "clips": sources}
        if scenes:  # 3D compositions in it (live-linked scenes, rendered at export)
            params["scenes"] = scenes
        if isinstance(body.get("tab"), dict):  # which saved video edit (a video-tabs document) this came from
            params["edit_tab"] = {"id": str(body["tab"].get("id") or "")[:64], "name": str(body["tab"].get("name") or "")[:120]}
        parent = {"generation": sources[0]["generation"], "index": sources[0]["index"], "frame": None} if sources else None
        gid = db.create_generation(body.get("project_id"), "video edit", params, {}, f"edit-{uuid.uuid4().hex}", parent)
        db.update_generation(gid, status="running")
        await push_gen(gid)
        out, rel = new_output(db.get_generation(gid), "edit.mp4")
        try:
            info = await asyncio.to_thread(videoedit.render, items, out, body.get("width"), body.get("height"), body.get("fps"))
        except Exception as e:
            out.unlink(missing_ok=True)
            db.update_generation(gid, status="error", error=str(e), finished=time.time())
            await push_gen(gid)
            raise HTTPException(400, str(e))
    db.update_generation(gid, status="done", finished=time.time(),
                         outputs=[{"filename": out.name, "path": rel, "kind": "video", "node": "edit",
                                   "duration": round(info["duration"], 2)}])
    await push_gen(gid)
    return db.get_generation(gid)


@app.post("/api/pose/find")
async def pose_find(body: dict = Body(...)):
    """The newest finished Pose preview of a clip, for a drive to take instead of reading the pose again:
    {source: {generation, index} | {media}, trim, crop, poser: dwpose|sdpose, len (seconds)} ->
    {generation, index, frames, seconds, url, poser} or null (app/posefind.py says what matches)."""
    src = body.get("source") or {}
    if not isinstance(src, dict) or (src.get("generation") is None and not src.get("media")):
        raise HTTPException(400, "Pick a clip")
    poser = str(body.get("poser") or "dwpose")
    if poser not in posefind.TEMPLATES:
        raise HTTPException(400, "poser is dwpose or sdpose")
    try:
        secs = float(body.get("len") or 5)
    except (TypeError, ValueError):
        raise HTTPException(400, "len is in seconds")
    trim = body.get("trim") if isinstance(body.get("trim"), dict) else None
    crop = body.get("crop") if isinstance(body.get("crop"), dict) else None
    gens = db.done_with_templates([posefind.TEMPLATES[poser]])
    gens = [g for g in gens if posefind.same_clip((g["params"] or {}).get(posefind.SOURCE_KEY), src)]
    if not gens:
        return None
    clip_secs = None
    try:
        path, _ = await _timeline_path(src, None)
        clip_secs = (await asyncio.to_thread(videoedit.probe, path))["duration"] or None
    except (HTTPException, subprocess.SubprocessError, OSError, ValueError, KeyError):
        pass

    def measure(g, o):
        path = output_file(g, o)
        if not path.is_file():
            raise FileNotFoundError(path)
        try:
            info = videoedit.probe(path)
            return round(info["duration"] * (info.get("fps") or posefind.FPS)) or None
        except (subprocess.SubprocessError, OSError, ValueError, KeyError):
            return None

    return await asyncio.to_thread(posefind.find, gens, src, trim, crop, poser, secs, clip_secs, measure)


@app.post("/api/h3/upscale")
async def h3_upscale(body: dict = Body(...)):
    """A finished MiniMax H3 clip ({generation, index, scale, strength: light|medium|strong}) sampled again bigger, with the same run's prompt,
    LoRAs, references and seed (app/h3upscale.py). A new generation in History, made from the clip."""
    g = db.get_generation(int(body.get("generation", -1)))
    idx = int(body.get("index") or 0)
    if not g or g["status"] != "done" or not 0 <= idx < len(g["outputs"]) or g["outputs"][idx]["kind"] != "video":
        raise HTTPException(400, "Pick a finished H3 video")
    wf0 = db.get_workflow(g["id"])
    if not wf0 or not h3upscale.h3_node(wf0):
        raise HTTPException(400, "Only MiniMax H3 runs can be upscaled this way")
    oi = await object_info_or_none()
    if oi is not None and "MinimaxH3LatentUpscaler3D" not in oi:   # installed since it was read?
        oi = await object_info_or_none(refresh=True)
    if oi is not None and "MinimaxH3LatentUpscaler3D" not in oi:
        raise HTTPException(400, "ComfyUI doesn't have the MiniMax H3 latent upscaler (Comfyui_Minimax_h3_latent_Upscaler): "
                                 "install it and restart ComfyUI")
    path = output_file(g, g["outputs"][idx])
    try:
        info = await asyncio.to_thread(videoedit.probe, path)
    except (subprocess.SubprocessError, OSError, ValueError, KeyError) as e:
        raise HTTPException(400, f"Couldn't read the clip: {e}")
    scale = min(2.0, max(1.1, float(body.get("scale") or 1.5)))
    strength = h3upscale.STRENGTHS.get(str(body.get("strength") or "strong"))
    if strength is None:
        raise HTTPException(400, "Strength is light, medium or strong")
    folder = db.project_folder(g["project_id"])
    try:
        wf, (w, h) = h3upscale.build(wf0, str(path), info["width"], info["height"], scale,
                                     f"{config.COMFY_INPUT_SUBFOLDER}/{folder}/h3up", info.get("fps") or 24, strength)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        res = await comfy.queue(wf)
    except ComfyError as e:
        raise HTTPException(400, str(e))
    params = {"source": {"generation": g["id"], "index": idx}, "scale": scale, "strength": body.get("strength") or "strong",
              "frame": f"{w}×{h}",
              "from": f"{info['width']}×{info['height']}", "template": g["template"]}
    gid = db.create_generation(g["project_id"], "h3 upscale", params, wf, res["prompt_id"],
                               {"generation": g["id"], "index": idx, "frame": None})
    await push_gen(gid)
    return db.get_generation(gid)


async def _delogo_clip(body: dict) -> tuple[dict, Path, dict]:
    """(the source, the clip as the boxes were drawn on it: trimmed, cropped and upright, its probe)."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    src = body.get("source") or {}
    path, kind = await _timeline_path(src, None)
    if kind != "video":
        raise HTTPException(400, "Remove watermark needs a video clip")
    try:
        r = await asyncio.to_thread(videoprep.prep, path, body.get("trim"), body.get("crop"))
        info = await asyncio.to_thread(videoedit.probe, r["path"])
    except (ValueError, subprocess.SubprocessError, OSError) as e:
        raise HTTPException(400, str(e))
    return src, r["path"], info


@app.post("/api/video/delogo/find")
async def video_delogo_find(body: dict = Body(...)):
    """Where a watermark probably is ({source, trim, crop}) -> {boxes: [{x, y, w, h} fractions of the frame]}."""
    _, path, _ = await _delogo_clip(body)
    try:
        return {"boxes": await asyncio.to_thread(delogo.find_boxes, path)}
    except (subprocess.SubprocessError, OSError, ValueError) as e:
        raise HTTPException(400, f"Couldn't look through the clip: {e}")


@app.post("/api/video/delogo")
async def video_delogo(body: dict = Body(...)):
    """Remove watermark ({source, trim, crop, boxes: [{x, y, w, h} fractions], mode: quality|fast, project_id}): the
    boxes painted out of the clip (app/delogo.py). Quality queues ProPainter in ComfyUI; fast is ffmpeg's delogo,
    done here. A new generation in History, made from the clip."""
    src, path, info = await _delogo_clip(body)
    try:
        rects = delogo.boxes_px(body.get("boxes"), info["width"], info["height"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not rects:
        raise HTTPException(400, "Draw a box over the watermark first")
    mode = "fast" if body.get("mode") == "fast" else "quality"
    params = {"delogo": mode, "boxes": body.get("boxes"), "source": src,
              **({"trim": body["trim"]} if body.get("trim") else {}), **({"crop": body["crop"]} if body.get("crop") else {})}
    parent = ({"generation": src["generation"], "index": src.get("index", 0), "frame": None}
              if src.get("generation") is not None else None)
    project = body.get("project_id")
    if mode == "quality":
        oi = await object_info_or_none()
        if oi is not None and "ProPainterInpaint" not in oi:   # installed since it was read?
            oi = await object_info_or_none(refresh=True)
        if oi is not None and "ProPainterInpaint" not in oi:
            raise HTTPException(400, "ComfyUI doesn't have ProPainter (ComfyUI_ProPainter_Nodes): install it and restart ComfyUI")
        frames = max(2, int(round(info["duration"] * info["fps"])))
        folder = db.project_folder(project) if project else None
        prefix = f"{config.COMFY_INPUT_SUBFOLDER}/{folder}/delogo" if folder else f"{config.COMFY_INPUT_SUBFOLDER}/delogo"
        wf = delogo.build(str(path), info["width"], info["height"], info["fps"] or 24, frames, rects, prefix, info["audio"])
        try:
            res = await comfy.queue(wf)
        except ComfyError as e:
            raise HTTPException(400, str(e))
        gid = db.create_generation(project, "remove watermark", params, wf, res["prompt_id"], parent)
        await push_gen(gid)
        return db.get_generation(gid)
    gid = db.create_generation(project, "remove watermark", params, {}, f"delogo-{uuid.uuid4().hex}", parent)
    db.update_generation(gid, status="running")
    await push_gen(gid)
    out, rel = new_output(db.get_generation(gid), "clean.mp4")
    try:
        got = await asyncio.to_thread(delogo.fast, path, out, rects)
    except Exception as e:
        out.unlink(missing_ok=True)
        db.update_generation(gid, status="error", error=str(e), finished=time.time())
        await push_gen(gid)
        raise HTTPException(400, str(e))
    db.update_generation(gid, status="done", finished=time.time(),
                         outputs=[{"filename": out.name, "path": rel, "kind": "video", "node": "delogo",
                                   "duration": round(got["duration"], 2)}])
    await push_gen(gid)
    return db.get_generation(gid)


@app.post("/api/video/key")
async def video_key(body: dict = Body(...)):
    """A keyed copy of a clip in History, with alpha (VP9 webm): {source, mode: color|matte, matte (a
    source, for mode matte), color "#rrggbb", similarity, blend, spill, invert, project_id}."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    mode = body.get("mode") or "color"
    src = body.get("source") or {}
    path, kind = await _timeline_path(src, None)
    if kind != "video":
        raise HTTPException(400, "Keying needs a video clip")
    matte = None
    if mode == "matte":
        matte, mkind = await _timeline_path(body.get("matte") or {}, None)
        if mkind != "video":
            raise HTTPException(400, "The matte has to be a video")
    opts = {k: body[k] for k in ("color", "similarity", "blend", "spill", "invert") if body.get(k) is not None}
    if mode == "matte":
        opts = {"invert": bool(opts.get("invert"))}
    params = {"key": mode, **opts}
    if body.get("matte"):
        params["matte"] = body["matte"]
    parent = ({"generation": src["generation"], "index": src.get("index", 0), "frame": None}
              if src.get("generation") is not None else None)
    gid = db.create_generation(body.get("project_id"), "key", params, {}, f"key-{uuid.uuid4().hex}", parent)
    db.update_generation(gid, status="running")
    await push_gen(gid)
    out, rel = new_output(db.get_generation(gid), "keyed.webm")
    try:
        trim = body.get("trim") if isinstance(body.get("trim"), dict) else None
        info = await asyncio.to_thread(videoedit.key, path, out, mode, matte, trim, **opts)
    except Exception as e:
        out.unlink(missing_ok=True)
        db.update_generation(gid, status="error", error=str(e), finished=time.time())
        await push_gen(gid)
        raise HTTPException(400, str(e))
    db.update_generation(gid, status="done", finished=time.time(),
                         outputs=[{"filename": out.name, "path": rel, "kind": "video", "node": "key",
                                   "duration": round(info["duration"], 2), "alpha": True}])
    await push_gen(gid)
    return db.get_generation(gid)


@app.post("/api/video/matte")
async def video_matte(body: dict = Body(...)):
    """A cleaned or combined matte in History ({a, b (optional), combine: union|intersect|subtract|average, grow,
    close, smooth, feather, low, high, invert, project_id}): two mattes (say SAM3's and Alpha Gen's) made into one,
    grown or shrunk, holes filled, steadied, edged and feathered (videoedit.matte_filters). White = keep."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    a, ka = await _timeline_path(body.get("a") or {}, None)
    b = None
    if body.get("b"):
        b, kb = await _timeline_path(body["b"], None)
        if kb != "video":
            raise HTTPException(400, "The second matte has to be a video")
    if ka != "video":
        raise HTTPException(400, "The matte has to be a video")
    opts = {k: body[k] for k in ("grow", "close", "smooth", "feather", "low", "high", "invert") if body.get(k) is not None}
    if b:
        opts["combine"] = body.get("combine") or "union"
    params = {"matte": body.get("a"), **({"with": body["b"]} if b else {}), **opts}
    src = body.get("a") or {}
    parent = ({"generation": src["generation"], "index": src.get("index", 0), "frame": None}
              if src.get("generation") is not None else None)
    gid = db.create_generation(body.get("project_id"), "matte", params, {}, f"matte-{uuid.uuid4().hex}", parent)
    db.update_generation(gid, status="running")
    await push_gen(gid)
    out, rel = new_output(db.get_generation(gid), "matte.mp4")
    try:
        info = await asyncio.to_thread(videoedit.refine_matte, a, out, b, **opts)
    except Exception as e:
        out.unlink(missing_ok=True)
        db.update_generation(gid, status="error", error=str(e), finished=time.time())
        await push_gen(gid)
        raise HTTPException(400, str(e))
    db.update_generation(gid, status="done", finished=time.time(),
                         outputs=[{"filename": out.name, "path": rel, "kind": "video", "node": "matte",
                                   "duration": round(info["duration"], 2)}])
    await push_gen(gid)
    return db.get_generation(gid)


def _media_path(name: str, ext: str) -> Path:
    """A fresh media-library file for a made sound: <8 hex>_<name><ext>."""
    safe = re.sub(r"[^\w.-]+", "_", Path(name or "sound").stem)[:60] or "sound"
    return config.MEDIA_DIR / f"{uuid.uuid4().hex[:8]}_{safe}{ext}"


def _sound_format(body: dict) -> str:
    fmt = str(body.get("format") or "m4a").lower()
    if fmt not in audioedit.FORMATS:
        raise HTTPException(400, f"Can't write {fmt} sound: pick m4a, wav, mp3 or flac")
    return fmt


@app.post("/api/audio/extract")
async def audio_extract(body: dict = Body(...)):
    """The sound of a clip ({source: {generation, index} | {media}}, trim {start, len} seconds) as its own
    file in the media library (format m4a | wav | mp3 | flac, name), to edit or use as a reference."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    path, kind = await _timeline_path(body.get("source") or {}, None)
    if kind not in ("video", "audio"):
        raise HTTPException(400, "That has no sound")
    out = _media_path(body.get("name") or f"{path.stem}-sound", "." + _sound_format(body))
    try:
        await asyncio.to_thread(audioedit.extract, path, out, body.get("trim") if isinstance(body.get("trim"), dict) else None)
    except (ValueError, RuntimeError, subprocess.SubprocessError) as e:
        out.unlink(missing_ok=True)
        raise HTTPException(400, f"Couldn't take the sound out: {e}")
    return _media_entry(out)


@app.post("/api/sound/render")
async def sound_render(body: dict = Body(...)):
    """Mix the Sound tab's timeline ({tracks, items, name, format, gain, normalize}) into one sound file in
    the media library."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    tracks = {t["id"]: t for t in body.get("tracks") or []}
    solo = {tid for tid, t in tracks.items() if t.get("solo")}
    items = []
    for it in body.get("items") or []:
        tr = tracks.get(it.get("track"))
        if not tr:
            continue
        path, kind = await _timeline_path(it.get("src") or {}, None)
        if kind not in ("video", "audio"):
            raise HTTPException(400, f"{path.name} has no sound")
        tvol, tpan = float(tr.get("volume", 1) if tr.get("volume") is not None else 1), float(tr.get("pan") or 0)
        items.append({**{k: it.get(k) for k in ("at", "in", "out", "fade_in", "fade_out")},
                      "volume": float(it.get("volume", 1) if it.get("volume") is not None else 1) * tvol,
                      "pan": max(-1.0, min(1.0, float(it.get("pan") or 0) + tpan)),
                      "chans": keyexpr.with_track(it.get("chans"), tvol, tpan),   # keyed level / pan (keyexpr.py)
                      "path": str(path), "kind": kind, "track": tr["id"],
                      "muted": bool(tr.get("muted")) or bool(solo) and tr["id"] not in solo})
    if not items:
        raise HTTPException(400, "Add some sound first")
    out = _media_path(body.get("name") or "mix", "." + _sound_format(body))
    try:
        info = await asyncio.to_thread(audioedit.render, items, out, float(body.get("gain") or 1), bool(body.get("normalize")))
    except Exception as e:
        out.unlink(missing_ok=True)
        raise HTTPException(400, str(e))
    return {**_media_entry(out), "duration": round(info["duration"], 2)}


@app.post("/api/audio/lay")
async def audio_lay(body: dict = Body(...)):
    """A copy of a clip with a sound on it, in History: {video, sound (sources), mode replace|mix, at (s),
    volume, keep (the clip's own sound, for mix), sound_trim {start, len}, project_id}."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    vsrc, ssrc = body.get("video") or {}, body.get("sound") or {}
    vpath, vkind = await _timeline_path(vsrc, None)
    if vkind != "video":
        raise HTTPException(400, "Pick a video to put the sound on")
    spath, skind = await _timeline_path(ssrc, None)
    if skind not in ("audio", "video"):
        raise HTTPException(400, "That has no sound")
    mode = "mix" if body.get("mode") == "mix" else "replace"
    params = {"sound": ssrc, "mode": mode, "at": body.get("at") or 0, "volume": body.get("volume", 1)}
    if mode == "mix":
        params["keep"] = body.get("keep", 1)
    parent = ({"generation": vsrc["generation"], "index": vsrc.get("index", 0), "frame": None}
              if vsrc.get("generation") is not None else None)
    gid = db.create_generation(body.get("project_id"), "add sound", params, {}, f"edit-sound-{uuid.uuid4().hex}", parent)
    db.update_generation(gid, status="running")
    await push_gen(gid)
    out, rel = new_output(db.get_generation(gid), "with-sound.mp4")
    try:
        trim = body.get("sound_trim") if isinstance(body.get("sound_trim"), dict) else None
        info = await asyncio.to_thread(audioedit.lay, vpath, spath, out, mode, float(body.get("at") or 0),
                                       float(body.get("volume", 1)), float(body.get("keep", 1)), trim)
    except Exception as e:
        out.unlink(missing_ok=True)
        db.update_generation(gid, status="error", error=str(e), finished=time.time())
        await push_gen(gid)
        raise HTTPException(400, str(e))
    db.update_generation(gid, status="done", finished=time.time(),
                         outputs=[{"filename": out.name, "path": rel, "kind": "video", "node": "sound",
                                   "duration": round(info["duration"], 2)}])
    await push_gen(gid)
    return db.get_generation(gid)


@app.post("/api/motion/file")
async def motion_file(file: UploadFile = File(...)):
    """A motion file (.npz / .json with 22+ joint positions per frame) as the 3D tab's motion (app/motion.py)."""
    data = await file.read()
    if len(data) > 64 * 1024 * 1024:
        raise HTTPException(400, "That motion file is too big")
    try:
        return await asyncio.to_thread(motion.read, data, file.filename or "motion.npz")
    except Exception as e:
        raise HTTPException(400, f"Couldn't read that motion: {e}")


@app.post("/api/motion/from")
async def motion_from(body: dict = Body(...)):
    """A generation's motion output ({generation, index}): text-to-motion and mocap templates save .npz/.json."""
    g = db.get_generation(int(body.get("generation", -1)))
    if not g:
        raise HTTPException(404, "No such generation")
    outs = [o for o in g["outputs"] if Path(o["filename"]).suffix.lower() in (".npz", ".json")]
    idx = body.get("index")
    o = g["outputs"][int(idx)] if idx is not None and 0 <= int(idx) < len(g["outputs"]) else (outs[0] if outs else None)
    if not o:
        raise HTTPException(400, "That run has no motion file")
    try:
        return await asyncio.to_thread(motion.read, output_file(g, o).read_bytes(), o["filename"])
    except Exception as e:
        raise HTTPException(400, f"Couldn't read that motion: {e}")


@app.post("/api/scene/render")
async def scene_render(frames: list[UploadFile] = File(...), fps: float = Form(24), blur: float = Form(0),
                       scene: str = Form("{}"), project_id: str = Form(""), kind: str = Form("depth")):
    """The 3D tab's depth (or pose) frames (PNGs, in order) as a control video in History. The scene
    goes in the params so the 3D tab can open it again; blur softens the edges so H3 follows less literally."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    if not 2 <= len(frames) <= 1000:
        raise HTTPException(400, "A scene needs 2 to 1000 frames")
    if kind not in ("depth", "pose"):
        raise HTTPException(400, "kind is depth or pose")
    try:
        scene_data = json.loads(scene)
    except ValueError:
        raise HTTPException(400, "Bad scene")
    params = {"frames": len(frames), "fps": fps, "blur": blur, "kind": kind, "scene": scene_data}
    gid = db.create_generation(_project(project_id), "3d scene", params, {}, f"scene-{uuid.uuid4().hex}", None)
    db.update_generation(gid, status="running")
    await push_gen(gid)
    out, rel = new_output(db.get_generation(gid), f"{kind}.mp4")
    with tempfile.TemporaryDirectory() as td:
        for i, f in enumerate(frames):
            (Path(td) / f"f{i:05d}.png").write_bytes(await f.read())
        vf = (f"gblur=sigma={blur:g}," if blur > 0 else "") + "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p"
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", f"{fps:g}", "-i", str(Path(td) / "f%05d.png"),
               "-vf", vf, *videoedit.h264(12), "-movflags", "+faststart", str(out)]
        r = await asyncio.to_thread(videoedit.run_ffmpeg, cmd, text=True)
    if r.returncode:
        out.unlink(missing_ok=True)
        db.update_generation(gid, status="error", error=r.stderr[-500:], finished=time.time())
        await push_gen(gid)
        raise HTTPException(400, r.stderr[-500:] or "ffmpeg failed")
    db.update_generation(gid, status="done", finished=time.time(),
                         outputs=[{"filename": out.name, "path": rel, "kind": "video", "node": "scene",
                                   "duration": round(len(frames) / fps, 2)}])
    await push_gen(gid)
    return db.get_generation(gid)


SCENE_CLIP_TTL = 24 * 3600
CLIP_TOKEN = re.compile(r"[0-9a-f]{8,32}")


def _sweep_scene_clips():
    """Drop finished clips and unfinished uploads older than a day."""
    for p in config.SCENE_CLIP_DIR.iterdir():
        try:
            if time.time() - p.stat().st_mtime > SCENE_CLIP_TTL:
                shutil.rmtree(p, ignore_errors=True) if p.is_dir() else p.unlink(missing_ok=True)
        except OSError:
            pass


@app.post("/api/scene/clip")
async def scene_clip(frames: list[UploadFile] = File(...), token: str = Form(...), start: int = Form(0),
                     fps: float = Form(24), done: bool = Form(False)):
    """A 3D composition's frames (PNGs) for a video export, sent in batches under one token: `start` is
    the index of the batch's first frame. With done=true the frames so far become a temporary mp4 that
    /api/video/render takes as a clip source ({"clip": name}). Nothing goes to History."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    if not CLIP_TOKEN.fullmatch(token) or start < 0 or not 0 < fps <= 120 or len(frames) > 500:
        raise HTTPException(400, "Bad scene clip request")
    work = config.SCENE_CLIP_DIR / f"{token}.frames"
    work.mkdir(exist_ok=True)
    for i, f in enumerate(frames):
        data = await f.read()
        if not data.startswith(b"\x89PNG"):
            raise HTTPException(400, "Frames must be PNGs")
        (work / f"f{start + i:05d}.png").write_bytes(data)
    if not done:
        return {"frames": len(list(work.glob("f*.png")))}
    n = len(list(work.glob("f*.png")))
    if n < 1 or not (work / f"f{n - 1:05d}.png").exists():
        shutil.rmtree(work, ignore_errors=True)
        raise HTTPException(400, "Missing frames: send them in order")
    out = config.SCENE_CLIP_DIR / f"{token}.mp4"
    vf = "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p"
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-framerate", f"{fps:g}", "-i", str(work / "f%05d.png"),
           "-vf", vf, *videoedit.h264(12), "-movflags", "+faststart", str(out)]
    r = await asyncio.to_thread(videoedit.run_ffmpeg, cmd, text=True)
    shutil.rmtree(work, ignore_errors=True)
    if r.returncode:
        out.unlink(missing_ok=True)
        raise HTTPException(400, r.stderr[-500:] or "ffmpeg failed")
    await asyncio.to_thread(_sweep_scene_clips)
    return {"clip": out.name, "frames": n, "duration": round(n / fps, 3)}


@app.post("/api/scene/photo")
async def scene_photo(body: dict = Body(...)):
    """A picture as a 3D mesh for the 3D tab: MoGe (ComfyUI's core nodes) estimates its depth and
    camera, and the mesh, textured with the picture and torn where the depth jumps, comes back as a
    GLB in History (glTF axes: the photo's camera at the origin, looking down -Z)."""
    image = (body or {}).get("image")
    if not isinstance(image, str) or not image:
        raise HTTPException(400, "Pick a picture")
    spec = (await comfy.object_info()).get("LoadMoGeModel")
    if not spec:
        raise HTTPException(400, "ComfyUI has no MoGe nodes: update ComfyUI")
    opt = spec["input"]["required"]["model_name"]
    models = opt[1].get("options", []) if opt and opt[0] == "COMBO" else opt[0] if opt and isinstance(opt[0], list) else []
    if not models:
        raise HTTPException(400, "No MoGe model: put one from Comfy-Org/MoGe (Hugging Face) in ComfyUI/models/geometry_estimation")
    model = next((m for m in models if "moge_3_vitl" in m), None) or next((m for m in models if "moge_2" in m), models[0])
    project_id = _project(body.get("project_id"))
    detail = min(8, max(1, int(body.get("decimation") or 4)))  # 1 = a vertex per pixel; 4 keeps a tablet happy
    wf = {
        "1": {"class_type": "LoadImage", "inputs": {"image": image}},
        "2": {"class_type": "LoadMoGeModel", "inputs": {"model_name": model}},
        "3": {"class_type": "MoGeInference", "inputs": {"moge_model": ["2", 0], "image": ["1", 0], "resolution_level": 9,
              "fov_x_degrees": 0.0, "batch_size": 4, "force_projection": True, "apply_mask": True, "refine_steps": 3}},
        "4": {"class_type": "MoGePointMapToMesh", "inputs": {"moge_geometry": ["3", 0], "batch_index": 0,
              "decimation": detail, "discontinuity_threshold": 0.04, "texture": True}},
        "5": {"class_type": "SaveGLB", "inputs": {"mesh": ["4", 0], "filename_prefix":
              f"{config.COMFY_INPUT_SUBFOLDER}/{db.project_folder(project_id)}/photo3d"}},
    }
    try:
        res = await comfy.queue(wf)
    except ComfyError as e:
        raise HTTPException(400, str(e))
    gid = db.create_generation(project_id, "3d photo", {"image": image, "model": model, "decimation": detail},
                               wf, res["prompt_id"], None)
    await push_gen(gid)
    return db.get_generation(gid)


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


@app.get("/api/snippets")
async def snippets():
    return db.list_snippets()


@app.post("/api/snippets")
async def save_snippet(body: dict = Body(...)):
    category, text = (body.get("category") or "").strip()[:40], (body.get("text") or "").strip()
    if not category or not text:
        raise HTTPException(400, "category and text required")
    name = (body.get("name") or "").strip()[:80] or " ".join(text.split()[:6])
    return db.save_snippet(category, name, text, body.get("id"))


@app.delete("/api/snippets/{sid}")
async def delete_snippet(sid: int):
    db.delete_snippet(sid)
    return {"ok": True}


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


@app.get("/api/input")
async def input_image(name: str, thumb: int = 0):
    """Preview of an image in ComfyUI's input folder. thumb=N returns a cached JPEG at most N px wide."""
    sub, _, fname = name.rpartition("/")
    local = local_input(name)
    if thumb:
        thumb = max(64, min(thumb, 1024))
        key = hashlib.sha1(f"{name}:{thumb}".encode()).hexdigest()[:20]
        cached = config.THUMB_DIR / f"{key}.jpg"
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


# ---- static -----------------------------------------------------------------
app.mount("/files/projects", StaticFiles(directory=config.PROJECTS_DIR), name="projects")
app.mount("/files/library", StaticFiles(directory=config.LIBRARY_DIR), name="library")
app.mount("/files/media", StaticFiles(directory=config.MEDIA_DIR), name="media")
app.mount("/files/generations", StaticFiles(directory=config.GEN_DIR), name="generations")


class AppFiles(StaticFiles):
    """The UI's own files: the browser must check back every time (a cheap 304 when nothing
    changed). Without this, tablets keep an old app.js for hours after an update."""

    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        r.headers["Cache-Control"] = "no-cache"
        return r


APP_NAME = os.environ.get("DECK_NAME", "ComfyChair")   # a second copy (another port) installs as its own app by this name


@app.get("/manifest.webmanifest", include_in_schema=False)
async def manifest():
    """The PWA manifest with this copy's name (DECK_NAME), so two copies on one box are two home-screen apps."""
    m = json.loads((config.WEB_DIR / "manifest.webmanifest").read_text(encoding="utf-8"))
    m["name"] = m["short_name"] = APP_NAME
    return Response(json.dumps(m), media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


@app.get("/", include_in_schema=False)
@app.get("/index.html", include_in_schema=False)
async def index():
    """index.html with app.js / app.css links that change whenever the UI's files do, so a copy cached
    by an older version can't be reused. app.js gets the newest change over all web/ files, because
    the modules it imports (see module_js) are versioned the same way."""
    html = (config.WEB_DIR / "index.html").read_text(encoding="utf-8")
    if APP_NAME != "ComfyChair":
        html = html.replace("<title>ComfyChair</title>", f"<title>{escape(APP_NAME)}</title>")
    html = html.replace('"app.js"', f'"app.js?v={ui_version()}"')
    v = int((config.WEB_DIR / "app.css").stat().st_mtime)
    html = html.replace('"app.css"', f'"app.css?v={v}"')
    return Response(html, media_type="text/html", headers={"Cache-Control": "no-cache"})


# './x.js' in `from './x.js'` and `import('./x.js')` (not ./vendor/…: those never change)
_JS_IMPORT = re.compile(r"""(\bfrom\s*|\bimport\s*\(\s*)(['"])(\./[\w-]+\.js)\2""")
_module_cache: dict[tuple[str, int], str] = {}


@app.get("/{name}.js", include_in_schema=False)
async def module_js(name: str, request: Request):
    """The UI's ES modules (web/*.js) with every relative import carrying ?v=<ui_version>: a change to
    any one of them gives all of them new URLs, so the browser never mixes old and new modules (or
    keeps a stale one) however it caches. ETag/304 keeps unchanged loads cheap."""
    path = config.WEB_DIR / f"{name}.js"
    if "/" in name or not path.is_file():
        raise HTTPException(404)
    # a module asked for at a version keeps its imports at that version: a page opened before an update that
    # loads a module late (a dynamic import) would otherwise import the newer URLs of modules it already has,
    # and run a second copy of each (a second Editor tool strip, a second core.js state). The page is offered
    # a reload when the UI is newer (run.js checkUiVersion).
    asked = request.query_params.get("v", "")
    v = int(asked) if asked.isdigit() else ui_version()
    etag = f'"{name}-{v}"'
    headers = {"Cache-Control": "no-cache", "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    text = _module_cache.get((name, v))
    if text is None:
        text = _JS_IMPORT.sub(lambda m: f"{m[1]}{m[2]}{m[3]}?v={v}{m[2]}", path.read_text(encoding="utf-8"))
        if len(_module_cache) > 400:   # (pages on older versions ask too: keep a few versions' worth)
            _module_cache.clear()
        _module_cache[(name, v)] = text
    return Response(text, media_type="text/javascript", headers=headers)


app.mount("/", AppFiles(directory=config.WEB_DIR, html=True), name="web")
