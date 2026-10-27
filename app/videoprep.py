"""Trim / crop a video input before ComfyUI loads it (VHS_LoadVideoPath).

Trim alone maps onto the loader's own skip_first_frames / frame_load_cap (no re-encode). A crop needs
ffmpeg; it cuts the trim at the same time, so only the wanted part is re-encoded. Derived copies are
named after source+params, so the same edit reuses one file."""
import hashlib
import json
import math
import os
import subprocess
import time
from pathlib import Path

from . import config, videoedit

PREFIX = "vprep_"
MIN_LEN = 0.04       # shorter than a frame is nothing
FULL_EPS = 0.002     # a crop this close to the whole frame is no crop


def norm_trim(trim, duration: float):
    """(start, length) in seconds, clamped to the clip; None when it keeps the whole clip."""
    if not trim:
        return None
    try:
        start = float(trim.get("start") or 0)
        length = trim.get("len")
        length = None if length is None else float(length)
    except (TypeError, ValueError, AttributeError):
        raise ValueError("trim needs numbers: {start, len}")
    if not (math.isfinite(start) and (length is None or math.isfinite(length))) or start < 0 or (length is not None and length <= 0):
        raise ValueError("trim: start can't be negative and length must be positive")
    if duration and start >= duration - MIN_LEN:
        raise ValueError(f"trim starts at {start:.2f}s but the clip is only {duration:.2f}s long")
    end = min(start + length, duration) if length is not None and duration else (start + length if length is not None else duration)
    length = (end - start) if end else None
    if length is not None and length < MIN_LEN:
        raise ValueError("trim is shorter than a frame")
    if start < MIN_LEN and (length is None or not duration or length >= duration - MIN_LEN):
        return None
    return round(start, 3), (None if length is None else round(length, 3))


def norm_crop(crop, width: int, height: int):
    """(x, y, w, h) in pixels (even sizes, as yuv420p needs); None when it keeps the whole frame."""
    if not crop:
        return None
    try:
        x, y, w, h = (float(crop[k]) for k in ("x", "y", "w", "h"))
    except (TypeError, KeyError, ValueError):
        raise ValueError("crop needs {x, y, w, h} as fractions of the frame")
    if not all(math.isfinite(n) for n in (x, y, w, h)) or w <= 0 or h <= 0 or x < -FULL_EPS or y < -FULL_EPS \
            or x + w > 1 + FULL_EPS or y + h > 1 + FULL_EPS:
        raise ValueError("crop must lie inside the frame (fractions 0..1)")
    if w > 1 - FULL_EPS and h > 1 - FULL_EPS:
        return None
    pw = max(2, int(round(w * width / 2)) * 2)
    ph = max(2, int(round(h * height / 2)) * 2)
    px = min(max(0, int(round(x * width / 2)) * 2), max(0, width - pw))
    py = min(max(0, int(round(y * height / 2)) * 2), max(0, height - ph))
    return px, py, min(pw, width - px), min(ph, height - py)


def cache_key(src: Path, trim, crop) -> str:
    """trim/crop as normalised; the source's size and mtime so a replaced file isn't served stale."""
    st = src.stat()
    blob = json.dumps([str(src.resolve()), st.st_size, st.st_mtime_ns, trim, crop], separators=(",", ":"))
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def build_cmd(src: Path, out: Path, info: dict, trim, crop) -> list[str]:
    """ffmpeg argv. Accurate seek (-ss after -i); audio kept when the source has it."""
    cmd = ["ffmpeg", "-y", "-v", "error", "-i", str(src)]
    if trim:
        start, length = trim
        cmd += ["-ss", f"{start:.3f}"]
        if length is not None:
            cmd += ["-t", f"{length:.3f}"]
    if crop:
        x, y, w, h = crop
        cmd += ["-vf", f"crop={w}:{h}:{x}:{y}"]
    cmd += [*videoedit.h264(16, "veryfast"), "-pix_fmt", "yuv420p"]
    cmd += ["-c:a", "aac", "-b:a", "192k"] if info.get("audio") else ["-an"]
    return cmd + ["-movflags", "+faststart", str(out)]


