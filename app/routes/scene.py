"""Scene endpoints."""
import asyncio
import json
import re
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from .. import config, db, imageprep, motion, videoedit
from ..comfy import ComfyError
from .context import RouteServices

router = APIRouter()
services: RouteServices


def configure(runtime: RouteServices):
    global services
    services = runtime


def _motion_clean(m, opts):
    """Video mocap is cleaned unless the caller says otherwise. Feet are planted later, in the world
    (the 3D tab asks again after a camera pan is undone), so a default clean here is steady + bone lengths."""
    if opts is None and m.get("source") == "sam3d-body":
        opts = {"smooth": True, "bones": True}
    if not opts:
        return m
    return motion.apply_clean(m, opts)


@router.post("/api/motion/file")
async def motion_file(file: UploadFile = File(...), smooth: str = Form(""), bones: str = Form("")):
    """A motion file (.npz / .json with 22+ joint positions per frame) as the 3D tab's motion (app/motion.py).
    smooth and bones are "0" or "1"; left out, a video mocap is steadied and its bone lengths held."""
    data = await file.read()
    if len(data) > 64 * 1024 * 1024:
        raise HTTPException(400, "That motion file is too big")
    try:
        m = await asyncio.to_thread(motion.read, data, file.filename or "motion.npz")
        opts = None if smooth == "" and bones == "" else {"smooth": smooth == "1", "bones": bones == "1"}
        return await asyncio.to_thread(_motion_clean, m, opts)
    except Exception as e:
        raise HTTPException(400, f"Couldn't read that motion: {e}")


@router.post("/api/motion/from")
async def motion_from(body: dict = Body(...)):
    """A generation's motion output ({generation, index}): text-to-motion and mocap templates save .npz/.json.
    clean: {smooth, bones} (feet and ground are /api/motion/clean, after the body is in the world)."""
    g = db.get_generation(int(body.get("generation", -1)))
    if not g:
        raise HTTPException(404, "No such generation")
    outs = [o for o in g["outputs"] if Path(o["filename"]).suffix.lower() in (".npz", ".json")]
    idx = body.get("index")
    o = g["outputs"][int(idx)] if idx is not None and 0 <= int(idx) < len(g["outputs"]) else (outs[0] if outs else None)
    if not o:
        raise HTTPException(400, "That run has no motion file")
    try:
        m = await asyncio.to_thread(motion.read, services.output_file(g, o).read_bytes(), o["filename"])
        return await asyncio.to_thread(_motion_clean, m, body.get("clean") if "clean" in body else None)
    except Exception as e:
        raise HTTPException(400, f"Couldn't read that motion: {e}")


@router.post("/api/motion/clean")
async def motion_clean(body: dict = Body(...)):
    """Plant feet and level the floor on frames that are already in the world ({fps, frames, clean, hands?, face?})."""
    frames = body.get("frames")
    if not isinstance(frames, list) or len(frames) < 2:
        raise HTTPException(400, "Nothing to clean")
    try:
        m = {"fps": body.get("fps") or 24, "frames": frames, "hands": body.get("hands"), "face": body.get("face")}
        return await asyncio.to_thread(motion.apply_clean, m, body.get("clean") or {})
    except Exception as e:
        raise HTTPException(400, f"Couldn't clean that motion: {e}")


@router.post("/api/scene/render")
async def scene_render(frames: list[UploadFile] = File(...), fps: float = Form(24), blur: float = Form(0),
                       scene: str = Form("{}"), project_id: str = Form(""), kind: str = Form("depth")):
    """The 3D tab's depth or pose frames (PNGs, in order) as a control video in History, or its colour frames (the
    shot as it looks, splats at their full set) as a plain video. The scene goes in the params so the 3D tab can
    open it again; blur softens the edges so H3 follows less literally."""
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    if not 2 <= len(frames) <= 1000:
        raise HTTPException(400, "A scene needs 2 to 1000 frames")
    if kind not in ("depth", "pose", "color"):
        raise HTTPException(400, "kind is depth, pose or color")
    try:
        scene_data = json.loads(scene)
    except ValueError:
        raise HTTPException(400, "Bad scene")
    params = {"frames": len(frames), "fps": fps, "blur": blur, "kind": kind, "scene": scene_data}
    gid = db.create_generation(services.project(project_id), "3d scene", params, {}, f"scene-{uuid.uuid4().hex}", None)
    db.update_generation(gid, status="running")
    await services.push_gen(gid)
    out, rel = services.new_output(db.get_generation(gid), f"{kind}.mp4")
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
        await services.push_gen(gid)
        raise HTTPException(400, r.stderr[-500:] or "ffmpeg failed")
    db.update_generation(gid, status="done", finished=time.time(),
                         outputs=[{"filename": out.name, "path": rel, "kind": "video", "node": "scene",
                                   "duration": round(len(frames) / fps, 2)}])
    await services.push_gen(gid)
    return db.get_generation(gid)


