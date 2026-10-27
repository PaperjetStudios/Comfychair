"""Import a clip: a piece of an online video (any link yt-dlp understands: YouTube, Reddit, X, Vimeo…), of a
video file on this PC, or of a file on the device, saved to the media library (data/media) so every video
picker offers it.

Links: POST /link reads the page with yt-dlp and picks small streams for the preview, which GET /link/{id}/v
and /a relay with Range requests passed through, so the browser seeks without downloading the video. Sites that
only stream in pieces (HLS) get a small preview copy instead. PC files: /browse lists folders under ROOTS, /file
streams one (Range too), /proxy makes a small copy when the browser can't play it. Device files: the browser
cuts a stream copy with ffmpeg.wasm (core files from /wasm, fetched once from the CDN) and uploads just that.

Every cut ends in one ffmpeg pass that seeks in the source (for a link that means HTTP Range requests on the
stream URLs, so only the piece is fetched), re-encodes to h264 + aac with an optional crop and size limit, and
writes the media file. Cuts and previews run as jobs: POST returns {job}, GET /job/{id} reports progress."""
import asyncio
import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, Body, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from . import config, videoedit

router = APIRouter(prefix="/api/clip")
media_entry = None   # main.py sets it: (Path) -> the media library's JSON for a file

TMP = config.DATA_DIR / "tmp" / "clips"         # previews, proxies and uploaded pieces (cleared after a day)
WASM_DIR = config.DATA_DIR / "vendor" / "ffmpeg-core"
WASM_CDN = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/"
WASM_FILES = ("ffmpeg-core.js", "ffmpeg-core.wasm")
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".mts", ".m2ts", ".ts", ".mxf", ".wmv", ".flv",
              ".3gp", ".mpg", ".mpeg", ".ogv"}
PREVIEW_H = 480          # preview streams: the nearest height to this, at most PREVIEW_MAX_H
PREVIEW_MAX_H = 720
PREVIEW_DL_MAX = 1200    # seconds: longer videos that only stream in pieces aren't copied for a preview
YTDLP_TIMEOUT = 90
LINK_TTL = 4 * 3600      # stream URLs expire after a few hours; the page is read again after this

TMP.mkdir(parents=True, exist_ok=True)


def _roots() -> list[Path]:
    """Folders the PC tab may browse: DECK_CLIP_ROOTS (paths joined with os.pathsep), else home and mounted drives."""
    env = os.environ.get("DECK_CLIP_ROOTS")
    if env:
        cand = [Path(p).expanduser() for p in env.split(os.pathsep) if p.strip()]
    else:
        home = Path.home()
        cand = [home] + sorted(p for base in (Path("/media") / home.name, Path("/mnt")) if base.is_dir()
                               for p in base.iterdir() if p.is_dir() and os.path.ismount(p))
    return [p.resolve() for p in cand if p.is_dir()]


def _inside_roots(path: str) -> Path:
    p = Path(path).expanduser().resolve()
    if not any(p == r or p.is_relative_to(r) for r in _roots()):
        raise HTTPException(403, "That folder isn't one ComfyDeck may read (see DECK_CLIP_ROOTS)")
    return p


def _video_file(path: str) -> Path:
    p = _inside_roots(path)
    if not p.is_file() or p.suffix.lower() not in VIDEO_EXTS:
        raise HTTPException(404, "Not a video file")
    return p


def _safe(name: str, fallback="clip") -> str:
    return re.sub(r"[^\w.-]+", "_", name or "").strip("._")[:60] or fallback


def _stamp(t: float) -> str:
    t = int(t)
    return f"{t // 3600}h{t // 60 % 60:02d}m{t % 60:02d}s" if t >= 3600 else f"{t // 60}m{t % 60:02d}s"


def _sweep():
    """Leftovers older than a day: previews, proxies, uploaded pieces."""
    cutoff = time.time() - 86400
    for p in TMP.iterdir():
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:
            pass