def prep(src: Path, trim=None, crop=None, info: dict | None = None) -> dict:
    """Make (or reuse) the derived copy: {"path", "width", "height", "duration", "cached"}."""
    info = info or videoedit.probe(src)
    if not info["video"]:
        raise ValueError("that isn't a video")
    trim, crop = norm_trim(trim, info["duration"]), norm_crop(crop, info["width"], info["height"])
    if not trim and not crop and not info.get("rotation"):
        return {"path": src, "width": info["width"], "height": info["height"], "duration": info["duration"], "cached": True}
    out = config.VIDEOPREP_DIR / f"{PREFIX}{cache_key(src, trim, crop)}.mp4"
    cached = out.is_file() and out.stat().st_size > 0
    if cached:
        os.utime(out)   # in use: keeps it out of prune()
    else:
        tmp = out.with_name(out.stem + ".part.mp4")
        try:
            r = videoedit.run_ffmpeg(build_cmd(src, tmp, info, trim, crop), timeout=1800)
            if r.returncode:
                raise subprocess.CalledProcessError(r.returncode, "ffmpeg", r.stdout, r.stderr)
            tmp.replace(out)
        except subprocess.CalledProcessError as e:
            tmp.unlink(missing_ok=True)
            raise ValueError("ffmpeg couldn't trim/crop that video: " + (e.stderr or b"").decode(errors="replace").strip()[-300:])
        finally:
            tmp.unlink(missing_ok=True)
    got = videoedit.probe(out)
    return {"path": out, "width": got["width"], "height": got["height"], "duration": got["duration"], "cached": cached}


def loader_trim(info: dict, trim, loader: dict):
    """The loader's own inputs that make this trim, or None when it doesn't expose them.
    loader: the node's inputs as the run will send them. Frames count at the loader's rate
    (force_rate, else the clip's); frame_load_cap counts frames kept after select_every_nth."""
    if "skip_first_frames" not in loader or "frame_load_cap" not in loader:
        return None
    rate = loader.get("force_rate")
    if isinstance(rate, bool) or not isinstance(rate, (int, float)) or isinstance(loader.get("skip_first_frames"), (list, dict)):
        return None
    rate = float(rate) if rate > 0 else info["fps"]
    nth = loader.get("select_every_nth")
    nth = int(nth) if isinstance(nth, (int, float)) and nth >= 1 else 1
    own_skip, own_cap = loader.get("skip_first_frames") or 0, loader.get("frame_load_cap") or 0
    if not isinstance(own_skip, (int, float)) or not isinstance(own_cap, (int, float)):
        return None
    start, length = trim
    skip = int(own_skip) + int(round(start * rate))
    out = {"skip_first_frames": skip}
    if length is not None:
        cap = max(1, int(math.ceil(round(length * rate, 4) / nth)))
        out["frame_load_cap"] = min(cap, int(own_cap)) if own_cap else cap
    return out


def plan(src: Path, trim, crop, loader: dict) -> dict:
    """What a run needs for one video input: {"path", "inputs": {loader input: value}}.
    Raises ValueError for a bad trim/crop."""
    info = videoedit.probe(src)
    if not info["video"]:
        raise ValueError("that isn't a video")
    t, c = norm_trim(trim, info["duration"]), norm_crop(crop, info["width"], info["height"])
    if c or info.get("rotation"):   # ffmpeg crops and cuts in one pass; a copy also has a rotation tag baked in
        return {"path": prep(src, trim, crop, info)["path"], "inputs": {}}
    if t:
        mapped = loader_trim(info, t, loader)
        if mapped:
            return {"path": src, "inputs": mapped}
        return {"path": prep(src, trim, None, info)["path"], "inputs": {}}
    return {"path": src, "inputs": {}}


def prune(max_age_days=30):
    """Derived copies are remade on demand: clear the ones unused for a month."""
    cutoff = time.time() - max_age_days * 86400
    for p in [*config.VIDEOPREP_DIR.glob(f"{PREFIX}*.mp4"), *config.VIDEOPREP_DIR.glob("canvas_*.mp4")]:   # (and Extend frame's)
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:
            pass
