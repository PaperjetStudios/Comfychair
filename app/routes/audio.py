"""Audio endpoints."""
import asyncio
import re
import subprocess
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, Body, HTTPException
from .. import audioedit, config, db, imageprep
from .. import keyexpr
from .context import RouteServices

router = APIRouter()
services: RouteServices


def configure(runtime: RouteServices):
    global services
    services = runtime


CACHE_PREFIX = "cache-"   # a cached mix's file name starts with it (a made or uploaded file starts with 8 hex digits)


def _media_path(name: str, ext: str) -> Path:
    """A fresh media-library file for a made sound: <8 hex>_<name><ext>."""
    safe = re.sub(r"[^\w.-]+", "_", Path(name or "sound").stem)[:60] or "sound"
    return config.MEDIA_DIR / f"{uuid.uuid4().hex[:8]}_{safe}{ext}"


def _sound_format(body: dict) -> str:
    fmt = str(body.get("format") or "m4a").lower()
    if fmt not in audioedit.FORMATS:
        raise HTTPException(400, f"Can't write {fmt} sound: pick m4a, wav, mp3 or flac")
    return fmt


@router.post("/api/audio/extract")
async def audio_extract(body: dict = Body(...)):
    """The sound of a clip ({source: {generation, index} | {media}}, trim {start, len} seconds) as its own
    file in the media library (format m4a | wav | mp3 | flac, name), to edit or use as a reference."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    path, kind = await services.timeline_path(body.get("source") or {}, None)
    if kind not in ("video", "audio"):
        raise HTTPException(400, "That has no sound")
    out = _media_path(body.get("name") or f"{path.stem}-sound", "." + _sound_format(body))
    try:
        await asyncio.to_thread(audioedit.extract, path, out, body.get("trim") if isinstance(body.get("trim"), dict) else None)
    except (ValueError, RuntimeError, subprocess.SubprocessError) as e:
        out.unlink(missing_ok=True)
        raise HTTPException(400, f"Couldn't take the sound out: {e}")
    return services.media_entry(out)


@router.post("/api/sound/render")
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
        path, kind = await services.timeline_path(it.get("src") or {}, None)
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
    if body.get("cache") is True:   # a table frame's cached mix for a wire: kept out of the media library's list (main.py list_media)
        out = out.with_name(CACHE_PREFIX + out.name)
    try:
        info = await asyncio.to_thread(audioedit.render, items, out, float(body.get("gain") or 1), bool(body.get("normalize")))
    except Exception as e:
        out.unlink(missing_ok=True)
        raise HTTPException(400, str(e))
    return {**services.media_entry(out), "duration": round(info["duration"], 2)}


@router.post("/api/audio/lay")
async def audio_lay(body: dict = Body(...)):
    """A copy of a clip with a sound on it, in History: {video, sound (sources), mode replace|mix, at (s),
    volume, keep (the clip's own sound, for mix), sound_trim {start, len}, project_id}."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    vsrc, ssrc = body.get("video") or {}, body.get("sound") or {}
    vpath, vkind = await services.timeline_path(vsrc, None)
    if vkind != "video":
        raise HTTPException(400, "Pick a video to put the sound on")
    spath, skind = await services.timeline_path(ssrc, None)
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
    await services.push_gen(gid)
    out, rel = services.new_output(db.get_generation(gid), "with-sound.mp4")
    try:
        trim = body.get("sound_trim") if isinstance(body.get("sound_trim"), dict) else None
        info = await asyncio.to_thread(audioedit.lay, vpath, spath, out, mode, float(body.get("at") or 0),
                                       float(body.get("volume", 1)), float(body.get("keep", 1)), trim)
    except Exception as e:
        out.unlink(missing_ok=True)
        db.update_generation(gid, status="error", error=str(e), finished=time.time())
        await services.push_gen(gid)
        raise HTTPException(400, str(e))
    db.update_generation(gid, status="done", finished=time.time(),
                         outputs=[{"filename": out.name, "path": rel, "kind": "video", "node": "sound",
                                   "duration": round(info["duration"], 2)}])
    await services.push_gen(gid)
    return db.get_generation(gid)
