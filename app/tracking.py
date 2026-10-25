"""Simple motion tracking: how the picture moves from frame to frame in a clip (pan, tilt, roll,
zoom), found with sparse optical flow. The browser turns it into a 3D camera (web/track.js).

Per frame pair: corner points are followed with pyramidal Lucas-Kanade, checked by following them
back (a point that doesn't return to where it started is dropped), and one similarity transform
(shift, turn, uniform scale) is fitted to them with RANSAC; points that don't agree (a moving
subject) fall out as outliers and are dropped. Transforms accumulate from the first frame, measured
at the picture's centre. Works on a ~640 px wide copy; numpy and OpenCV load only when a track runs.
"""
import math
import subprocess
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from . import config, db, videoedit

router = APIRouter(prefix="/api/track")
resolve_src = None  # async (src dict, tmp dir) -> (path, kind); main.py sets it to the Video tab's source lookup

TRACK_W = 640        # frames are analysed at this width (or the clip's own, if smaller)
MAX_FRAMES = 1800    # 75 s at 24 fps
MIN_POINTS = 80      # below this many live points, seed more
MAX_POINTS = 300
FB_TOL = 1.0         # forward-backward error allowed, in analysis pixels
RANSAC_TOL = 2.0
SHOW_TRACKS = 60     # paths kept for display
ATLAS_FRAMES = 256   # the backdrop picture holds at most this many frames
ATLAS_SIDE = 4096


class MissingDeps(RuntimeError):
    pass


def _libs():
    try:
        import cv2
        import numpy as np
    except ImportError:
        raise MissingDeps("Motion tracking needs numpy and OpenCV: run `pip install numpy opencv-python-headless` in ComfyDeck's environment, then restart it.")
    return cv2, np


def _box(b):
    """A box [x0, y0, x1, y1] in 0..1, or None."""
    if not b:
        return None
    try:
        x0, y0, x1, y1 = (min(1.0, max(0.0, float(v))) for v in b)
    except (TypeError, ValueError):
        raise ValueError("A box needs four numbers")
    x0, x1, y0, y1 = min(x0, x1), max(x0, x1), min(y0, y1), max(y0, y1)
    return (x0, y0, x1, y1) if x1 - x0 > 0.01 and y1 - y0 > 0.01 else None