# ---- jobs -------------------------------------------------------------------
JOBS: dict[str, dict] = {}


def _start(work, label: str) -> dict:
    """Run work(job) in a thread; it sets job["result"] and updates job["progress"] (0..1) as it goes."""
    jid = uuid.uuid4().hex[:12]
    job = {"state": "running", "progress": 0.0, "label": label, "cancel": False, "proc": None, "t": time.time()}

    def run():
        try:
            job["result"] = work(job)
            job["state"] = "done"
        except Exception as e:   # shown to the user as the job's error
            job["state"], job["error"] = ("cancelled", "Cancelled") if job["cancel"] else ("error", str(e))
        job["progress"] = 1.0

    for old in [k for k, j in JOBS.items() if j["state"] != "running" and time.time() - j["t"] > 3600]:
        del JOBS[old]
    JOBS[jid] = job
    threading.Thread(target=run, daemon=True).start()
    return {"job": jid}


@router.get("/job/{jid}")
async def job_status(jid: str):
    job = JOBS.get(jid)
    if not job:
        raise HTTPException(404, "That job is gone")
    return {"state": job["state"], "progress": round(job["progress"], 3), "label": job["label"],
            "error": job.get("error"), "result": job.get("result") if job["state"] == "done" else None}


@router.post("/job/{jid}/cancel")
async def job_cancel(jid: str):
    job = JOBS.get(jid)
    if job and job["state"] == "running":
        job["cancel"] = True
        if job["proc"] and job["proc"].poll() is None:
            job["proc"].kill()
    return {"ok": True}


def _ffmpeg(job: dict, cmd: list[str], length: float | None):
    """Run ffmpeg with -progress on stdout, turning out_time into job progress over `length` seconds."""
    err: list[str] = []
    with subprocess.Popen(cmd[:1] + ["-progress", "pipe:1", "-nostats"] + cmd[1:], stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True) as proc:
        job["proc"] = proc
        drain = threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True)
        drain.start()
        for line in proc.stdout:
            if line.startswith("out_time_us=") and length:
                try:
                    job["progress"] = min(0.99, int(line.split("=", 1)[1]) / 1e6 / length)
                except ValueError:
                    pass
        proc.wait()
        drain.join(5)
    if job["cancel"]:
        raise RuntimeError("Cancelled")
    if proc.returncode:
        raise RuntimeError("ffmpeg failed: " + ("".join(err[-4:]).strip() or f"exit {proc.returncode}"))


def _vf(crop, height) -> list[str]:
    """Crop (fractions of the frame) then a size limit, both kept to even sizes for yuv420p."""
    f = []
    if crop:
        x, y, w, h = (min(1.0, max(0.0, float(crop[k]))) for k in ("x", "y", "w", "h"))
        f.append(f"crop=trunc(iw*{w:.5f}/2)*2:trunc(ih*{h:.5f}/2)*2:trunc(iw*{x:.5f}):trunc(ih*{y:.5f})")
    if height:
        f.append(f"scale=-2:'min({int(height)},trunc(ih/2)*2)'")
    f.append("format=yuv420p")
    return ["-vf", ",".join(f)]


