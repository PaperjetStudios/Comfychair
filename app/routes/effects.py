"""Effects endpoints."""
import asyncio
import subprocess
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, Body, HTTPException
from .. import delogo, h3upscale, posefind, config, db, imageprep, videoedit, videoprep
from ..comfy import ComfyError
from .context import RouteServices

router = APIRouter()
services: RouteServices


def configure(runtime: RouteServices):
    global services
    services = runtime


@router.post("/api/pose/find")
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
        path, _ = await services.timeline_path(src, None)
        clip_secs = (await asyncio.to_thread(videoedit.probe, path))["duration"] or None
    except (HTTPException, subprocess.SubprocessError, OSError, ValueError, KeyError):
        pass

    def measure(g, o):
        path = services.output_file(g, o)
        if not path.is_file():
            raise FileNotFoundError(path)
        try:
            info = videoedit.probe(path)
            return round(info["duration"] * (info.get("fps") or posefind.FPS)) or None
        except (subprocess.SubprocessError, OSError, ValueError, KeyError):
            return None

    return await asyncio.to_thread(posefind.find, gens, src, trim, crop, poser, secs, clip_secs, measure)


@router.get("/api/h3/regen")
async def h3_regen_options():
    """Whether Open-H3-Regenerate can run: its LoRAs in `models/loras` (and whether each has Turbo inside)."""
    oi = await services.object_info_or_none()
    if oi is None:
        return {"available": False, "loras": [], "reason": "ComfyUI is offline"}
    loras = h3upscale.regen_loras(oi)
    if not loras:
        return {"available": False, "loras": [],
                "reason": "No Open-H3-Regenerate LoRA in models/loras: add the r128 merge (2 GB) or Kijai's refiner "
                          "(5.9 GB) and restart ComfyUI"}
    return {"available": True, "loras": loras, "reason": ""}


@router.post("/api/h3/upscale")
async def h3_upscale(body: dict = Body(...)):
    """A finished MiniMax H3 clip ({generation, index, scale, strength: light|medium|strong}) sampled again bigger, with the same run's prompt,
    LoRAs, references and seed (app/h3upscale.py). A new generation in History, made from the clip."""
    g = db.get_generation(int(body.get("generation", -1)))
    regen_in = body.get("regen") if isinstance(body.get("regen"), dict) else None
    try:
        gid = await queue_h3_upscale(g, int(body.get("index") or 0), float(body.get("scale") or 1.5),
                                     str(body.get("strength") or "strong"), regen_in)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return db.get_generation(gid)


async def queue_h3_upscale(g: dict | None, idx: int, scale: float = 1.5, strength_name: str = "strong",
                           regen_in: dict | None = None, extra: dict | None = None) -> int:
    """Queue the second pass of a finished H3 clip (POST /api/h3/upscale, and a sheet's own Upscale option): the new
    generation's id. ValueError says why it can't. A run that cuts a sheet keeps it (h3upscale.build), so the result
    is the bigger clip and the bigger sheet. extra: more params for the new run."""
    if not g or g["status"] != "done" or not 0 <= idx < len(g["outputs"]) or g["outputs"][idx]["kind"] != "video":
        raise ValueError("Pick a finished H3 video")
    wf0 = db.get_workflow(g["id"])
    if not wf0 or not h3upscale.h3_node(wf0):
        raise ValueError("Only MiniMax H3 runs can be upscaled this way")
    oi = await services.object_info_or_none()
    if oi is not None and "MinimaxH3LatentUpscaler3D" not in oi:   # installed since it was read?
        oi = await services.object_info_or_none(refresh=True)
    if oi is not None and "MinimaxH3LatentUpscaler3D" not in oi:
        raise ValueError("ComfyUI doesn't have the MiniMax H3 latent upscaler (Comfyui_Minimax_h3_latent_Upscaler): "
                         "install it and restart ComfyUI")
    path = services.output_file(g, g["outputs"][idx])
    try:
        info = await asyncio.to_thread(videoedit.probe, path)
    except (subprocess.SubprocessError, OSError, ValueError, KeyError) as e:
        raise ValueError(f"Couldn't read the clip: {e}")
    scale = min(2.0, max(1.1, float(scale or 1.5)))
    strength = h3upscale.STRENGTHS.get(strength_name)
    if strength is None:
        raise ValueError("Strength is light, medium or strong")
    regen, size = None, None
    if regen_in:
        quality = str(regen_in.get("quality") or "standard")
        if quality not in h3upscale.REGEN_SIGMAS:
            raise ValueError("Regenerate's quality is standard or enhanced")
        lora = str(regen_in.get("lora") or "")
        hit = next((x for x in h3upscale.regen_loras(oi) if x["name"] == lora), None)
        if not hit:
            raise ValueError("Pick an Open-H3-Regenerate LoRA: none of those in models/loras was chosen")
        regen = {"lora": hit["name"], "has_turbo": hit["has_turbo"], "quality": quality}
        if str(regen_in.get("target") or "") == "1080p":
            size = h3upscale.fit_1080p(info["width"], info["height"])
    folder = db.project_folder(g["project_id"])
    wf, (w, h) = h3upscale.build(wf0, str(path), info["width"], info["height"], scale,
                                 f"{config.COMFY_INPUT_SUBFOLDER}/{folder}/h3up", info.get("fps") or 24, strength,
                                 regen=regen, size=size)
    try:
        res = await services.comfy.queue(wf)
    except ComfyError as e:
        raise ValueError(str(e))
    sheet = h3upscale.is_sheet(wf0)
    params = {"source": {"generation": g["id"], "index": idx}, "scale": scale, "strength": strength_name,
              "frame": f"{w}×{h}", "regen": ({"lora": regen["lora"], "quality": regen["quality"]} if regen else None),
              "from": f"{info['width']}×{info['height']}", "template": g["template"], **({"sheet": True} if sheet else {}),
              **(extra or {})}
    name = "h3 regenerate" if regen else "h3 sheet upscale" if sheet else "h3 upscale"
    gid = db.create_generation(g["project_id"], name, params, wf, res["prompt_id"],
                               {"generation": g["id"], "index": idx, "frame": None})
    await services.push_gen(gid)
    return gid


