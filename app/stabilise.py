"""Video stabilising: take the camera motion a track found (app/tracking.py) and warp each frame so the picture
holds still ("lock", as if on a tripod) or moves along a smoothed version of its own path ("smooth").

The track gives, for every frame, one similarity transform (shift, turn, uniform scale about the picture's centre)
that carries the first frame's content to where it sits in that frame. Each frame is warped by the target path's
transform times the inverse of its own, which puts its content where the target path says it should be. Warping
leaves empty (black) edges, so the result is zoomed in about the centre just enough to hide them in every frame,
up to a cap. Frames are read and written at the clip's full size through ffmpeg, and the source's sound for the
same span is kept. numpy and OpenCV load only when a clip is stabilised.
"""
import math
import subprocess
from pathlib import Path

from . import videoedit

ZOOM_CAP = 1.3


class MissingDeps(RuntimeError):
    pass


def _libs():
    try:
        import cv2
        import numpy as np
    except ImportError:
        raise MissingDeps("Stabilising needs numpy and OpenCV: run `pip install numpy opencv-python-headless` in ComfyChair's environment, then restart it.")
    return cv2, np


def similarity(f, W, H):
    """The 3x3 matrix that carries frame 0's content to frame f's picture: p' = s·R(rot)·(p − c) + c + (tx, ty),
    c the picture's centre, rot in degrees clockwise on screen (y down)."""
    _, np = _libs()
    a = math.radians(float(f.get("rot", 0)))
    s = float(f.get("scale", 1)) or 1.0
    cs, sn = s * math.cos(a), s * math.sin(a)
    cx, cy = W / 2, H / 2
    return np.array([[cs, -sn, cx - cs * cx + sn * cy + float(f.get("tx", 0))],
                     [sn, cs, cy - sn * cx - cs * cy + float(f.get("ty", 0))],
                     [0.0, 0.0, 1.0]])


def _smooth(np, a, sigma):
    """Gaussian smoothing, sigma in frames, the ends holding their value (as web/track-math.js smooth())."""
    a = np.asarray(a, float)
    if not sigma > 0.05 or len(a) < 3:
        return a.copy()
    r = math.ceil(sigma * 3)
    k = np.exp(-(np.arange(-r, r + 1) ** 2) / (2 * sigma * sigma))
    k /= k.sum()
    return np.convolve(np.pad(a, r, mode="edge"), k, mode="valid")


def path(frames, sigma=2.0, mode="smooth", roll=True):
    """The motion each frame should have after stabilising, as {tx, ty, rot, scale} per frame. "lock" holds the
    first frame's view; "smooth" follows the footage's own path, smoothed. roll=False leaves the turn as it was."""
    _, np = _libs()
    rot = np.degrees(np.unwrap(np.radians([float(f.get("rot", 0)) for f in frames])))   # (no jump at ±180)
    if mode == "lock":
        out = [{"tx": 0.0, "ty": 0.0, "rot": 0.0, "scale": 1.0} for _ in frames]
    else:
        sm = {k: _smooth(np, [float(f.get(k, 1.0 if k == "scale" else 0.0)) for f in frames], sigma) for k in ("tx", "ty", "scale")}
        r = _smooth(np, rot, sigma)
        out = [{"tx": float(sm["tx"][i]), "ty": float(sm["ty"][i]), "rot": float(r[i]), "scale": float(sm["scale"][i])}
               for i in range(len(frames))]
    if not roll:
        for o, r in zip(out, rot):
            o["rot"] = float(r)
    return out


def corrections(frames, W, H, sigma=2.0, mode="smooth", roll=True):
    """Per frame, the 2x3 affine (for cv2.warpAffine) that moves the frame's picture onto the target path:
    target · raw⁻¹."""
    _, np = _libs()
    return [(similarity(t, W, H) @ np.linalg.inv(similarity(f, W, H)))[:2]
            for f, t in zip(frames, path(frames, sigma, mode, roll))]


def fit_zoom(warps, W, H, cap=ZOOM_CAP):
    """The smallest zoom about the centre that hides the empty edges in every warped frame, at most cap: the largest
    centred rectangle of the picture's shape that stays inside every warped frame outline."""
    _, np = _libs()
    c = np.array([W / 2, H / 2])
    half = np.array([W / 2, H / 2])
    corners = np.array([[0, 0], [W, 0], [W, H], [0, H]], float)
    signs = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]], float)
    a = 1.0   # the rectangle's size as a fraction of the picture
    for A in warps:
        A = np.asarray(A, float)
        q = corners @ A[:, :2].T + A[:, 2]
        area = sum(q[i, 0] * q[(i + 1) % 4, 1] - q[(i + 1) % 4, 0] * q[i, 1] for i in range(4))
        for i in range(4):
            p0, p1 = q[i], q[(i + 1) % 4]
            e = p1 - p0
            n = np.array([-e[1], e[0]]) if area > 0 else np.array([e[1], -e[0]])   # points inside the outline
            m = n @ (c - p0)
            if m <= 0:   # the centre itself is uncovered: nothing small enough
                return float(cap)
            k = (signs * half) @ n   # how each rectangle corner moves along n per unit of a
            worst = k.min()
            if worst < 0:
                a = min(a, m / -worst)
    return float(min(cap, max(1.0, 1.0 / a)))


