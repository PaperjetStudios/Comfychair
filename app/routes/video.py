"""Video endpoints."""
import asyncio
import hashlib
import json
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, Body, HTTPException
from .. import config, db, imageprep, videoedit, videoprep
from .context import RouteServices

router = APIRouter()
services: RouteServices


def configure(runtime: RouteServices):
    global services
    services = runtime


@router.post("/api/video/canvas")
async def video_canvas(body: dict = Body(...)):
    """A clip on a bigger (or differently shaped) canvas, for Extend frame: {source, trim, aspect (w / h), scale, cx,
    cy} -> {video, mask (sources for the inpaint template), plan}. The mask is white where the canvas is to be
    painted. Made once per clip and settings (data/tmp/videoprep)."""
    src = body.get("source") or {}
    path, kind = await services.timeline_path(src, None)
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


@router.post("/api/videos/probe")
async def video_probe(body: dict = Body(...)):
    """Size, length and rate of a picked video ({source: {generation, index} | {media}}), for the trim UI."""
    path, kind = await services.timeline_path(body.get("source") or {}, None)
    if kind != "video":
        raise HTTPException(400, "That isn't a video")
    try:
        info = await asyncio.to_thread(videoedit.probe, path)
    except (subprocess.SubprocessError, OSError, ValueError, KeyError) as e:
        raise HTTPException(400, f"Couldn't read that video: {e}")
    return {**info, "frames": round(info["duration"] * info["fps"])}


@router.post("/api/videos/prep")
async def video_prep(body: dict = Body(...)):
    """A trimmed/cropped copy of a picked video ({source, trim: {start, len} seconds, crop: {x,y,w,h}
    fractions}) in data/tmp/videoprep, named after source+params so the same edit reuses one file.
    generate() does the same by itself; this is for trying it. Returns {path, width, height, duration, cached}."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed on the server")
    path, kind = await services.timeline_path(body.get("source") or {}, None)
    if kind != "video":
        raise HTTPException(400, "That isn't a video")
    try:
        r = await asyncio.to_thread(videoprep.prep, path, body.get("trim"), body.get("crop"))
    except (ValueError, subprocess.SubprocessError, OSError) as e:
        raise HTTPException(400, str(e))
    return {**r, "path": str(r["path"])}


@router.post("/api/video/render")
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
            path, kind = await services.timeline_path(it.get("src") or {}, Path(td))
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
        await services.push_gen(gid)
        out, rel = services.new_output(db.get_generation(gid), "edit.mp4")
        try:
            info = await asyncio.to_thread(videoedit.render, items, out, body.get("width"), body.get("height"), body.get("fps"))
        except Exception as e:
            out.unlink(missing_ok=True)
            db.update_generation(gid, status="error", error=str(e), finished=time.time())
            await services.push_gen(gid)
            raise HTTPException(400, str(e))
    db.update_generation(gid, status="done", finished=time.time(),
                         outputs=[{"filename": out.name, "path": rel, "kind": "video", "node": "edit",
                                   "duration": round(info["duration"], 2)}])
    await services.push_gen(gid)
    return db.get_generation(gid)