@router.post("/api/scene/depth-combine")
async def scene_depth_combine(body: dict = Body(...)):
    """{picture: generation id, geometry: generation id} -> a depth video made of the geometry render's pixels where it
    drew something (the 3D objects, exact) and the picture's estimated depth everywhere else (what a splat shows).
    The geometry render is the objects-only pass: black where nothing is drawn, every object at least DEPTH_FLOOR.
    The picture's depth is scaled and retimed to the geometry video; the result is as long as the shorter of the two."""
    gens = []
    for key in ("picture", "geometry"):
        try:
            g = db.get_generation(int(body.get(key) or 0))
        except (TypeError, ValueError):
            g = None
        o = next((x for x in (g or {}).get("outputs", []) if x.get("kind") == "video"), None)
        if not g or not o:
            raise HTTPException(400, f"The {key} depth needs a finished video")
        gens.append((g, services.output_file(g, o)))
    (pg, pic), (gg, geo) = gens
    if not imageprep.ffmpeg_available():
        raise HTTPException(400, "ffmpeg isn't installed (sudo apt install ffmpeg)")
    try:
        fps = (await asyncio.to_thread(videoedit.probe, geo))["fps"]
    except (subprocess.SubprocessError, OSError, ValueError, KeyError) as e:
        raise HTTPException(400, f"Couldn't read the geometry depth: {e}")
    params = {"kind": "depth", "combined": {"picture": pg["id"], "geometry": gg["id"]}, "scene": (gg.get("params") or {}).get("scene")}
    gid = db.create_generation(gg["project_id"], "3d scene", params, {}, f"scene-{uuid.uuid4().hex}", None)
    db.update_generation(gid, status="running")
    await services.push_gen(gid)
    out = None
    try:
        out, rel = services.new_output(db.get_generation(gid), "depth.mp4")
        # luma only (grey in, grey out): limited-range black is Y 16, the floor lands near Y 50, so 32 splits them
        vf = (f"[0:v]format=gray[g0];[1:v]fps={fps:.6f},format=gray[p0];[p0][g0]scale2ref[b][a];"
              "[a][b]blend=all_expr='if(gt(A,32),A,B)':shortest=1,"
              "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(geo), "-i", str(pic), "-filter_complex", vf,
               *videoedit.h264(12), "-an", "-movflags", "+faststart", str(out)]
        r = await asyncio.to_thread(videoedit.run_ffmpeg, cmd, text=True)
        if r.returncode:
            raise RuntimeError(r.stderr[-500:] or "ffmpeg failed")
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:
        if out:
            out.unlink(missing_ok=True)
        db.update_generation(gid, status="error", error=str(e)[-500:], finished=time.time())
        await services.push_gen(gid)
        raise HTTPException(400, str(e)[-500:])
    dur = next((x.get("duration") for x in gg["outputs"] if x.get("kind") == "video"), None)
    db.update_generation(gid, status="done", finished=time.time(),
                         outputs=[{"filename": out.name, "path": rel, "kind": "video", "node": "scene", **({"duration": dur} if dur else {})}])
    await services.push_gen(gid)
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


@router.post("/api/scene/clip")
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


@router.post("/api/scene/mesh")
async def scene_mesh(body: dict = Body(...)):
    """Copy a run's mesh into ComfyUI's input folder, where the auto-rig templates load it from
    (UniRigLoadMesh reads ComfyUI's input; the 3D tab's Rig it buttons call this first)."""
    g = db.get_generation(int((body or {}).get("generation", -1)))
    if not g:
        raise HTTPException(404, "No such generation")
    idx = int(body.get("index", 0))
    if not 0 <= idx < len(g["outputs"]):
        raise HTTPException(400, "Bad output index")
    if not config.COMFY_INPUT_DIR:
        raise HTTPException(503, "ComfyUI's folder isn't here: set DECK_COMFY_DIR to it")
    src = services.output_file(g, g["outputs"][idx])
    if not src.is_file():
        raise HTTPException(404, "That file is gone")
    # UniRig's mesh loader lists ComfyUI's input/3d folder (and the input root), and only those: a run's
    # mesh goes there under its own name
    folder = config.COMFY_INPUT_DIR / "3d"
    folder.mkdir(parents=True, exist_ok=True)
    name = re.sub(r"[^\w.\-]+", "_", src.name)[:80] or "model.glb"
    dest = folder / name
    if not dest.exists() or dest.stat().st_size != src.stat().st_size:
        await asyncio.to_thread(shutil.copyfile, src, dest)
    return {"file_path": f"3d/{name}", "name": name}


@router.post("/api/scene/photo")
async def scene_photo(body: dict = Body(...)):
    """A picture as a 3D mesh for the 3D tab: MoGe (ComfyUI's core nodes) estimates its depth and
    camera, and the mesh, textured with the picture and torn where the depth jumps, comes back as a
    GLB in History (glTF axes: the photo's camera at the origin, looking down -Z)."""
    image = (body or {}).get("image")
    if not isinstance(image, str) or not image:
        raise HTTPException(400, "Pick a picture")
    spec = (await services.comfy.object_info()).get("LoadMoGeModel")
    if not spec:
        raise HTTPException(400, "ComfyUI has no MoGe nodes: update ComfyUI")
    opt = spec["input"]["required"]["model_name"]
    models = opt[1].get("options", []) if opt and opt[0] == "COMBO" else opt[0] if opt and isinstance(opt[0], list) else []
    if not models:
        raise HTTPException(400, "No MoGe model: put one from Comfy-Org/MoGe (Hugging Face) in ComfyUI/models/geometry_estimation")
    model = next((m for m in models if "moge_3_vitl" in m), None) or next((m for m in models if "moge_2" in m), models[0])
    project_id = services.project(body.get("project_id"))
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
        res = await services.comfy.queue(wf)
    except ComfyError as e:
        raise HTTPException(400, str(e))
    gid = db.create_generation(project_id, "3d photo", {"image": image, "model": model, "decimation": detail},
                               wf, res["prompt_id"], None)
    await services.push_gen(gid)
    return db.get_generation(gid)