async def sheet_follow_up(g: dict | None) -> int | None:
    """A finished run that asked for its own upscale (a sheet's Upscale option, h3upscale.follow_up): queue it, made
    from that run. An upscale's own params never ask, so it can't queue another. If it can't be queued, a failed
    run says why in History. The new generation's id, or None."""
    want = h3upscale.follow_up((g or {}).get("params") or {})
    if not g or g["status"] != "done" or not want or g["template"].startswith("h3 "):
        return None
    clip = next((i for i, o in enumerate(g["outputs"]) if o.get("kind") == "video"), None)
    scale, strength = want
    try:
        return await queue_h3_upscale(g, clip if clip is not None else -1, scale, strength, extra={"auto": True})
    except Exception as e:  # noqa: BLE001  (the sheet itself is done: the failure goes on a run of its own)
        params = {"source": {"generation": g["id"], "index": clip or 0}, "scale": scale, "strength": strength,
                  "template": g["template"], "sheet": True, "auto": True}
        gid = db.create_generation(g["project_id"], "h3 sheet upscale", params, {}, f"edit-{uuid.uuid4().hex}",
                                   {"generation": g["id"], "index": clip or 0, "frame": None})
        db.update_generation(gid, status="error", error=f"Upscale not queued: {e}", finished=time.time())
        await services.push_gen(gid)
        return gid