def _zoom(zoom, warps, W, H):
    if zoom in (None, "auto"):
        return fit_zoom(warps, W, H)
    if zoom == "none":
        return 1.0
    return float(zoom)


def _read(src, start, n, W, H):
    """Yield BGR frames (H, W, 3) from `start` seconds, at full size."""
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", str(src), "-an", "-frames:v", str(n),
           "-vf", f"scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = W * H * 3
    try:
        while True:
            buf = p.stdout.read(size)
            while buf and len(buf) < size:
                more = p.stdout.read(size - len(buf))
                if not more:
                    break
                buf += more
            if len(buf) < size:
                return
            yield buf
    finally:
        p.kill()
        p.wait()
        p.stdout.close()


def _encode(cv2, np, src, out, info, warps, start, fps, W, H, ow, oh, enc):
    """Warp and write every frame; returns (frames written, ffmpeg's return code, its error text)."""
    dur = len(warps) / fps
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{ow}x{oh}", "-framerate", f"{fps:.6f}",
           "-i", "-"]
    if info.get("audio"):
        cmd += ["-ss", f"{start:.3f}", "-t", f"{dur:.3f}", "-i", str(src), "-map", "0:v", "-map", "1:a?",
                "-c:a", "aac", "-b:a", "192k", "-shortest"]
    cmd += [*enc, "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    count = 0
    try:
        for raw in _read(src, start, len(warps), W, H):
            fr = np.frombuffer(raw, np.uint8).reshape(H, W, 3)
            img = cv2.warpAffine(fr, warps[count], (ow, oh), flags=cv2.INTER_LINEAR,
                                 borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
            p.stdin.write(img.tobytes())
            count += 1
            if count >= len(warps):
                break
    except BrokenPipeError:
        pass
    finally:
        try:
            p.stdin.close()
        except BrokenPipeError:
            pass
        err = p.stderr.read().decode(errors="replace")
        p.wait()
    return count, p.returncode, err


def render(src, out, track, start=0.0, end=None, sigma=2.0, mode="smooth", roll=True, zoom="auto"):
    """Write a stabilised copy of src (from `start` seconds, one frame per track frame) to out.
    Returns {"duration", "zoom", "width", "height"}."""
    cv2, np = _libs()
    src, out = Path(src), Path(out)
    info = videoedit.probe(src)
    if not info["video"] or not info["width"]:
        raise ValueError("That isn't a video")
    frames = list((track or {}).get("frames") or [])
    if len(frames) < 2:
        raise ValueError("Track the clip first")
    W, H = info["width"], info["height"]
    fps = float((track or {}).get("fps") or info["fps"] or 24.0)
    start = max(0.0, float(start or 0))
    if end is not None and float(end) > start:
        frames = frames[:max(2, int(round((float(end) - start) * fps)))]
    # the track measures shifts in the clip's own pixels; rescale if it was made at another size
    tw, th = ((track or {}).get("size") or [W, H])[:2]
    kx, ky = W / float(tw or W), H / float(th or H)
    if abs(kx - 1) > 1e-6 or abs(ky - 1) > 1e-6:
        frames = [{**f, "tx": float(f.get("tx", 0)) * kx, "ty": float(f.get("ty", 0)) * ky} for f in frames]
    if mode not in ("smooth", "lock"):
        raise ValueError("Pick smooth or lock")
    warps = corrections(frames, W, H, sigma, mode, roll)
    z = _zoom(zoom, warps, W, H)
    ow, oh = max(2, W // 2 * 2), max(2, H // 2 * 2)
    Z = np.array([[z, 0, (1 - z) * W / 2], [0, z, (1 - z) * H / 2], [0, 0, 1]])
    warps = [(Z @ np.vstack([w, [0, 0, 1]]))[:2] for w in warps]
    out.parent.mkdir(parents=True, exist_ok=True)
    count, rc, err = _encode(cv2, np, src, out, info, warps, start, fps, W, H, ow, oh, videoedit.h264())
    if rc and videoedit.nvenc():   # NVENC refused (busy, too small): again with libx264
        count, rc, err = _encode(cv2, np, src, out, info, warps, start, fps, W, H, ow, oh,
                                 ["-c:v", "libx264", "-preset", "medium", "-crf", "18"])
    if rc or count < 1:
        out.unlink(missing_ok=True)
        raise ValueError("Couldn't write the stabilised video: " + (err.strip()[-200:] or "no frames read"))
    return {"duration": round(count / fps, 3), "zoom": round(z, 4), "width": ow, "height": oh}