def _encode(job, inputs: list[tuple[str, list[str]]], start: float, length: float, crop, height, out: Path,
            audio_map: str | None = "0:a:0?"):
    """One pass: every input seeks to start (input options before each -i), the piece is re-encoded to out."""
    cmd = ["ffmpeg", "-y", "-v", "error"]
    for src, opts in inputs:
        cmd += opts + (["-ss", f"{start:.3f}"] if start > 0 else []) + ["-i", src]
    cmd += ["-t", f"{length:.3f}", "-map", "0:v:0"] + (["-map", audio_map] if audio_map else [])
    cmd += _vf(crop, height) + ["-c:v", "libx264", "-preset", "medium", "-crf", "17",
                                "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    part = out.with_suffix(".part.mp4")
    cmd[-1] = str(part)
    try:
        _ffmpeg(job, cmd, length)
        part.replace(out)
    finally:
        part.unlink(missing_ok=True)


def _out_path(title: str, start: float) -> Path:
    return config.MEDIA_DIR / f"{uuid.uuid4().hex[:8]}_{_safe(title)}_{_stamp(start)}.mp4"


def _span(body: dict, duration: float | None) -> tuple[float, float]:
    try:
        start, end = float(body.get("start") or 0), float(body["end"])
    except (KeyError, TypeError, ValueError):
        raise HTTPException(400, "The cut needs a start and an end in seconds")
    if duration:
        end = min(end, duration)
    if start < 0 or end - start < 0.04:
        raise HTTPException(400, "The cut is shorter than a frame")
    return start, end - start


def _height(v) -> int | None:
    try:
        n = int(v or 0)
    except (TypeError, ValueError):
        return None
    return n if n >= 144 else None


# ---- links (yt-dlp) ---------------------------------------------------------
LINKS: dict[str, dict] = {}


def _ytdlp(*args: str) -> dict:
    """yt-dlp -J with the given options: the venv's module when installed, else a yt-dlp on PATH."""
    base = [sys.executable, "-m", "yt_dlp"] if _has_module() else ["yt-dlp"]
    try:
        r = subprocess.run(base + ["-J", "--no-playlist", "--no-warnings", *args], capture_output=True, text=True,
                           timeout=YTDLP_TIMEOUT)
    except FileNotFoundError:
        raise HTTPException(400, "yt-dlp isn't installed on the server (pip install yt-dlp)")
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "The site took too long to answer")
    if r.returncode:
        msg = (r.stderr.strip().splitlines() or ["yt-dlp failed"])[-1]
        raise HTTPException(400, re.sub(r"^ERROR:\s*", "", msg)[:300])
    return json.loads(r.stdout)


def _has_module() -> bool:
    try:
        import yt_dlp  # noqa: F401
        return True
    except ImportError:
        return False


def _direct(f: dict) -> bool:
    return f.get("protocol") in ("https", "http") and bool(f.get("url"))


def _has_v(f):
    return f.get("vcodec") not in (None, "none") and (f.get("height") or 0) > 0


def _has_a(f):
    return f.get("acodec") not in (None, "none")


def pick_preview(formats: list[dict]) -> tuple[dict | None, dict | None]:
    """(video, audio) formats a browser can play straight from their URLs: h264 first, with sound if one has
    it, the height nearest PREVIEW_H. audio is None when the video carries sound (or there's none)."""
    vids = [f for f in formats if _direct(f) and _has_v(f) and (f.get("height") or 0) <= PREVIEW_MAX_H]
    if not vids:
        return None, None
    plays = lambda f: (f.get("vcodec") or "").startswith(("avc1", "h264")) and f.get("ext") in ("mp4", "m4v")
    v = max(vids, key=lambda f: (plays(f), _has_a(f), -abs((f.get("height") or 0) - PREVIEW_H)))
    if _has_a(v):
        return v, None
    auds = [f for f in formats if _direct(f) and _has_a(f) and not _has_v(f)]
    a = max(auds, key=lambda f: ((f.get("language_preference") or 0), f.get("ext") == "m4a",
                                 -(f.get("abr") or f.get("tbr") or 0)), default=None)
    return v, a


def _link(lid: str) -> dict:
    link = LINKS.get(lid)
    if not link:
        raise HTTPException(404, "Load the link again")
    return link


def _summary(lid: str, link: dict) -> dict:
    info = link["info"]
    heights = sorted({f["height"] for f in info.get("formats") or [] if _has_v(f) and f.get("height")})
    return {"id": lid, "title": info.get("title") or "clip", "duration": info.get("duration") or 0,
            "fps": info.get("fps") or next((f.get("fps") for f in reversed(info.get("formats") or []) if f.get("fps")), None) or 30,
            "uploader": info.get("uploader") or info.get("channel"), "thumbnail": info.get("thumbnail"),
            "site": info.get("extractor_key"), "heights": heights, "preview": link.get("preview")}


