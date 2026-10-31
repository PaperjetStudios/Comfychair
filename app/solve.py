"""3D camera solve: where the camera was, in 3D, for every frame of a clip, plus a few scene points and the
floor, for the 3D tab (web/track-math.js sceneFromSolve). The 2D point tracks come from tracking.py (KLT or
TAPNext++); the depth comes from ComfyUI's core geometry nodes, read back through comfy_nodes/deck_solve.

method "pnp": MoGe gives the first frame's 3D points (metres) and lens; every later frame's camera is the
pose that puts those points where the tracks saw them (OpenCV PnP with RANSAC, then Levenberg-Marquardt).
method "da3": Depth Anything 3 places the cameras of a few dozen evenly spaced frames together (multi-view);
the frames between are interpolated, and the scene points come from the first view's depth (no real scale).

Coordinates: camera 0's frame, OpenCV axes (x right, y down, z forward). cams are camera-to-world 3x4 and
cams[0] is the identity. Files: the first frame goes into ComfyUI's input folder and the cut clip into
data/tmp for the run only; ComfyUI's JSON answer is deleted once read (storage.py: ComfyUI keeps nothing).
"""
import asyncio
import importlib.util
import json
import math
import subprocess
import time
import uuid
from pathlib import Path

from . import config, storage, tracking

MOGE_NODE = "DeckMoGeExport"
DA3_NODE = "DeckDA3Export"
METHODS = ("pnp", "da3")
TRACKERS = ("klt", "tapnext")
DA3_RES = 504        # DA3's working size (longest side): the cut clip is made at it, so its intrinsics need no guess
DA3_GRID = 96        # columns of the depth grid the scene points and floor come from
MOGE_GRID = 48
MAX_PTS = 400
MIN_VIS = 6
FLOOR_MIN = 50
_geom = None


def geom():
    """comfy_nodes/deck_solve/geom.py (plain numpy), loaded by path: its package needs ComfyUI."""
    global _geom
    if _geom is None:
        spec = importlib.util.spec_from_file_location("deck_solve_geom", config.BASE_DIR / "comfy_nodes" / "deck_solve" / "geom.py")
        _geom = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_geom)
    return _geom


def to_clip(np, T, kx, ky):
    """Analysis pixels (tracking.py's TRACK_W copy) to the clip's own, pixel centres matched."""
    return (np.asarray(T, np.float64) + 0.5) * np.array([kx, ky]) - 0.5


def lift(points2d, moge_export):
    """The tracked points with a 3D position in frame 0: (indices into points2d, X (M, 3)). moge_export's
    "points" answers points2d one for one (None where MoGe has nothing)."""
    _, np = tracking._libs()
    got = moge_export.get("points") or []
    if len(got) != len(points2d):
        raise ValueError("MoGe answered a different number of points than it was asked")
    ids = [i for i, p in enumerate(got) if p is not None and all(math.isfinite(v) for v in p) and p[2] > 0]
    X = np.array([got[i] for i in ids], np.float64).reshape(-1, 3)
    return np.array(ids, np.int64), X