async def _delogo_clip(body: dict) -> tuple[dict, Path, dict]:
    """(the source, the clip as the boxes were drawn on it: trimmed, cropped and upright, its probe)."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    src = body.get("source") or {}
    path, kind = await services.timeline_path(src, None)
    if kind != "video":
        raise HTTPException(400, "Remove watermark needs a video clip")
    try:
        r = await asyncio.to_thread(videoprep.prep, path, body.get("trim"), body.get("crop"))
        info = await asyncio.to_thread(videoedit.probe, r["path"])
    except (ValueError, subprocess.SubprocessError, OSError) as e:
        raise HTTPException(400, str(e))
    return src, r["path"], info


@router.post("/api/video/delogo/find")
async def video_delogo_find(body: dict = Body(...)):
    """Where a watermark probably is ({source, trim, crop}) -> {boxes: [{x, y, w, h} fractions of the frame]}."""
    _, path, _ = await _delogo_clip(body)
    try:
        return {"boxes": await asyncio.to_thread(delogo.find_boxes, path)}
    except (subprocess.SubprocessError, OSError, ValueError) as e:
        raise HTTPException(400, f"Couldn't look through the clip: {e}")


@router.post("/api/video/delogo")
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
        oi = await services.object_info_or_none()
        if oi is not None and "ProPainterInpaint" not in oi:   # installed since it was read?
            oi = await services.object_info_or_none(refresh=True)
        if oi is not None and "ProPainterInpaint" not in oi:
            raise HTTPException(400, "ComfyUI doesn't have ProPainter (ComfyUI_ProPainter_Nodes): install it and restart ComfyUI")
        frames = max(2, int(round(info["duration"] * info["fps"])))
        folder = db.project_folder(project) if project else None
        prefix = f"{config.COMFY_INPUT_SUBFOLDER}/{folder}/delogo" if folder else f"{config.COMFY_INPUT_SUBFOLDER}/delogo"
        wf = delogo.build(str(path), info["width"], info["height"], info["fps"] or 24, frames, rects, prefix, info["audio"])
        try:
            res = await services.comfy.queue(wf)
        except ComfyError as e:
            raise HTTPException(400, str(e))
        gid = db.create_generation(project, "remove watermark", params, wf, res["prompt_id"], parent)
        await services.push_gen(gid)
        return db.get_generation(gid)
    gid = db.create_generation(project, "remove watermark", params, {}, f"delogo-{uuid.uuid4().hex}", parent)
    db.update_generation(gid, status="running")
    await services.push_gen(gid)
    out, rel = services.new_output(db.get_generation(gid), "clean.mp4")
    try:
        got = await asyncio.to_thread(delogo.fast, path, out, rects)
    except Exception as e:
        out.unlink(missing_ok=True)
        db.update_generation(gid, status="error", error=str(e), finished=time.time())
        await services.push_gen(gid)
        raise HTTPException(400, str(e))
    db.update_generation(gid, status="done", finished=time.time(),
                         outputs=[{"filename": out.name, "path": rel, "kind": "video", "node": "delogo",
                                   "duration": round(got["duration"], 2)}])
    await services.push_gen(gid)
    return db.get_generation(gid)


@router.post("/api/video/key")
async def video_key(body: dict = Body(...)):
    """A keyed copy of a clip in History, with alpha (VP9 webm): {source, mode: color|matte, matte (a
    source, for mode matte), color "#rrggbb", similarity, blend, spill, invert, project_id}."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    mode = body.get("mode") or "color"
    src = body.get("source") or {}
    path, kind = await services.timeline_path(src, None)
    if kind != "video":
        raise HTTPException(400, "Keying needs a video clip")
    matte = None
    if mode == "matte":
        matte, mkind = await services.timeline_path(body.get("matte") or {}, None)
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
    await services.push_gen(gid)
    out, rel = services.new_output(db.get_generation(gid), "keyed.webm")
    try:
        trim = body.get("trim") if isinstance(body.get("trim"), dict) else None
        info = await asyncio.to_thread(videoedit.key, path, out, mode, matte, trim, **opts)
    except Exception as e:
        out.unlink(missing_ok=True)
        db.update_generation(gid, status="error", error=str(e), finished=time.time())
        await services.push_gen(gid)
        raise HTTPException(400, str(e))
    db.update_generation(gid, status="done", finished=time.time(),
                         outputs=[{"filename": out.name, "path": rel, "kind": "video", "node": "key",
                                   "duration": round(info["duration"], 2), "alpha": True}])
    await services.push_gen(gid)
    return db.get_generation(gid)


@router.post("/api/video/matte")
async def video_matte(body: dict = Body(...)):
    """A cleaned or combined matte in History ({a, b (optional), combine: union|intersect|subtract|average, grow,
    close, smooth, feather, low, high, invert, project_id}): two mattes (say SAM3's and Alpha Gen's) made into one,
    grown or shrunk, holes filled, steadied, edged and feathered (videoedit.matte_filters). White = keep."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    a, ka = await services.timeline_path(body.get("a") or {}, None)
    b = None
    if body.get("b"):
        b, kb = await services.timeline_path(body["b"], None)
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
    await services.push_gen(gid)
    out, rel = services.new_output(db.get_generation(gid), "matte.mp4")
    try:
        info = await asyncio.to_thread(videoedit.refine_matte, a, out, b, **opts)
    except Exception as e:
        out.unlink(missing_ok=True)
        db.update_generation(gid, status="error", error=str(e), finished=time.time())
        await services.push_gen(gid)
        raise HTTPException(400, str(e))
    db.update_generation(gid, status="done", finished=time.time(),
                         outputs=[{"filename": out.name, "path": rel, "kind": "video", "node": "matte",
                                   "duration": round(info["duration"], 2)}])
    await services.push_gen(gid)
    return db.get_generation(gid)