@router.post("/link")
async def link_open(body: dict = Body(...)):
    """Read a link: {url} -> {id, title, duration, fps, heights, preview: {video, audio} | null}. preview null:
    the site only streams in pieces, so POST /link/{id}/preview makes a small copy first."""
    url = str(body.get("url") or "").strip()
    if not re.match(r"^https?://", url):
        raise HTTPException(400, "Paste a link that starts with http:// or https://")
    info = await asyncio.to_thread(_ytdlp, url)
    if info.get("_type") == "playlist":
        raise HTTPException(400, "That's a playlist: open one video and copy its link")
    if info.get("is_live"):
        raise HTTPException(400, "Live streams can't be cut: wait for the recording")
    lid = hashlib.sha1(f"{url}{time.time()}".encode()).hexdigest()[:12]
    v, a = pick_preview(info.get("formats") or ([info] if info.get("url") else []))
    link = {"url": url, "info": info, "t": time.time(), "v": v, "a": a,
            "preview": {"video": f"/api/clip/link/{lid}/v", "audio": a and f"/api/clip/link/{lid}/a"} if v else None}
    for old in [k for k, x in LINKS.items() if time.time() - x["t"] > LINK_TTL]:
        del LINKS[old]
    LINKS[lid] = link
    return _summary(lid, link)


RELAY_HEADERS = ("content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag")


