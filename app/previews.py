"""Light previews of saved outputs for grids (the Board, pickers): GET /api/preview?u=<file url>&w=<px>&kind=still|clip.

  still  a JPEG at most w px wide: the picture itself, or a video's frame at 0.1 s
  clip   a video at most w px wide, 8 fps, no sound, quick to load: the Board plays these while a tile is on screen
  wave   a sound's waveform: a PNG w px wide and a third as tall, in the accent colour on a see-through background

Made on first ask and cached in data/thumbs/previews (named after the file, its size and time, and w), so a
changed file gets a new preview. Two are made at a time, so a full Board can't swamp the machine.
"""
import asyncio
import hashlib
import re
import subprocess
from pathlib import Path
from urllib.parse import unquote

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from . import config, imageprep, videoedit

router = APIRouter()
DIR = config.THUMB_DIR / "previews"
DIR.mkdir(parents=True, exist_ok=True)
ROOTS = {"/files/projects/": config.PROJECTS_DIR, "/files/media/": config.MEDIA_DIR, "/files/generations/": config.GEN_DIR,
         "/files/library/": config.LIBRARY_DIR}
VIDEO = {".mp4", ".webm", ".mov", ".mkv", ".m4v", ".gif"}
AUDIO = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".opus"}
WAVE_COLOUR = "0xe9b44c"   # web/app.css --accent
FPS = 8
_busy = asyncio.Semaphore(2)


def source(url: str) -> Path:
    """The file behind one of ComfyDeck's /files/ URLs (never outside those folders)."""
    path = unquote(url.split("?", 1)[0].split("#", 1)[0])
    for prefix, root in ROOTS.items():
        if path.startswith(prefix):
            p = (root / path[len(prefix):]).resolve()
            if root.resolve() in p.parents and p.is_file():
                return p
    raise HTTPException(404, "No such file")


def _key(p: Path, w: int, kind: str) -> Path:
    st = p.stat()
    h = hashlib.sha1(f"{p}:{st.st_size}:{st.st_mtime_ns}:{w}:{kind}".encode()).hexdigest()[:20]
    return DIR / f"{h}.{ {'still': 'jpg', 'clip': 'mp4', 'wave': 'png'}[kind] }"


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
