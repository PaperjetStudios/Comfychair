"""Light previews of saved outputs for grids (the Board, pickers, the table's tiles): GET /api/preview?u=<file url>&w=<px>&kind=still|clip.
u: a /files/projects|media|generations|library URL, or a picture's /api/input?name= URL (a timeline item with src {input}).

  still  a JPEG at most w px wide: the picture itself, or a video's frame at 0.1 s
  clip   a video at most w px wide, 8 fps, no sound, quick to load: the Board plays these while a tile is on screen
  wave   a sound's waveform: a PNG w px wide and a third as tall, in the accent colour on a see-through background

A 3D model's screenshot is drawn in the browser (web/modelview.js) and kept here: GET and POST /api/preview/shot?u=<file url>.

Made on first ask and cached in data/thumbs/previews (named after the file, its size and time, and w), so a
changed file gets a new preview. Two are made at a time, so a full Board can't swamp the machine.
"""
import asyncio
import hashlib
import re
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse

from . import config, imageprep, storage, videoedit

router = APIRouter()
DIR = config.THUMB_DIR / "previews"
DIR.mkdir(parents=True, exist_ok=True)
ROOTS = {"/files/projects/": config.PROJECTS_DIR, "/files/media/": config.MEDIA_DIR, "/files/generations/": config.GEN_DIR,
         "/files/library/": config.LIBRARY_DIR}
VIDEO = {".mp4", ".webm", ".mov", ".mkv", ".m4v", ".gif"}
MODELS = {".glb", ".gltf", ".obj", ".fbx"}
MAX_SHOT = 3 * 1024 * 1024
AUDIO = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"}
WAVE_COLOUR = "0xe9b44c"   # web/app.css --accent
FPS = 8
_busy = asyncio.Semaphore(2)


def _input(name: str) -> Path:
    """One of the project's pictures (an input's name, as /api/input?name= takes it): its local copy only. Its previews start
    with that copy's tag, so deleting the picture deletes them (storage.delete_input drops the caches of its files)."""
    from .main import local_input   # (main imports this module)
    p = local_input(name)
    if p is None or not p.is_file() or config.INPUT_DIR.resolve() not in p.resolve().parents:
        raise HTTPException(404, "No such file")
    return p.resolve()


def source(url: str) -> Path:
    """The file behind one of ComfyChair's /files/ URLs, or a picture's /api/input?name= URL (never outside those folders)."""
    parts = urlsplit(url)
    if parts.path == "/api/input":
        name = (parse_qs(parts.query).get("name") or [""])[0]
        if not name:
            raise HTTPException(404, "No such file")
        return _input(name)
    if parts.path.startswith("/files/input/"):
        return _input(unquote(parts.path[len("/files/input/"):]))
    path = unquote(url.split("?", 1)[0].split("#", 1)[0])
    for prefix, root in ROOTS.items():
        if path.startswith(prefix):
            p = (root / path[len(prefix):]).resolve()
            if root.resolve() in p.parents and p.is_file():
                return p
    raise HTTPException(404, "No such file")


def _key(p: Path, w: int, kind: str) -> Path:
    st = p.stat()
    h = hashlib.sha1(f"{p}:{st.st_size}:{st.st_mtime_ns}:{w}:{kind}".encode()).hexdigest()[:12]
    # (it starts with the source's tag, so deleting the source deletes its previews: storage.drop_caches)
    return DIR / f"{storage.tag(p)}-{h}.{ {'still': 'jpg', 'clip': 'mp4', 'wave': 'png', 'shot': 'jpg'}[kind] }"


def make_still(p: Path, out: Path, w: int):
    if p.suffix.lower() in VIDEO:
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "0.1", "-i", str(p), "-frames:v", "1",
                            "-vf", f"scale='min({w},iw)':-2", "-q:v", "4", str(out)], capture_output=True, timeout=120)
        if r.returncode or not out.is_file():   # a clip shorter than 0.1 s, say: its first frame
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(p), "-frames:v", "1", "-vf", f"scale='min({w},iw)':-2",
                            "-q:v", "4", str(out)], capture_output=True, timeout=120, check=True)
        return
    out.write_bytes(imageprep.thumbnail(p.read_bytes(), w))