@router.get("/link/{lid}/{which}")
async def link_stream(lid: str, which: str, request: Request):
    """The preview stream, relayed with the browser's Range header so seeking only fetches what's shown."""
    link = _link(lid)
    if which == "file" and link.get("file"):
        return FileResponse(link["file"], media_type="video/mp4")
    f = link.get({"v": "v", "a": "a"}.get(which, ""))
    if not f:
        raise HTTPException(404, "No such stream")
    headers = dict(f.get("http_headers") or {})
    if request.headers.get("range"):
        headers["Range"] = request.headers["range"]
    client = httpx.AsyncClient(timeout=httpx.Timeout(30, read=60), follow_redirects=True)
    try:
        r = await client.send(client.build_request("GET", f["url"], headers=headers), stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        raise HTTPException(502, f"The site didn't send the video: {e}")
    if r.status_code >= 400:
        await r.aclose(); await client.aclose()
        raise HTTPException(502, f"The site answered {r.status_code}: load the link again")

    async def body():
        try:
            async for chunk in r.aiter_raw():
                yield chunk
        finally:
            await r.aclose(); await client.aclose()

    out = {k: r.headers[k] for k in RELAY_HEADERS if k in r.headers}
    if "content-type" not in out or out["content-type"].startswith(("application/octet", "text/")):
        out["content-type"] = "audio/mp4" if which == "a" else "video/mp4"
    return StreamingResponse(body(), status_code=r.status_code, headers=out)


@router.post("/link/{lid}/preview")
async def link_preview(lid: str):
    """A small copy of the whole video for sites that only stream in pieces (job; the result is the link's
    summary with preview.video pointing at the copy)."""
    link = _link(lid)
    dur = link["info"].get("duration") or 0
    if dur > PREVIEW_DL_MAX:
        raise HTTPException(400, f"That site only streams in pieces, and copying {dur / 60:.0f} minutes just to "
                                 "preview takes too long. Type the start and end times instead.")
    out = TMP / f"link_{lid}.mp4"

    def work(job):
        _sweep()
        fmts = _ytdlp(link["url"], "-f", f"b[height<={PREVIEW_H}]/bv*[height<={PREVIEW_H}]+ba/w", "-S", "vcodec:h264,acodec:aac")
        inputs, amap = _stream_inputs(fmts)
        _encode(job, inputs, 0, dur or 36000, None, PREVIEW_H, out, amap)
        link["file"] = str(out)
        link["preview"] = {"video": f"/api/clip/link/{lid}/file", "audio": None}
        return _summary(lid, link)

    return _start(work, "Making a preview")


def _stream_inputs(info: dict) -> tuple[list[tuple[str, list[str]]], str | None]:
    """ffmpeg inputs for the formats yt-dlp chose (one muxed stream, or video + audio) and the audio map."""
    fmts = info.get("requested_formats") or [info]
    inputs = []
    for f in fmts:
        hdr = dict(f.get("http_headers") or {})
        ua = hdr.pop("User-Agent", None)
        opts = (["-user_agent", ua] if ua else []) + (["-headers", "".join(f"{k}: {v}\r\n" for k, v in hdr.items())] if hdr else [])
        inputs.append((f["url"], opts + ["-reconnect", "1", "-reconnect_streamed", "1"] if _direct(f) else opts))
    if len(fmts) > 1:
        return inputs, "1:a:0?"
    return inputs, "0:a:0?"


@router.post("/link/{lid}/cut")
async def link_cut(lid: str, body: dict = Body(...)):
    """Cut {start, end, height?, crop?, name?} out of the link at full quality (up to height): job -> media entry."""
    link = _link(lid)
    start, length = _span(body, link["info"].get("duration"))
    height, crop = _height(body.get("height")), body.get("crop")
    title = body.get("name") or link["info"].get("title") or "clip"

    def work(job):
        sel = f"bv*[height<={height}]+ba/b[height<={height}]/bv*+ba/b" if height else "bv*+ba/b"
        info = _ytdlp(link["url"], "-f", sel, "-S", "vcodec:h264,res,acodec:aac")
        inputs, amap = _stream_inputs(info)
        out = _out_path(title, start)
        _encode(job, inputs, start, length, crop, height, out, amap)
        return media_entry(out)

    return _start(work, "Cutting the clip")


# ---- files on this PC -------------------------------------------------------
@router.get("/browse")
async def browse(path: str = ""):
    """{path, parent, dirs: [name], files: [{name, path, size, mtime}]}; no path: the roots."""
    if not path:
        return {"path": "", "parent": None, "dirs": [{"name": str(r), "path": str(r)} for r in _roots()], "files": []}
    p = _inside_roots(path)
    if not p.is_dir():
        raise HTTPException(404, "No such folder")
    dirs, files = [], []
    try:
        entries = sorted(p.iterdir(), key=lambda e: e.name.lower())
    except PermissionError:
        raise HTTPException(403, "ComfyDeck can't read that folder")
    for e in entries:
        if e.name.startswith("."):
            continue
        try:
            if e.is_dir():
                dirs.append({"name": e.name, "path": str(e)})
            elif e.suffix.lower() in VIDEO_EXTS:
                st = e.stat()
                files.append({"name": e.name, "path": str(e), "size": st.st_size, "mtime": st.st_mtime})
        except OSError:
            continue
    parent = None if p in _roots() else str(p.parent)
    return {"path": str(p), "parent": parent, "dirs": dirs, "files": files}


@router.get("/file")
async def file_stream(path: str):
    p = _video_file(path)
    return FileResponse(p, media_type=mimetypes.guess_type(p.name)[0] or "video/mp4")


@router.get("/probe")
async def file_probe(path: str):
    p = _video_file(path)
    try:
        info = await asyncio.to_thread(videoedit.probe, p)
    except (subprocess.SubprocessError, OSError, ValueError, KeyError) as e:
        raise HTTPException(400, f"Couldn't read that video: {e}")
    return {**info, "frames": round(info["duration"] * info["fps"]), "name": p.name}


@router.post("/proxy")
async def file_proxy(body: dict = Body(...)):
    """A small playable copy of a PC file the browser can't play (job -> {url})."""
    p = _video_file(body.get("path") or "")
    st = p.stat()
    out = TMP / f"proxy_{hashlib.sha1(f'{p}{st.st_size}{st.st_mtime_ns}'.encode()).hexdigest()[:16]}.mp4"

    def work(job):
        if not out.is_file():
            _sweep()
            dur = videoedit.probe(p)["duration"]
            cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(p), "-map", "0:v:0", "-map", "0:a:0?",
                   "-vf", f"scale=-2:'min({PREVIEW_H // 4 * 3},trunc(ih/2)*2)',format=yuv420p", "-c:v", "libx264",
                   "-preset", "veryfast", "-crf", "30", "-g", "24", "-c:a", "aac", "-b:a", "96k",
                   "-movflags", "+faststart", str(out.with_suffix(".part.mp4"))]
            try:
                _ffmpeg(job, cmd, dur)
                out.with_suffix(".part.mp4").replace(out)
            finally:
                out.with_suffix(".part.mp4").unlink(missing_ok=True)
        return {"url": f"/api/clip/tmp/{out.name}"}

    return _start(work, "Making a preview")


