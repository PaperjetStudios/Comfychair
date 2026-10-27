"""Open ComfyDeck work in PhotoCraft and EffectCraft with its layers and tracks, and bring the result back.

  POST /api/craft/photo        an Editor edit: {project_id, title, canvas: {w, h, bg}, layers: [{src, crop, rect,
                               hidden, name}]} (bottom layer first; crop in fractions of the image, rect in canvas px)
  POST /api/craft/video        a Video tab timeline: {project_id, title, width, height, fps, tracks, items} as
                               /api/video/render takes it
  POST /api/craft/vfx          a VFX tab: {project_id, title, source: {..., trim}, matte, results: [{generation,
                               index, label, showing}]}
  POST /api/craft/generation   one output: {generation, index}
  GET  /api/craft              what was sent (?project_id=), newest first
  POST /api/craft/{id}/open    open it in its app again
  POST /api/craft/{id}/back    a job: the saved document rendered into the media library (PNG, or MP4)
  POST /api/craft/input        {name}: a brought-back picture as an input image, for the Editor or Generate

Each document lives in data/craft/<id>/ (deck.pcraft or deck.ecproj, the footage it needs, meta.json) and opens
in the app on this computer's screen. Edit and save it there; Bring back renders what was last saved.
PhotoCraft gets one smart object per layer, cropped, placed and scaled as in the Editor. EffectCraft gets one
comp with a layer per clip: start, trim, position, scale, rotation, opacity, fades as keyframes, sound level, and
the tracks' hide and mute, stacked as the tracks are."""
import asyncio
import io
import json
import math
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from PIL import Image

from . import clipimport, config, db, videoedit

router = APIRouter(prefix="/api/craft")
resolve_src = None   # main.py sets it: (src dict, folder) -> (path, kind), as the Video tab finds clips
media_entry = None   # main.py sets it: (Path) -> the media library's JSON for a file
save_input = None    # main.py sets it: async (png bytes, project_id, source) -> an input image's name

PHOTOCRAFT = os.environ.get("DECK_PHOTOCRAFT", shutil.which("photocraft") or "/usr/bin/photocraft")
PHOTOCRAFT_CLI = os.environ.get("DECK_PHOTOCRAFT_CLI", shutil.which("photocraft-cli") or "/usr/bin/photocraft-cli")
EFFECTCRAFT = os.environ.get("DECK_EFFECTCRAFT", shutil.which("effectcraft") or "/usr/bin/effectcraft")
EFFECTCRAFT_CLI = os.environ.get("DECK_EFFECTCRAFT_CLI", shutil.which("effectcraft-cli") or "/usr/bin/effectcraft-cli")
ID_RE = re.compile(r"^[a-f0-9]{12}$")
COMP = "ComfyDeck"   # the comp Bring back renders


def craft_dir() -> Path:
    return config.DATA_DIR / "craft"


def _safe(s: str, n: int = 50) -> str:
    return re.sub(r"[^\w.-]+", "_", str(s or "")).strip("_")[:n] or "edit"


# ---- PhotoCraft ----