def _frames(path, info, start, n, tw, th):
    """Yield BGR frames (th, tw, 3) from `start` seconds, via ffmpeg so any codec works."""
    cmd = ["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", str(path), "-an", "-frames:v", str(n),
           "-vf", f"scale={tw}:{th}", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    size = tw * th * 3
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


def analyse(path, start=0.0, end=None, region=None, exclude=None, progress=None, cancel=None, atlas_path=None):
    """Track a clip. Returns {v, fps, size, start, n, frames: [{tx, ty, rot, scale}], tracks, lost, atlas}.
    tx, ty: where the first frame's centre has moved to, in the clip's own pixels (right and down are
    positive); rot: degrees clockwise; scale: >1 is zoomed in. All measured from the first frame."""
    cv2, np = _libs()
    info = videoedit.probe(Path(path))
    if not info["video"] or not info["width"]:
        raise ValueError("That isn't a video")
    W, H, fps = info["width"], info["height"], info["fps"]
    start = max(0.0, float(start or 0))
    end = min(float(end) if end else info["duration"], info["duration"] or 1e9)
    if end - start < 0.2:
        raise ValueError("Pick at least a fifth of a second to track")
    n = min(MAX_FRAMES, max(2, int(round((end - start) * fps))))
    tw = min(TRACK_W, W) // 2 * 2
    th = max(2, round(H * tw / W) // 2 * 2)
    k = W / tw
    region, exclude = _box(region), _box(exclude)
    box = lambda b: tuple(int(round(v)) for v in (b[0] * tw, b[1] * th, b[2] * tw, b[3] * th))  # noqa: E731
    base = np.zeros((th, tw), np.uint8)
    if region:
        x0, y0, x1, y1 = box(region)
        base[y0:y1, x0:x1] = 255
    else:
        base[:] = 255
    ex = box(exclude) if exclude else None
    if ex:
        base[ex[1]:ex[3], ex[0]:ex[2]] = 0

    M = np.eye(3)
    centre = np.array([tw / 2, th / 2, 1.0])
    out = [{"tx": 0.0, "ty": 0.0, "rot": 0.0, "scale": 1.0}]
    pts = np.zeros((0, 1, 2), np.float32)
    ids = np.zeros(0, np.int64)
    paths: dict[int, list] = {}   # id -> [first frame, [x, y]...]
    nxt_id, lost, prev, thumbs = 0, 0, None, []
    step = max(1, math.ceil(n / ATLAS_FRAMES))
    lk = dict(winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))

    count = 0
    for raw in _frames(path, info, start, n, tw, th):
        if cancel and cancel():
            raise InterruptedError("Stopped")
        bgr = np.frombuffer(raw, np.uint8).reshape(th, tw, 3)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        if count % step == 0:
            thumbs.append(bgr.copy())
        if prev is not None:
            A = None
            if len(pts) >= 6:
                nx, st, _ = cv2.calcOpticalFlowPyrLK(prev, gray, pts, None, **lk)
                bk, st2, _ = cv2.calcOpticalFlowPyrLK(gray, prev, nx, None, **lk)
                err = np.abs(bk - pts).reshape(-1, 2).max(axis=1)
                x, y = nx[:, 0, 0], nx[:, 0, 1]
                ok = (st.ravel() == 1) & (st2.ravel() == 1) & (err < FB_TOL) & (x >= 0) & (y >= 0) & (x < tw) & (y < th)
                if ex:
                    ok &= ~((x >= ex[0]) & (x < ex[2]) & (y >= ex[1]) & (y < ex[3]))
                p0, p1, keep = pts[ok], nx[ok], ids[ok]
                if len(p0) >= 6:
                    A, inl = cv2.estimateAffinePartial2D(p0, p1, method=cv2.RANSAC, ransacReprojThreshold=RANSAC_TOL, maxIters=500)
                    if A is not None:
                        inl = inl.ravel() == 1
                        if inl.sum() < 6:
                            A = None
                        else:
                            pts, ids = p1[inl], keep[inl]
                if A is None:
                    pts, ids = np.zeros((0, 1, 2), np.float32), np.zeros(0, np.int64)
            if A is None:   # nothing to go on: hold still, and start over from fresh points
                lost += 1
                A = np.array([[1, 0, 0], [0, 1, 0]], np.float64)
            M = np.vstack([A, [0, 0, 1]]) @ M
            c = M @ centre
            out.append({"tx": float((c[0] - centre[0]) * k), "ty": float((c[1] - centre[1]) * k),
                        "rot": math.degrees(math.atan2(M[1, 0], M[0, 0])), "scale": float(math.hypot(M[0, 0], M[1, 0]))})
            for i, (px, py) in zip(ids, pts[:, 0, :]):
                paths[int(i)].append([float(px), float(py)])
        if len(pts) < MIN_POINTS:
            mask = base.copy()
            for px, py in pts[:, 0, :]:
                cv2.circle(mask, (int(px), int(py)), 12, 0, -1)
            new = cv2.goodFeaturesToTrack(gray, MAX_POINTS - len(pts), 0.01, 12, mask=mask, blockSize=7)
            if new is not None:
                new = new.astype(np.float32)
                fresh = np.arange(nxt_id, nxt_id + len(new))
                nxt_id += len(new)
                for i, (px, py) in zip(fresh, new[:, 0, :]):
                    paths[int(i)] = [count, [float(px), float(py)]]
                pts, ids = np.concatenate([pts, new]), np.concatenate([ids, fresh])
        prev = gray
        count += 1
        if progress and count % 4 == 0:
            progress(min(0.95, count / n))
    if count < 2:
        raise ValueError("Couldn't read frames from that video")

    # the longest paths, as 0..1 of the picture (the first is the frame the path starts on)
    keep = sorted((p for p in paths.values() if len(p) >= 7), key=lambda p: -len(p))[:SHOW_TRACKS]
    tracks = [{"f": p[0], "p": [[round(x / tw, 4), round(y / th, 4)] for x, y in p[1:]]} for p in keep]
    for f in out:
        for key in f:
            f[key] = round(f[key], 4)
    res = {"v": 1, "fps": round(fps, 4), "size": [W, H], "start": round(start, 3), "n": count, "frames": out,
           "tracks": tracks, "lost": lost, "region": region, "exclude": exclude}
    if atlas_path:
        res["atlas"] = _atlas(cv2, np, thumbs, count, step, tw / th, atlas_path)
    if progress:
        progress(1.0)
    return res


def _atlas(cv2, np, thumbs, count, step, aspect, path):
    """The footage as one picture of small frames in a grid (the 3D backdrop shows one at a time).
    Frame f is tile round(f / step), counted along rows from the top left."""
    m = len(thumbs)
    cols = max(1, math.ceil(math.sqrt(m * aspect)))
    rows = math.ceil(m / cols)
    tw = min(thumbs[0].shape[1], ATLAS_SIDE // cols)
    th = round(tw / aspect)
    if rows * th > ATLAS_SIDE:
        th = ATLAS_SIDE // rows
        tw = round(th * aspect)
    sheet = np.zeros((rows * th, cols * tw, 3), np.uint8)
    for i, t in enumerate(thumbs):
        r, c = divmod(i, cols)
        sheet[r * th:(r + 1) * th, c * tw:(c + 1) * tw] = cv2.resize(t, (tw, th), interpolation=cv2.INTER_AREA)
    path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(path), sheet, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return {"cols": cols, "rows": rows, "count": m, "step": step, "tile": [tw, th]}


# ---- jobs: one thread per track, polled by the browser ----
JOBS: dict[str, dict] = {}
_lock = threading.Lock()


def _run(job, kw):
    try:
        job["result"] = analyse(progress=lambda p: job.update(progress=p), cancel=lambda: job["cancel"], **kw)
        job["state"] = "done"
    except InterruptedError:
        job["state"] = "error"; job["error"] = "Stopped"
    except Exception as e:  # shown to the user as is
        job["state"] = "error"; job["error"] = str(e) or e.__class__.__name__
    job["progress"] = 1.0


@router.post("")
async def start(body: dict = Body(...)):
    try:
        _libs()
    except MissingDeps as e:
        raise HTTPException(400, str(e))
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        path, kind = await resolve_src(body.get("src") or {}, Path(td))
    if kind != "video":
        raise HTTPException(400, "Pick a video to track")
    pid = body.get("project_id")
    if pid is not None and not any(p["id"] == pid for p in db.list_projects()):
        raise HTTPException(404, "No such project")
    group = uuid.uuid4().hex[:8]
    folder = db.project_folder(pid)
    atlas = config.PROJECTS_DIR / folder / ".deck" / "assets" / group / "backdrop.jpg"
    job = {"state": "running", "progress": 0.0, "cancel": False, "t": time.time(),
           "url": f"/files/projects/{folder}/.deck/assets/{group}/backdrop.jpg"}
    kw = {"path": path, "start": body.get("start") or 0, "end": body.get("end"), "region": body.get("region"),
          "exclude": body.get("exclude"), "atlas_path": atlas}
    try:
        _box(kw["region"]); _box(kw["exclude"])
    except ValueError as e:
        raise HTTPException(400, str(e))
    jid = uuid.uuid4().hex[:12]
    with _lock:
        for old in [k for k, j in JOBS.items() if j["state"] != "running" and time.time() - j["t"] > 3600]:
            del JOBS[old]
        JOBS[jid] = job
    threading.Thread(target=_run, args=(job, kw), daemon=True).start()
    return {"job": jid}


@router.get("/{jid}")
async def status(jid: str):
    job = JOBS.get(jid)
    if not job:
        raise HTTPException(404, "No such tracking job")
    out = {"state": job["state"], "progress": round(job["progress"], 3), "error": job.get("error")}
    if job["state"] == "done":
        res = dict(job["result"])
        if "atlas" in res:
            res["atlas"] = {**res["atlas"], "url": job["url"]}
        out["result"] = res
    return out


@router.post("/{jid}/cancel")
async def cancel(jid: str):
    if jid in JOBS:
        JOBS[jid]["cancel"] = True
    return {}