def make_clip(p: Path, out: Path, w: int):
    tmp = out.with_suffix(".part.mp4")
    args = ["ffmpeg", "-v", "error", "-y", "-i", str(p), "-an",
            "-vf", f"fps={FPS},scale='min({w},iw)':-2:flags=bilinear,format=yuv420p", *videoedit.h264(30, "veryfast"),
            "-movflags", "+faststart", str(tmp)]
    r = videoedit.run_ffmpeg(args, timeout=600)
    if r.returncode:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(r.stderr.decode(errors="replace").strip().splitlines()[-1] if r.stderr else "ffmpeg failed")
    tmp.rename(out)


def make_wave(p: Path, out: Path, w: int):
    # scaled so its loudest moment fills the height (a quiet voice still shows its shape)
    r = subprocess.run(["ffmpeg", "-v", "info", "-nostats", "-i", str(p), "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-"],
                       capture_output=True, timeout=120)
    m = re.search(rb"max_volume: (-?[\d.]+) dB", r.stderr)
    gain = min(30.0, max(0.0, -float(m.group(1)))) if m else 0.0
    tmp = out.with_suffix(".part.png")
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(p), "-filter_complex",
                        f"[0:a:0]volume={gain:.1f}dB,aformat=channel_layouts=mono,showwavespic=s={w}x{w // 3 - w // 3 % 2}:colors={WAVE_COLOUR}:scale=sqrt",
                        "-frames:v", "1", str(tmp)], capture_output=True, timeout=120)
    if r.returncode or not tmp.is_file():
        tmp.unlink(missing_ok=True)
        raise RuntimeError(r.stderr.decode(errors="replace").strip().splitlines()[-1] if r.stderr else "no sound in it")
    tmp.rename(out)


MAKE = {"still": make_still, "clip": make_clip, "wave": make_wave}
TYPES = {"still": "image/jpeg", "clip": "video/mp4", "wave": "image/png"}


@router.get("/api/preview")
async def preview(u: str, w: int = 320, kind: str = "still"):
    if kind not in MAKE:
        raise HTTPException(400, "kind is still, clip or wave")
    p = source(u)
    w = max(64, min(int(w), 1024))
    w -= w % 2
    if kind == "clip" and p.suffix.lower() not in VIDEO:
        raise HTTPException(400, "Only videos have a preview clip")
    if kind == "wave" and p.suffix.lower() not in AUDIO | VIDEO:
        raise HTTPException(400, "Only sounds and clips have a waveform")
    out = _key(p, w, kind)
    if not out.is_file():
        async with _busy:
            if not out.is_file():
                try:
                    await asyncio.to_thread(MAKE[kind], p, out, w)
                except Exception as e:
                    raise HTTPException(415, f"Couldn't preview that: {e}")
    return FileResponse(out, media_type=TYPES[kind],
                        headers={"Cache-Control": "max-age=604800"})


def _model(u: str) -> Path:
    p = source(u)
    if p.suffix.lower() not in MODELS:
        raise HTTPException(400, "Only 3D models have a screenshot")
    return p


@router.get("/api/preview/shot")
async def model_shot(u: str):
    """A model's saved screenshot; 204 until a browser has drawn one."""
    out = _key(_model(u), 0, "shot")
    if not out.is_file():
        return Response(status_code=204, headers={"Cache-Control": "no-store"})
    return FileResponse(out, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


@router.post("/api/preview/shot")
async def save_model_shot(u: str, request: Request):
    """Keep the screenshot a browser drew (a JPEG). It starts with the model's tag, so it goes with the model."""
    out = _key(_model(u), 0, "shot")
    raw = await request.body()
    if len(raw) > MAX_SHOT:
        raise HTTPException(413, "That screenshot is too big")
    if raw[:3] != b"\xff\xd8\xff":
        raise HTTPException(400, "A screenshot is a JPEG")
    tmp = out.with_suffix(".part")
    tmp.write_bytes(raw)
    tmp.rename(out)
    return {"ok": True}


async def warm(urls: list[str]):
    """Make the stills (at the Board's usual sizes), videos' clips and sounds' waveforms for new outputs in the background."""
    for u in urls:
        for w, kind in ((320, "still"), (480, "still"), (320, "clip"), (320, "wave"), (480, "wave")):
            try:
                p = source(u)
                ext = p.suffix.lower()
                if (ext in AUDIO) != (kind == "wave") or (kind == "clip" and ext not in VIDEO):
                    continue
                out = _key(p, w, kind)
                if not out.is_file():
                    async with _busy:
                        await asyncio.to_thread(MAKE[kind], p, out, w)
            except Exception:   # a preview is a nicety: a failure here only means it's made when first asked
                pass