def floor_from_grid(grid, cam_y_down=True):
    """The floor as a plane {n, d} (n·X + d = 0, n unit and pointing up, the camera above it), fitted with RANSAC
    to the lower 60 % of the picture's grid points ({cols, rows, points: [[x, y, z] | None]} row by row from the
    top). Inliers lie within 2 % of the median depth. None with under 50 inliers, a steep plane (|n_y| < 0.5) or
    the camera below it."""
    _, np = tracking._libs()
    cols, rows, pts = grid["cols"], grid["rows"], grid["points"]
    first = int(math.floor(rows * 0.4))
    P = np.array([p for i, p in enumerate(pts) if p is not None and i // cols >= first], np.float64).reshape(-1, 3)
    P = P[np.isfinite(P).all(axis=1)]
    if len(P) < FLOOR_MIN:
        return None
    tol = 0.02 * float(np.median(np.abs(P[:, 2])))
    up = -1.0 if cam_y_down else 1.0
    rng = np.random.default_rng(0)
    best, best_n = None, 0
    for _ in range(400):
        a, b, c = P[rng.choice(len(P), 3, replace=False)]
        n = np.cross(b - a, c - a)
        ln = np.linalg.norm(n)
        if ln < 1e-12:
            continue
        n /= ln
        if abs(n[1]) < 0.5:   # (only floor-like planes: a wall low in the picture mustn't win)
            continue
        inl = np.abs(P @ n - n @ a) < tol
        if inl.sum() > best_n:
            best, best_n = inl, int(inl.sum())
    if best is None or best_n < FLOOR_MIN:
        return None
    for k in (1.0, 0.5, 0.25):   # least squares on the inliers, then on the refit's closer ones (where a wall meets
        Q = P[best]              # the floor, its foot is within the tolerance and tilts the plane)
        c = Q.mean(axis=0)
        sv, vt = np.linalg.svd(Q - c)[1:]
        n, d = vt[-1], -float(vt[-1] @ c)
        close = np.abs(P @ n + d) < tol * k
        if close.sum() < FLOOR_MIN:
            break
        best = close
    if (np.abs(P @ n + d) < tol).sum() < FLOOR_MIN or sv[1] < 0.15 * sv[0]:   # (a strip along a wall isn't a floor)
        return None
    if n[1] * up < 0:
        n, d = -n, -d
    if abs(n[1]) < 0.5 or d <= 0:
        return None
    return {"n": [float(v) for v in n], "d": d}


def _c2w(cv2, np, rvec, tvec):
    R = cv2.Rodrigues(rvec)[0]
    t = np.asarray(tvec, np.float64).reshape(3)
    return np.concatenate([R.T, (-R.T @ t)[:, None]], axis=1)


def solve_pnp(T, V, X, ids, K, k_scale):
    """Camera-to-world 3x4 for every frame from tracks T (Q, N, 2, analysis px) seen where V (Q, N), of which
    tracks ids have world positions X (M, 3). K [fx, fy, cx, cy] in clip pixels; k_scale: analysis to clip
    pixels (a number or (kx, ky)). Frame 0 is the identity. A frame with under 6 points seen, or no solve,
    keeps the previous pose and counts as lost. Returns (cams (N, 3, 4), {"used", "lost"})."""
    cv2, np = tracking._libs()
    kx, ky = (k_scale, k_scale) if isinstance(k_scale, (int, float)) else k_scale
    Km = np.array([[K[0], 0, K[2]], [0, K[1], K[3]], [0, 0, 1]], np.float64)
    thr = max(3.0, 1.5 * max(kx, ky))   # 3 px at clip scale, but never finer than the tracks themselves
    N = T.shape[1]
    X = np.asarray(X, np.float64)
    cams = np.zeros((N, 3, 4))
    cams[0, :, :3] = np.eye(3)
    rvec, tvec = np.zeros((3, 1)), np.zeros((3, 1))
    fresh, lost = True, 0   # (fresh: no trusted pose to start from, so SQPnP rather than a refinement)
    for f in range(1, N):
        vis = V[ids, f]
        ok = False
        if vis.sum() >= MIN_VIS:
            obj = np.ascontiguousarray(X[vis])
            img = np.ascontiguousarray(to_clip(np, T[ids[vis], f], kx, ky))
            try:
                if fresh:
                    ok, r, t, inl = cv2.solvePnPRansac(obj, img, Km, None, flags=cv2.SOLVEPNP_SQPNP,
                                                       reprojectionError=thr, iterationsCount=300, confidence=0.999)
                else:
                    ok, r, t, inl = cv2.solvePnPRansac(obj, img, Km, None, rvec=rvec.copy(), tvec=tvec.copy(), useExtrinsicGuess=True,
                                                       flags=cv2.SOLVEPNP_ITERATIVE, reprojectionError=thr, iterationsCount=300, confidence=0.999)
            except cv2.error:
                ok = False
            if ok and inl is not None and len(inl) >= MIN_VIS:
                inl = inl.ravel()
                r, t = cv2.solvePnPRefineLM(obj[inl], img[inl], Km, None, r, t)
                ok = bool(np.isfinite(r).all() and np.isfinite(t).all())
            else:
                ok = False
        if ok:
            rvec, tvec, fresh = r, t, False
            cams[f] = _c2w(cv2, np, rvec, tvec)
        else:
            lost += 1
            fresh = True
            cams[f] = cams[f - 1]
    return cams, {"used": int(len(ids)), "lost": lost}


def reproj_err(cams, X, ids, T, V, K, k_scale):
    """Median distance (clip pixels) between where the cameras put the points and where the tracks saw them."""
    _, np = tracking._libs()
    kx, ky = (k_scale, k_scale) if isinstance(k_scale, (int, float)) else k_scale
    errs = []
    for f in range(T.shape[1]):
        vis = V[ids, f]
        if not vis.any():
            continue
        R, t = cams[f][:, :3], cams[f][:, 3]
        Xc = (X[vis] - t) @ R   # Rᵀ(X − t), row by row
        front = Xc[:, 2] > 1e-6
        if not front.any():
            continue
        u = K[0] * Xc[front, 0] / Xc[front, 2] + K[2]
        v = K[1] * Xc[front, 1] / Xc[front, 2] + K[3]
        seen = to_clip(np, T[ids[vis][front], f], kx, ky)
        errs.append(np.hypot(u - seen[:, 0], v - seen[:, 1]))
    return float(np.median(np.concatenate(errs))) if errs else None


# ---- rotations, for interpolating DA3's sampled cameras ----
def _quat(np, R):
    """Rotation matrix to a unit quaternion (w, x, y, z)."""
    tr = R[0, 0] + R[1, 1] + R[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        q = [0.25 * s, (R[2, 1] - R[1, 2]) / s, (R[0, 2] - R[2, 0]) / s, (R[1, 0] - R[0, 1]) / s]
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = math.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        q = [(R[2, 1] - R[1, 2]) / s, 0.25 * s, (R[0, 1] + R[1, 0]) / s, (R[0, 2] + R[2, 0]) / s]
    elif R[1, 1] > R[2, 2]:
        s = math.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        q = [(R[0, 2] - R[2, 0]) / s, (R[0, 1] + R[1, 0]) / s, 0.25 * s, (R[1, 2] + R[2, 1]) / s]
    else:
        s = math.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
        q = [(R[1, 0] - R[0, 1]) / s, (R[0, 2] + R[2, 0]) / s, (R[1, 2] + R[2, 1]) / s, 0.25 * s]
    q = np.array(q)
    return q / np.linalg.norm(q)


def _mat(np, q):
    w, x, y, z = q / np.linalg.norm(q)
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                     [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                     [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])


def slerp(np, q0, q1, t):
    d = float(q0 @ q1)
    if d < 0:
        q1, d = -q1, -d
    if d > 0.9995:
        q = q0 + t * (q1 - q0)
        return q / np.linalg.norm(q)
    a = math.acos(min(1.0, d))
    return (math.sin((1 - t) * a) * q0 + math.sin(t * a) * q1) / math.sin(a)


def interp_cams(idx, cams, n):
    """Cameras (S, 3, 4) known at frames idx (rising) for every frame 0..n−1: rotation by slerp, position
    straight between; before the first and after the last, held."""
    _, np = tracking._libs()
    idx = [int(i) for i in idx]
    cams = np.asarray(cams, np.float64)
    qs = [_quat(np, c[:, :3]) for c in cams]
    out = np.zeros((n, 3, 4))
    j = 0
    for f in range(n):
        if f <= idx[0]:
            out[f] = cams[0]; continue
        if f >= idx[-1]:
            out[f] = cams[-1]; continue
        while idx[j + 1] < f:
            j += 1
        a, b = idx[j], idx[j + 1]
        t = (f - a) / (b - a)
        out[f, :, :3] = _mat(np, slerp(np, qs[j], qs[j + 1], t))
        out[f, :, 3] = cams[j][:, 3] * (1 - t) + cams[j + 1][:, 3] * t
    return out


def relative_to_first(cams):
    """Re-express camera-to-world 3x4s so the first is the identity (the world becomes camera 0's frame)."""
    _, np = tracking._libs()
    cams = np.asarray(cams, np.float64)
    R0, t0 = cams[0][:, :3], cams[0][:, 3]
    out = np.zeros_like(cams)
    for i, c in enumerate(cams):
        out[i, :, :3] = R0.T @ c[:, :3]
        out[i, :, 3] = R0.T @ (c[:, 3] - t0)
    return out


def grid_xyz(depth, K):
    """A depth grid {cols, rows, values} (of a picture K [fx, fy, cx, cy] belongs to, sized width x height
    in K's pixels) as {cols, rows, points} in that camera's frame."""
    cols, rows, w, h = depth["cols"], depth["rows"], depth["width"], depth["height"]
    fx, fy, cx, cy = K
    pts = []
    for i, z in enumerate(depth["values"]):
        if z is None:
            pts.append(None); continue
        r, c = divmod(i, cols)
        u, v = (c + 0.5) * w / cols - 0.5, (r + 0.5) * h / rows - 0.5
        pts.append([(u - cx) / fx * z, (v - cy) / fy * z, z])
    return {"cols": cols, "rows": rows, "points": pts}


# ---- ComfyUI ----
def _models(oi, node):
    """The model_name choices of a loader node in object_info."""
    opt = ((oi.get(node) or {}).get("input", {}).get("required", {}) or {}).get("model_name")
    if not opt:
        return []
    return opt[1].get("options", []) if opt[0] == "COMBO" else opt[0] if isinstance(opt[0], list) else []


async def _run(wf, node_id, what, progress, cancel):
    """Queue a workflow, wait for it, read the JSON node_id saved, and leave nothing in ComfyUI."""
    comfy = tracking.comfy
    pid = (await comfy.queue(wf, preview="off"))["prompt_id"]
    t0 = time.time()
    try:
        while True:
            if cancel and cancel():
                try:
                    await comfy.delete_queued([pid]); await comfy.interrupt()
                except Exception:
                    pass
                raise InterruptedError("Stopped")
            entry = (await comfy.history(pid)).get(pid)
            if entry:   # (ComfyUI's history only has a prompt once it has finished)
                break
            if progress:
                progress(min(0.95, (time.time() - t0) / 90))
            await asyncio.sleep(1.0)
        st = entry.get("status") or {}
        if st.get("status_str") == "error":
            msg = next((m[1].get("exception_message") for m in st.get("messages", [])
                        if isinstance(m, list) and len(m) == 2 and m[0] == "execution_error"), None)
            raise ValueError(f"{what} failed: {(msg or 'see ComfyUI').strip()}")
        files = entry.get("outputs", {}).get(node_id, {}).get("files") or []
        if not files:
            raise ValueError(f"{what} gave nothing back")
        try:
            data, _ = await comfy.view(files[0]["filename"], files[0].get("subfolder", ""), files[0].get("type", "output"))
        finally:
            storage.drop_comfy_read(files)   # (ComfyUI keeps nothing: storage.py)
        return json.loads(data)
    finally:
        try:
            await comfy.forget(pid)
        except Exception:
            pass


async def _ffmpeg(cmd, what):
    r = await asyncio.to_thread(subprocess.run, cmd, capture_output=True, timeout=600)
    if r.returncode:
        raise ValueError(f"Couldn't {what}: " + r.stderr.decode(errors="replace").strip()[-200:])
    return r.stdout


def _prefix(name):
    return f"{config.COMFY_INPUT_SUBFOLDER}/solve/{name}"


async def _pnp(path, start, W, H, T, V, kx, ky, oi, progress, cancel):
    cv2, np = tracking._libs()
    models = [m for m in _models(oi, "LoadMoGeModel") if "moge" in m.lower()]
    model = "moge_3_vitl_fp16.safetensors" if "moge_3_vitl_fp16.safetensors" in models else (models or [None])[0]
    if not model:
        raise ValueError("No MoGe model: put one from Comfy-Org/MoGe (Hugging Face) in ComfyUI/models/geometry_estimation")
    q0 = np.where(V[:, 0])[0]
    if len(q0) < MIN_VIS:
        raise ValueError("Too few points were tracked in the first frame to solve the camera")
    p0 = to_clip(np, T[q0, 0], kx, ky)
    png = await _ffmpeg(["ffmpeg", "-v", "error", "-ss", f"{start:.3f}", "-i", str(path), "-an", "-frames:v", "1",
                         "-vf", f"scale={W}:{H}", "-f", "image2pipe", "-vcodec", "png", "-"], "read the first frame")
    name = await tracking.comfy.upload_image(png, f"solve_{uuid.uuid4().hex[:12]}.png", config.COMFY_INPUT_SUBFOLDER)
    try:
        wf = {
            "1": {"class_type": "LoadImage", "inputs": {"image": name}},
            "2": {"class_type": "LoadMoGeModel", "inputs": {"model_name": model}},
            "3": {"class_type": "MoGeInference", "inputs": {"moge_model": ["2", 0], "image": ["1", 0], "resolution_level": 9,
                  "fov_x_degrees": 0.0, "batch_size": 1, "force_projection": True, "apply_mask": True, "refine_steps": 3}},
            "4": {"class_type": MOGE_NODE, "inputs": {"moge_geometry": ["3", 0], "points": json.dumps([[round(float(x), 2), round(float(y), 2)] for x, y in p0]),
                  "grid": MOGE_GRID, "filename_prefix": _prefix("moge")}},
        }
        ex = await _run(wf, "4", "MoGe", progress, cancel)
    finally:
        storage.remove([p] if (p := storage.comfy_input(name)) else [])   # (the frame goes once it's been read: CLAUDE.md)
    ids, X = lift(p0, ex)
    if len(ids) < MIN_VIS:
        raise ValueError("MoGe found depth for too few of the tracked points")
    ids = q0[ids]
    # MoGe ran on the clip-sized frame, so its K is in clip pixels
    K = [float(v) for v in ex["K"]]
    if ex.get("width") and ex["width"] != W:
        s = W / ex["width"]
        K = [K[0] * s, K[1] * H / ex["height"], (K[2] + 0.5) * s - 0.5, (K[3] + 0.5) * H / ex["height"] - 0.5]
    cams, q = await asyncio.to_thread(solve_pnp, T, V, X, ids, K, (kx, ky))
    return {"K": K, "cams": cams, "X": X, "ids": ids, "floor": floor_from_grid(ex["grid"]), "metric": True, "lost": q["lost"]}


def _da3_size(W, H):
    g = geom()
    h, w = g.da3_target_size(H, W, DA3_RES)
    return w, h


async def _da3(path, start, W, H, T, V, kx, ky, views, model, oi, progress, cancel):
    cv2, np = tracking._libs()
    g = geom()
    N = T.shape[1]
    idx = sorted({int(round(v)) for v in np.linspace(0, N - 1, min(views, N))})
    w, h = _da3_size(W, H)
    sel = "+".join(f"eq(n,{i})" for i in idx)
    clip = config.DATA_DIR / "tmp" / "track" / f"solve_{uuid.uuid4().hex[:12]}.mp4"
    clip.parent.mkdir(parents=True, exist_ok=True)
    try:
        await _ffmpeg(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-i", str(path), "-an", "-frames:v", str(len(idx)),
                       "-vf", f"select='{sel}',scale={w}:{h},setpts=N/24/TB", "-r", "24", "-c:v", "libx264", "-crf", "14",
                       "-pix_fmt", "yuv420p", str(clip)], "cut the views")
        wf = {
            "1": {"class_type": "VHS_LoadVideoPath", "inputs": {"video": str(clip), "force_rate": 0, "custom_width": 0,
                  "custom_height": 0, "frame_load_cap": 0, "skip_first_frames": 0, "select_every_nth": 1}},
            "2": {"class_type": "LoadDA3Model", "inputs": {"model_name": model, "weight_dtype": "default"}},
            "3": {"class_type": "DA3Inference", "inputs": {"da3_model": ["2", 0], "image": ["1", 0], "resolution": DA3_RES,
                  "resize_method": "upper_bound_resize", "mode": "multiview", "mode.ref_view_strategy": "first",
                  "mode.pose_method": "cam_dec"}},
            "4": {"class_type": DA3_NODE, "inputs": {"da3_geometry": ["3", 0], "grid": DA3_GRID, "resolution": DA3_RES,
                  "filename_prefix": _prefix("da3")}},
        }
        ex = await _run(wf, "4", "Depth Anything 3", progress, cancel)
    finally:
        clip.unlink(missing_ok=True)
    S = int(ex["views"])
    if S != len(idx):
        raise ValueError(f"Depth Anything 3 saw {S} views, not the {len(idx)} it was given")
    cams = interp_cams(idx, relative_to_first(np.array(ex["cams"], np.float64).reshape(S, 3, 4)), N)
    # one lens for the clip (no zoom): the views' median, from the views' pixels to the clip's
    wi, hi = ex["width"], ex["height"]
    Ki = np.median(np.array(ex["K"], np.float64), axis=0)
    sx, sy = W / wi, H / hi
    K = [float(Ki[0] * sx), float(Ki[1] * sy), float((Ki[2] + 0.5) * sx - 0.5), float((Ki[3] + 0.5) * sy - 0.5)]
    dg = {**ex["depth"], "width": wi, "height": hi}
    cols, rows = dg["cols"], dg["rows"]
    D = np.array([np.nan if v is None else v for v in dg["values"]], np.float64).reshape(rows, cols)
    ok = np.isfinite(D)
    q0 = np.where(V[:, 0])[0]
    uv = to_clip(np, T[q0, 0], kx, ky)
    ids, X = [], []
    for q, (u, v) in zip(q0, uv):
        z = g.bilinear(D, ok, (u + 0.5) * cols / W - 0.5, (v + 0.5) * rows / H - 0.5)
        if z is None or not z > 0:
            continue
        z = float(z)
        ids.append(q); X.append([(u - K[2]) / K[0] * z, (v - K[3]) / K[1] * z, z])
    if len(ids) < MIN_VIS:
        raise ValueError("Depth Anything 3 found depth for too few of the tracked points")
    floor = floor_from_grid(grid_xyz(dg, [float(v) for v in Ki]))
    return {"K": K, "cams": cams, "X": np.array(X), "ids": np.array(ids, np.int64), "floor": floor, "metric": False, "lost": 0}


async def solve(path, start=0.0, end=None, region=None, exclude=None, method="pnp", tracker="klt", views=32,
                model="depth_anything_3_small.safetensors", progress=None, cancel=None):
    """Solve the camera of a clip span. Returns the contract's solve dict (JSON-ready, rounded)."""
    t_start = time.time()
    cv2, np = tracking._libs()
    if method not in METHODS:
        raise ValueError(f"Unknown solve method {method!r}")
    if tracker not in TRACKERS:
        raise ValueError(f"Unknown tracker {tracker!r}")
    if not tracking.comfy:
        raise ValueError("ComfyUI isn't connected")

    def part(a, b):
        return (lambda p: progress(a + (b - a) * p)) if progress else None

    oi = await tracking.comfy.object_info()
    if method == "pnp":
        if MOGE_NODE not in oi or "MoGeInference" not in oi:
            raise ValueError("The camera solve needs ComfyUI's MoGe nodes (update ComfyUI) and ComfyChair's export node: link comfy_nodes/deck_solve into ComfyUI's custom_nodes and restart ComfyUI")
    else:
        if DA3_NODE not in oi or "DA3Inference" not in oi:
            raise ValueError("The camera solve needs ComfyUI's Depth Anything 3 nodes (update ComfyUI) and ComfyChair's export node: link comfy_nodes/deck_solve into ComfyUI's custom_nodes and restart ComfyUI")
        if "VHS_LoadVideoPath" not in oi:
            raise ValueError("The camera solve needs VideoHelperSuite in ComfyUI")
        if model not in _models(oi, "LoadDA3Model"):
            raise ValueError(f"{model} isn't in ComfyUI's models/geometry_estimation")

    kw = dict(path=path, start=start, end=end, region=region, exclude=exclude, cancel=cancel, full=True)
    if tracker == "tapnext":
        tr = await tracking.analyse_tapnext(progress=part(0, 0.45), **kw)
    else:
        tr = await asyncio.to_thread(tracking.analyse, progress=part(0, 0.45), **kw)
    full = tr["_full"]
    T, V = np.asarray(full["T"], np.float64), np.asarray(full["V"], bool)
    W, H = tr["size"]
    kx, ky = W / full["tw"], H / full["th"]
    N = T.shape[1]
    start = float(tr.get("start", start or 0))
    if cancel and cancel():
        raise InterruptedError("Stopped")

    if method == "pnp":
        s = await _pnp(path, start, W, H, T, V, kx, ky, oi, part(0.45, 0.9), cancel)
    else:
        s = await _da3(path, start, W, H, T, V, kx, ky, max(8, min(64, int(views))), model, oi, part(0.45, 0.9), cancel)
    if progress:
        progress(0.95)
    err = await asyncio.to_thread(reproj_err, s["cams"], s["X"], s["ids"], T, V, s["K"], (kx, ky))
    X = s["X"]
    pick = np.unique(np.linspace(0, len(X) - 1, min(len(X), MAX_PTS)).round().astype(int)) if len(X) else []
    fl = s["floor"]
    out = {"v": 1, "method": method, "fps": tr["fps"], "n": N, "size": [W, H], "start": tr["start"],
           "K": [round(float(v), 3) for v in s["K"]],
           "cams": [[round(float(v), 5) for v in c.ravel()] for c in s["cams"]],
           "pts": [[round(float(v), 4) for v in X[i]] for i in pick],
           "floor": {"n": [round(v, 5) for v in fl["n"]], "d": round(fl["d"], 5)} if fl else None,
           "metric": s["metric"],
           "quality": {"used": int(len(s["ids"])), "err": None if err is None else round(err, 3), "lost": int(s["lost"])},
           "cost": round(time.time() - t_start, 2)}
    if progress:
        progress(1.0)
    return out