@router.get("/tmp/{name}")
async def tmp_file(name: str):
    p = TMP / Path(name).name
    if not p.is_file():
        raise HTTPException(404, "That preview is gone")
    return FileResponse(p, media_type="video/mp4")


@router.post("/file/cut")
async def file_cut(body: dict = Body(...)):
    """Cut {path, start, end, height?, crop?, name?} out of a PC file: job -> media entry."""
    p = _video_file(body.get("path") or "")
    start, length = _span(body, None)
    height, crop = _height(body.get("height")), body.get("crop")
    title = body.get("name") or p.stem

    def work(job):
        out = _out_path(title, start)
        _encode(job, [(str(p), [])], start, length, crop, height, out)
        return media_entry(out)

    return _start(work, "Cutting the clip")


# ---- files on the device ----------------------------------------------------
@router.post("/upload")
async def upload_cut(file: UploadFile = File(...), length: float = Form(...), start: float = Form(0),
                     at: float = Form(0), height: int = Form(0), crop: str = Form(""), name: str = Form("")):
    """A piece the browser cut (a stream copy starting at the cut, or the whole file when it couldn't):
    re-encoded from `start` for `length` seconds into the media library; `at` is where the piece sat in the
    original (for the file name). Job -> media entry."""
    if not 0 < length <= 6 * 3600 or start < 0:
        raise HTTPException(400, "Bad cut length")
    _sweep()
    src = TMP / f"up_{uuid.uuid4().hex[:12]}{Path(file.filename or '').suffix.lower()[:8] or '.mov'}"
    with src.open("wb") as f:
        await asyncio.to_thread(shutil.copyfileobj, file.file, f, 4 << 20)
    crop_box = json.loads(crop) if crop else None
    title = name or Path(file.filename or "clip").stem

    def work(job):
        try:
            out = _out_path(title, at or start)
            _encode(job, [(str(src), [])], start, length, crop_box, _height(height), out)
            return media_entry(out)
        finally:
            src.unlink(missing_ok=True)

    return _start(work, "Saving the clip")


@router.get("/wasm/{name}")
async def wasm_file(name: str):
    """ffmpeg.wasm's core (about 31 MB), fetched from the CDN the first time and kept in data/vendor."""
    if name not in WASM_FILES:
        raise HTTPException(404, "No such file")
    p = WASM_DIR / name
    if not p.is_file():
        WASM_DIR.mkdir(parents=True, exist_ok=True)
        try:
            async with httpx.AsyncClient(timeout=120, follow_redirects=True) as c:
                r = await c.get(WASM_CDN + name)
                r.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Couldn't fetch the video cutter ({name}): {e}")
        tmp = p.with_suffix(".part")
        tmp.write_bytes(r.content)
        tmp.replace(p)
    return FileResponse(p, media_type="application/wasm" if name.endswith(".wasm") else "text/javascript",
                        headers={"Cache-Control": "public, max-age=31536000, immutable"})