def photo_commands(canvas: dict, layers: list[dict]) -> tuple[dict, list[tuple[str, dict]]]:
    """(file.new params, [(command, params)]) for photocraft-cli run. layers (bottom first) carry "path" (already
    cropped to what shows), "rect" {x, y, w, h} in canvas px, "name" and "hidden"."""
    w, h = max(1, round(canvas["w"])), max(1, round(canvas["h"]))
    bg = canvas.get("bg")
    new = {"width": w, "height": h, "name": "ComfyDeck",
           "background": bg if isinstance(bg, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", bg) else "transparent"}
    cmds = []
    for l in layers:
        r, (iw, _) = l["rect"], l["size"]
        cmds.append(("file.placeEmbedded", {"path": str(l["path"]), "scale": round(100 * r["w"] / max(1, iw), 4),
                                            "fit": False, "smartObject": True,
                                            "center": [round(r["x"] + r["w"] / 2, 2), round(r["y"] + r["h"] / 2, 2)]}))
        cmds.append(("layer.setProps", {"name": str(l.get("name") or "Layer")[:120], "visible": not l.get("hidden")}))
    return new, cmds


def _crop(src: Path, crop: dict | None, out: Path) -> tuple[int, int]:
    """The part of an image the Editor shows (crop in fractions) as a PNG; its pixel size."""
    with Image.open(src) as im:
        im.load()
        W, H = im.size
        c = crop or {}
        x0, y0 = round(float(c.get("x", 0)) * W), round(float(c.get("y", 0)) * H)
        x1, y1 = x0 + max(1, round(float(c.get("w", 1)) * W)), y0 + max(1, round(float(c.get("h", 1)) * H))
        part = im.crop((max(0, x0), max(0, y0), min(W, x1), min(H, y1)))
        part.save(out)
        return part.size


def _run(args: list[str], job: dict | None = None, timeout: int = 3600) -> str:
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if job is not None:
        job["proc"] = p
    out, err = p.communicate(timeout=timeout)
    if p.returncode:
        lines = (err or out or "").strip().splitlines()
        raise RuntimeError(lines[-1] if lines else f"{Path(args[0]).name} failed")
    return out


def build_photo(folder: Path, canvas: dict, layers: list[dict]) -> Path:
    doc = folder / "deck.pcraft"
    new, cmds = photo_commands(canvas, layers)
    args = [PHOTOCRAFT_CLI, "run", "--new", json.dumps(new)]
    for c, p in cmds:
        args += ["--cmd", c, "--params", json.dumps(p)]
    _run(args + ["--out", str(doc)], timeout=600)
    return doc


# ---- EffectCraft ----

def _js(v) -> str:
    return json.dumps(v)


def _db(v: float) -> float:
    return round(20 * math.log10(v), 2) if v > 0.0001 else -96.0


def video_jsx(W: int, H: int, fps: float, total: float, items: list[dict], save: Path, comp: str = COMP) -> str:
    """An EffectCraft script (After Effects object model) that builds the comp and saves the project. items are
    videoedit.render's after its own preparation (_prepare): path, kind, z, at, in, len, xin, xout, x, y, scale,
    fit, rotation, anchor_x, anchor_y, opacity, volume, fade_in, fade_out, hidden, muted, name, info {width,
    height, audio, video}. Sound-only clips go at the bottom, then the video tracks bottom to top."""
    L = [f"var comp = app.project.items.addComp({_js(comp)}, {int(W)}, {int(H)}, 1, {max(total, 1 / fps):.4f}, {fps:g});",
         "var items = {};",
         "function get(p) { if (!items[p]) items[p] = app.project.importFile(new ImportOptions(new File(p))); return items[p]; }"]
    order = ([i for i in items if i["kind"] == "audio"]
             + sorted((i for i in items if i["kind"] != "audio"), key=lambda i: (i["z"], i["at"])))
    for n, it in enumerate(order):
        at, ln, start = it["at"], it["len"], it["at"] - (it["in"] if it["kind"] != "image" else 0)
        v = f"l{n}"
        L.append(f"var {v} = comp.layers.add(get({_js(str(it['path']))}));")
        L.append(f"{v}.name = {_js(str(it.get('name') or Path(it['path']).name)[:120])};")
        L.append(f"{v}.startTime = {start:.4f}; {v}.inPoint = {at:.4f}; {v}.outPoint = {at + ln:.4f};")
        visual = it["kind"] in ("video", "image") and it["info"].get("video", True)
        if visual:
            iw, ih = it["info"].get("width") or W, it["info"].get("height") or H
            fit = (max if it.get("fit") == "fill" else min)(W / iw, H / ih)
            s = 100 * fit * max(0.01, float(it.get("scale") or 1))
            ax = 0.5 if it.get("anchor_x") is None else float(it["anchor_x"])
            ay = 0.5 if it.get("anchor_y") is None else float(it["anchor_y"])
            tr = f"{v}.property(\"Transform\")"
            L.append(f"{tr}.property(\"Anchor Point\").setValue([{ax * iw:.2f}, {ay * ih:.2f}]);")
            L.append(f"{tr}.property(\"Position\").setValue([{W / 2 + float(it.get('x') or 0) * W:.2f}, "
                     f"{H / 2 + float(it.get('y') or 0) * H:.2f}]);")
            L.append(f"{tr}.property(\"Scale\").setValue([{s:.3f}, {s:.3f}]);")
            if float(it.get("rotation") or 0):
                L.append(f"{tr}.property(\"Rotation\").setValue({float(it['rotation']):.3f});")
            op = 100 * max(0.0, min(1.0, float(it.get("opacity", 1) if it.get("opacity") is not None else 1)))
            fi = min(ln, max(float(it.get("fade_in") or 0), it.get("xin", 0)))
            fo = min(ln, float(it.get("fade_out") or 0))
            if fi > 0 or fo > 0:
                L.append(f"var o{n} = {tr}.property(\"Opacity\");")
                keys = ([(at, 0), (at + fi, op)] if fi > 0 else []) + ([(at + ln - fo, op), (at + ln, 0)] if fo > 0 else [])
                L += [f"o{n}.setValueAtTime({t:.4f}, {val:.2f});" for t, val in keys]
            elif op < 99.95:
                L.append(f"{tr}.property(\"Opacity\").setValue({op:.2f});")
            if it.get("hidden"):
                L.append(f"{v}.enabled = false;")
        if it["info"].get("audio") or it["kind"] == "audio":
            vol = float(it.get("volume", 1) if it.get("volume") is not None else 1)
            lv = _db(vol)
            fi = min(ln, max(float(it.get("fade_in") or 0), it.get("xin", 0)))
            fo = min(ln, max(float(it.get("fade_out") or 0), it.get("xout", 0) if it["kind"] == "audio" else 0))
            al = f"{v}.property(\"Audio\").property(\"Audio Levels\")"
            if fi > 0 or fo > 0:
                keys = ([(at, -96), (at + fi, lv)] if fi > 0 else []) + ([(at + ln - fo, lv), (at + ln, -96)] if fo > 0 else [])
                L += [f"{al}.setValueAtTime({t:.4f}, [{val}, {val}]);" for t, val in keys]
            elif lv:
                L.append(f"{al}.setValue([{lv}, {lv}]);")
            if it.get("muted") or vol <= 0.0001:
                L.append(f"{v}.audioEnabled = false;")
    L.append(f"app.project.save(new File({_js(str(save))}));")
    return "\n".join(L) + "\n"


def prepare(items: list[dict]) -> tuple[list[dict], float]:
    """Timeline items with their probe, in/len/at as the renderer counts them, and the overlap fades."""
    items = [dict(it) for it in items]
    for it in items:
        it["info"] = videoedit.probe(Path(it["path"]))
        dur = it["info"]["duration"] if it["kind"] != "image" else 0
        it["in"] = max(0.0, float(it.get("in") or 0))
        end = float(it.get("out") or dur or 3)
        if dur:
            end = min(end, dur)
        it["len"] = max(0.04, end - it["in"])
        it["at"] = max(0.0, float(it.get("at") or 0))
        if it["kind"] == "image":
            it["info"].setdefault("video", True)
    videoedit._overlaps(items)
    return items, max((i["at"] + i["len"] for i in items), default=1.0)


def build_video(folder: Path, items: list[dict], width=None, height=None, fps=None) -> Path:
    items, total = prepare(items)
    visual = [i for i in items if i["kind"] != "audio"]
    first = min(visual, key=lambda i: (i["at"], i["z"]), default=None)
    W = int(width or (first and first["info"].get("width")) or 1280)
    H = int(height or (first and first["info"].get("height")) or 720)
    fps = float(fps or next((i["info"]["fps"] for i in visual if i["kind"] == "video" and i["info"].get("fps")), 0) or 24)
    doc = folder / "deck.ecproj"
    script = folder / "build.jsx"
    script.write_text(video_jsx(W, H, fps, total, items, doc))
    _run([EFFECTCRAFT_CLI, "script", str(script)], timeout=600)
    if not doc.is_file():
        raise RuntimeError("EffectCraft didn't save the project")
    return doc


# ---- documents ----

def _meta(folder: Path) -> dict:
    return json.loads((folder / "meta.json").read_text())


def _save_meta(folder: Path, meta: dict):
    (folder / "meta.json").write_text(json.dumps(meta, indent=1))


def new_doc(kind: str, project_id, title: str) -> tuple[str, Path]:
    cid = uuid.uuid4().hex[:12]
    folder = craft_dir() / cid
    (folder / "footage").mkdir(parents=True)
    _save_meta(folder, {"id": cid, "kind": kind, "app": "photocraft" if kind in ("photo", "image") else "effectcraft",
                        "project_id": project_id, "title": str(title or "ComfyDeck edit")[:120], "created": time.time(),
                        "back": []})
    return cid, folder


def _public(meta: dict) -> dict:
    folder = craft_dir() / meta["id"]
    doc = folder / ("deck.pcraft" if meta["app"] == "photocraft" else "deck.ecproj")
    return {**meta, "file": str(doc), "saved": doc.stat().st_mtime if doc.is_file() else None}


def _bridge_project(port) -> str | None:
    """The project open in the EffectCraft window listening on this control port, or None when none is."""
    try:
        r = subprocess.run([EFFECTCRAFT_CLI, "--bridge", str(int(port)), "info"], capture_output=True, text=True, timeout=5)
    except (subprocess.SubprocessError, OSError, ValueError, TypeError):
        return None
    m = re.search(r"^project: (.+)$", r.stdout, re.M) if r.returncode == 0 else None
    return m[1].strip() if m else ("" if r.returncode == 0 else None)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def open_in_app(meta: dict):
    """PhotoCraft opens the file as a new tab in the PhotoCraft already running. EffectCraft gets a window of its own
    per document (so nothing unsaved in another window is touched), started with a control port and told to open the
    project; Open again finds that window while it is still open."""
    doc = Path(_public(meta)["file"])
    exe = PHOTOCRAFT if meta["app"] == "photocraft" else EFFECTCRAFT
    if not Path(exe).is_file():
        raise HTTPException(400, f"{Path(exe).name} isn't installed on this computer")
    env = {**os.environ}
    env.setdefault("DISPLAY", ":0")   # the desktop session's screen, when the server was started without one
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    run = lambda args: subprocess.Popen(args, env=env, cwd=str(doc.parent), stdin=subprocess.DEVNULL,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    if meta["app"] == "photocraft":
        run([exe, str(doc)])
        return
    if meta.get("port") and _bridge_project(meta["port"]) == str(doc):
        return   # already open in its window
    port = _free_port()
    meta["port"] = port
    _save_meta(craft_dir() / meta["id"], meta)
    run([exe, "--control", str(port)])

    def load():   # the window takes a few seconds to come up
        for _ in range(60):
            time.sleep(1)
            if _bridge_project(port) is not None:
                subprocess.run([EFFECTCRAFT_CLI, "--bridge", str(port), "exec", "file.open", "--params",
                                json.dumps({"path": str(doc)})], capture_output=True, timeout=60)
                return
    threading.Thread(target=load, daemon=True).start()


def _get(cid: str) -> dict:
    if not ID_RE.match(cid) or not (craft_dir() / cid / "meta.json").is_file():
        raise HTTPException(404, "That document is gone")
    return _meta(craft_dir() / cid)


def _fail(folder: Path, e: Exception):
    shutil.rmtree(folder, ignore_errors=True)
    raise HTTPException(400, f"Couldn't make the document: {e}")


async def _footage(src: dict, folder: Path) -> tuple[Path, str]:
    """A source's file, kept with the document: an input image is written into its footage folder; generations
    and media files stay where they are."""
    return await resolve_src(src or {}, folder / "footage")


@router.get("")
async def list_docs(project_id: str | None = None):
    out = []
    if craft_dir().is_dir():
        for f in craft_dir().iterdir():
            try:
                m = _meta(f)
            except (OSError, ValueError):
                continue
            if project_id is None or str(m.get("project_id")) == str(project_id):
                out.append(_public(m))
    return sorted(out, key=lambda m: m["created"], reverse=True)


@router.post("/photo")
async def send_photo(body: dict = Body(...)):
    canvas = body.get("canvas") or {}
    if not body.get("layers") or not canvas.get("w") or not canvas.get("h"):
        raise HTTPException(400, "The edit has no layers")
    cid, folder = new_doc("photo", body.get("project_id"), body.get("title") or "Edit")
    try:
        layers = []
        for i, l in enumerate(body["layers"]):
            path, kind = await _footage(l.get("src") or {}, folder)
            if kind != "image":
                raise ValueError(f"{path.name} isn't an image")
            out = folder / "footage" / f"{i:02d}_{_safe(l.get('name') or path.stem)}.png"
            size = _crop(path, l.get("crop"), out)
            layers.append({**l, "path": out, "size": size})
        await asyncio.to_thread(build_photo, folder, canvas, layers)
    except HTTPException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    except Exception as e:
        _fail(folder, e)
    meta = _get(cid)
    open_in_app(meta)
    return _public(meta)


async def _timeline_items(body: dict, folder: Path) -> list[dict]:
    tracks = {t["id"]: t for t in body.get("tracks") or []}
    z_of = {tid: i for i, tid in enumerate(t["id"] for t in body.get("tracks") or [] if t.get("kind") == "video")}
    items = []
    for it in body.get("items") or []:
        tr = tracks.get(it.get("track"))
        if not tr:
            continue
        path, kind = await _footage(it.get("src") or {}, folder)
        if kind not in ("video", "image", "audio"):
            raise ValueError(f"{path.name} isn't a video, image or sound")
        items.append({**{k: it.get(k) for k in ("at", "in", "out", "x", "y", "scale", "fit", "opacity", "volume",
                                                "fade_in", "fade_out", "rotation", "anchor_x", "anchor_y", "name")},
                      "path": str(path), "kind": kind, "track": tr["id"], "z": z_of.get(tr["id"], 0),
                      "hidden": bool(tr.get("hidden")), "muted": bool(tr.get("muted"))})
    if not items:
        raise ValueError("Add some clips first")
    return items


@router.post("/video")
async def send_video(body: dict = Body(...)):
    cid, folder = new_doc("video", body.get("project_id"), body.get("title") or "Video edit")
    try:
        items = await _timeline_items(body, folder)
        # scene clips the browser rendered for this live in a temporary folder: keep a copy with the document
        for it in items:
            if Path(it["path"]).parent == config.SCENE_CLIP_DIR:
                keep = folder / "footage" / Path(it["path"]).name
                shutil.copy2(it["path"], keep)
                it["path"] = str(keep)
        await asyncio.to_thread(build_video, folder, items, body.get("width"), body.get("height"), body.get("fps"))
    except HTTPException:
        shutil.rmtree(folder, ignore_errors=True)
        raise
    except Exception as e:
        _fail(folder, e)
    meta = _get(cid)
    open_in_app(meta)
    return _public(meta)


@router.post("/vfx")
async def send_vfx(body: dict = Body(...)):
    """The source over its trim at the bottom, the matte above it (hidden: switch it on as a track matte), then
    the tab's results, only the one on show switched on. All start at 0, as the results do."""
    src = body.get("source")
    if not src and not body.get("results"):
        raise HTTPException(400, "Nothing to send: choose a source clip or make a result")
    trim = (src or {}).get("trim") or {}
    t0 = float(trim.get("start") or 0)
    ln = trim.get("len")
    tracks, items = [], []

    def add(s, name, hidden=False, cut=True):
        tid = f"v{len(tracks) + 1}"
        tracks.append({"id": tid, "kind": "video", "hidden": hidden})
        items.append({"track": tid, "src": {k: s[k] for k in ("generation", "index", "media", "input") if k in s},
                      "at": 0, "in": t0 if cut else 0, "out": (t0 + float(ln)) if cut and ln is not None else None,
                      "name": name})

    if src:
        add(src, f"Source · {src.get('label') or 'clip'}")
    if body.get("matte"):
        add(body["matte"], "Matte", hidden=True)
    for r in body.get("results") or []:
        add(r, str(r.get("label") or f"#{r.get('generation')}"), hidden=not r.get("showing"), cut=False)
    return await send_video({"project_id": body.get("project_id"), "title": body.get("title") or "VFX",
                             "tracks": tracks, "items": items})


@router.post("/generation")
async def send_generation(body: dict = Body(...)):
    """One output: an image opens in PhotoCraft, a video in EffectCraft. What it was made from (its parent output)
    comes too, as a hidden layer underneath."""
    g = db.get_generation(int(body.get("generation", -1)))
    idx = int(body.get("index") or 0)
    if not g or not 0 <= idx < len(g["outputs"]):
        raise HTTPException(404, "That output is gone")
    out = g["outputs"][idx]
    own = {"generation": g["id"], "index": idx}
    par = g.get("parent") if isinstance(g.get("parent"), dict) and g["parent"].get("generation") is not None else None
    title = f"#{g['id']} {g.get('template') or ''}".strip()
    if out["kind"] == "image":
        tmp = Path(tempfile.mkdtemp())
        try:
            path, _ = await resolve_src(own, tmp)
            with Image.open(path) as im:
                W, H = im.size
            layers = []
            if par:
                ppath, pkind = await resolve_src({"generation": par["generation"], "index": par.get("index", 0)}, tmp)
                if pkind == "image":
                    with Image.open(ppath) as im:
                        pw, ph = im.size
                    s = min(W / pw, H / ph)
                    layers.append({"src": {"generation": par["generation"], "index": par.get("index", 0)}, "hidden": True,
                                   "name": f"Made from #{par['generation']}",
                                   "rect": {"x": (W - pw * s) / 2, "y": (H - ph * s) / 2, "w": pw * s, "h": ph * s}})
            layers.append({"src": own, "name": title, "rect": {"x": 0, "y": 0, "w": W, "h": H}})
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        return await send_photo({"project_id": g["project_id"], "title": title, "canvas": {"w": W, "h": H, "bg": None},
                                 "layers": layers})
    if out["kind"] != "video":
        raise HTTPException(400, "Only pictures and videos open in the craft apps")
    tracks, items = [], []
    if par:
        tracks.append({"id": "v1", "kind": "video", "hidden": True})
        items.append({"track": "v1", "src": {"generation": par["generation"], "index": par.get("index", 0)}, "at": 0,
                      "name": f"Made from #{par['generation']}"})
    tracks.append({"id": f"v{len(tracks) + 1}", "kind": "video"})
    items.append({"track": tracks[-1]["id"], "src": own, "at": 0, "name": title})
    return await send_video({"project_id": g["project_id"], "title": title, "tracks": tracks, "items": items})


@router.post("/{cid}/open")
async def reopen(cid: str):
    meta = _get(cid)
    open_in_app(meta)
    return _public(meta)


@router.post("/{cid}/back")
async def bring_back(cid: str, body: dict = Body(default={})):
    """A job: the document as last saved, rendered into the media library (a PNG from PhotoCraft; an MP4 from
    EffectCraft, or a WebM with alpha when body.alpha)."""
    meta = _get(cid)
    folder = craft_dir() / cid
    doc = Path(_public(meta)["file"])
    if not doc.is_file():
        raise HTTPException(400, "The document hasn't been saved")
    n = len(meta.get("back") or []) + 1

    def work(job):
        stem = f"{uuid.uuid4().hex[:8]}_{_safe(meta['title'])}_v{n}"
        if meta["app"] == "photocraft":
            out = config.MEDIA_DIR / f"{stem}.png"
            _run([PHOTOCRAFT_CLI, "convert", str(doc), str(out)], job, timeout=600)
        else:
            alpha = bool(body.get("alpha"))
            out = config.MEDIA_DIR / f"{stem}.{'webm' if alpha else 'mp4'}"
            args = [EFFECTCRAFT_CLI, "--project", str(doc), "render", "--out", str(out),
                    "--format", "webm" if alpha else "h264", "--audio", "auto"] + (["--channels", "rgba"] if alpha else [])
            try:
                _run(args[:4] + ["--comp", COMP] + args[4:], job)
            except RuntimeError:   # its comp was renamed or removed: the comp that was open when it was saved
                if job["cancel"]:
                    raise
                _run(args, job)
        if not out.is_file():
            raise RuntimeError("Nothing was rendered")
        m = _meta(folder)
        m["back"] = [*(m.get("back") or []), {"name": out.name, "at": time.time()}]
        _save_meta(folder, m)
        return media_entry(out)

    return clipimport._start(work, f"Bringing back {meta['title']}")


@router.post("/input")
async def as_input(body: dict = Body(...)):
    """A picture in the media library (a PhotoCraft document brought back) as an input image."""
    path = config.MEDIA_DIR / Path(str(body.get("name") or "")).name
    if not path.is_file() or path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
        raise HTTPException(404, "That picture is gone")
    with Image.open(path) as im:
        buf = io.BytesIO()
        im.save(buf, "PNG")
    return {"name": await save_input(buf.getvalue(), body.get("project_id"), "craft")}
