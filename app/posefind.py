"""Which finished Pose preview belongs to a clip, so a drive run can take it instead of reading the pose again.

A pose video matches a drive when it was made from the same clip (the same generation output, or the same media
file), with the same trim start (within a frame) and the same crop, by the same poser (DWPose or SDPose), and has
at least as many frames as the drive will take. Pose preview keeps every frame within its clip and Length, and one
more (dev/make_perf_templates.py pose_preview), so a Pose preview of the same Length always covers the drive."""
import math

FPS = 24
TEMPLATES = {"dwpose": "deck-pose-video", "sdpose": "deck-pose-sdpose"}
SOURCE_KEY, LEN_KEY = "src.video", "secs.value"   # the Pose preview's @1 Source video and @3 Length
CROP_EPS = 0.002      # crops are fractions of the frame
SLACK = 1             # frames: the clip's length is measured two ways (ffprobe here, the loader in ComfyUI)


def same_clip(a: dict, b: dict) -> bool:
    if not isinstance(a, dict) or not isinstance(b, dict):
        return False
    if a.get("generation") is not None or b.get("generation") is not None:
        try:
            return int(a.get("generation")) == int(b.get("generation")) and int(a.get("index") or 0) == int(b.get("index") or 0)
        except (TypeError, ValueError):
            return False
    return bool(a.get("media")) and a.get("media") == b.get("media")


def _crop(c):
    """(x, y, w, h), or None for no crop (or one so close to the whole frame it is none)."""
    if not isinstance(c, dict):
        return None
    try:
        box = tuple(float(c[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        return None
    return None if box[2] > 1 - CROP_EPS and box[3] > 1 - CROP_EPS else box


def same_crop(a, b) -> bool:
    a, b = _crop(a), _crop(b)
    if a is None or b is None:
        return a is b
    return all(abs(x - y) <= CROP_EPS for x, y in zip(a, b))


def _start(trim) -> float:
    try:
        return float((trim or {}).get("start") or 0)
    except (TypeError, ValueError, AttributeError):
        return 0.0


def _trim_len(trim) -> float:
    try:
        v = (trim or {}).get("len")
        return math.inf if v is None else float(v)
    except (TypeError, ValueError, AttributeError):
        return math.inf


def frames_needed(trim, secs, clip_secs=None) -> int:
    """The most frames a drive of Length secs on this trim can take (LTX's 8n+1 is one over secs x 24)."""
    left = math.inf if not clip_secs else max(0.0, clip_secs - _start(trim))
    want = round(min(_trim_len(trim), float(secs)) * FPS) + 1
    return min(want, round(left * FPS)) if math.isfinite(left) else want


def pose_frames(params: dict, clip_secs=None) -> int:
    """How many frames a Pose preview made, worked out from its settings (when its file can't be measured)."""
    src = params.get(SOURCE_KEY) or {}
    try:
        secs = float(params.get(LEN_KEY) or 5.0)
    except (TypeError, ValueError):
        secs = 5.0
    return frames_needed(src.get("trim"), secs, clip_secs)


def find(gens, source: dict, trim, crop, poser: str, secs: float, clip_secs=None, measure=None):
    """The newest matching pose video in gens (finished Pose previews, any order), as {generation, index, frames,
    seconds, url}; or None. measure(gen, output) gives an output's frames (None when it can't be read: then the
    settings say), or raises FileNotFoundError when the file is gone (then it is skipped)."""
    tid = TEMPLATES.get(poser or "dwpose")
    if not tid:
        return None
    need = frames_needed(trim, secs, clip_secs)
    for g in sorted(gens, key=lambda g: g["id"], reverse=True):
        if g.get("template") != tid or g.get("status") != "done":
            continue
        p = g.get("params") or {}
        src = p.get(SOURCE_KEY)
        if not isinstance(src, dict) or not same_clip(src, source):
            continue
        if abs(_start(src.get("trim")) - _start(trim)) >= 1 / FPS or not same_crop(src.get("crop"), crop):
            continue
        idx = next((i for i, o in enumerate(g.get("outputs") or []) if o.get("kind") == "video"), None)
        if idx is None:
            continue
        try:
            have = measure(g, g["outputs"][idx]) if measure else None
        except FileNotFoundError:
            continue
        if have is None:
            have = pose_frames(p, clip_secs)
        if have + SLACK < need:
            continue
        return {"generation": g["id"], "index": idx, "frames": have, "seconds": round(have / FPS, 3),
                "url": g["outputs"][idx].get("url"), "poser": poser or "dwpose"}
    return None
