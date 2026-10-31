"""The arithmetic behind the Deck solve nodes, on plain numpy arrays (no ComfyUI, no torch): sampling a
point map or depth map where tracked points sit, a sparse grid of it for floor fitting, intrinsics in
pixels, and turning a world-to-camera [R|t] round. tests/test_solve.py loads this file on its own.

Pixel coordinates are OpenCV's: the centre of the top-left pixel is (0, 0). MoGe's intrinsics are
normalised (0..1 across the picture, pixel centres at (i + 0.5) / W), DA3's are in the pixels of the
picture the model ran on (its input resized to multiples of 14), principal point at W / 2.
"""
import math

import numpy as np

VERSION = 1


def bilinear(img: np.ndarray, ok: np.ndarray | None, x: float, y: float):
    """img (H, W[, C]) at pixel position (x, y), blended from the four pixels around it. None outside the
    picture or when one of the four is masked or not finite. Where the four disagree a lot (an edge
    between near and far: the last channel, or the value, differs by more than 5 %), the nearest one."""
    H, W = img.shape[:2]
    if not (math.isfinite(x) and math.isfinite(y)) or x < -0.5 or y < -0.5 or x > W - 0.5 or y > H - 0.5:
        return None
    x = min(max(x, 0.0), W - 1.0)
    y = min(max(y, 0.0), H - 1.0)
    x0, y0 = min(int(x), W - 2) if W > 1 else 0, min(int(y), H - 2) if H > 1 else 0
    x1, y1 = min(x0 + 1, W - 1), min(y0 + 1, H - 1)
    fx, fy = x - x0, y - y0
    quad = [(y0, x0), (y0, x1), (y1, x0), (y1, x1)]
    vals = [np.asarray(img[j, i], np.float64) for j, i in quad]
    if any(not np.all(np.isfinite(v)) for v in vals) or (ok is not None and not all(ok[j, i] for j, i in quad)):
        return None
    z = [float(np.ravel(v)[-1]) for v in vals]
    if min(abs(v) for v in z) > 0 and max(abs(v) for v in z) / min(abs(v) for v in z) > 1.05:
        j, i = round(y), round(x)
        return np.asarray(img[j, i], np.float64)
    return (vals[0] * (1 - fx) * (1 - fy) + vals[1] * fx * (1 - fy) + vals[2] * (1 - fx) * fy + vals[3] * fx * fy)


def grid_size(cols: int, W: int, H: int) -> tuple[int, int]:
    cols = max(2, int(cols))
    return cols, max(2, round(cols * H / W))


def grid_sample(img: np.ndarray, ok: np.ndarray | None, cols: int):
    """A regular cols x rows sub-sample (cell centres, rows top to bottom), None where there's nothing."""
    H, W = img.shape[:2]
    cols, rows = grid_size(cols, W, H)
    out = []
    for r in range(rows):
        for c in range(cols):
            v = bilinear(img, ok, (c + 0.5) * W / cols - 0.5, (r + 0.5) * H / rows - 0.5)
            out.append(v)
    return cols, rows, out


def moge_K(intr: np.ndarray, W: int, H: int) -> list[float]:
    """MoGe's normalised 3x3 intrinsics as [fx, fy, cx, cy] in OpenCV pixels of a W x H picture."""
    return [float(intr[0, 0] * W), float(intr[1, 1] * H), float(intr[0, 2] * W - 0.5), float(intr[1, 2] * H - 0.5)]


def da3_target_size(H: int, W: int, resolution: int) -> tuple[int, int]:
    """The (h, w) DA3 runs a H x W picture at (comfy/ldm/depth_anything_3/preprocess.py, upper_bound_resize)."""
    def r14(x):
        down = (x // 14) * 14
        up = down + 14
        return up if abs(up - x) <= abs(x - down) else down
    s = resolution / float(max(H, W))
    return max(1, r14(int(round(H * s)))), max(1, r14(int(round(W * s))))


def da3_K(intr: np.ndarray, H: int, W: int, resolution: int) -> list[float]:
    """DA3's pixel intrinsics (of the resized picture it ran on) as [fx, fy, cx, cy] in OpenCV pixels of the
    H x W picture it was given."""
    h, w = da3_target_size(H, W, resolution)
    sx, sy = W / w, H / h
    return [float(intr[0, 0] * sx), float(intr[1, 1] * sy), float(intr[0, 2] * sx - 0.5), float(intr[1, 2] * sy - 0.5)]


def invert34(M: np.ndarray) -> np.ndarray:
    """[R|t] (3x4, or 4x4) to its inverse [Rᵀ | −Rᵀt] (3x4): world-to-camera ⇄ camera-to-world."""
    M = np.asarray(M, np.float64)
    R, t = M[:3, :3], M[:3, 3]
    return np.concatenate([R.T, (-R.T @ t)[:, None]], axis=1)


def _r(v, nd=5):
    return None if v is None else [round(float(a), nd) for a in np.ravel(v)]


def moge_export(points: np.ndarray, mask: np.ndarray | None, intr: np.ndarray, queries, grid: int) -> dict:
    """One picture's MoGe geometry for ComfyChair's camera solve: the 3D position of each query pixel
    (None where there is none), the intrinsics in pixels and a sparse grid of the point map.
    points (H, W, 3) metric, OpenCV camera axes (x right, y down, z forward); mask (H, W) bool."""
    H, W = points.shape[:2]
    ok = np.isfinite(points).all(axis=-1) & (points[..., 2] > 0)
    if mask is not None:
        ok &= mask.astype(bool)
    pts = []
    for q in queries:
        x, y = (float(q["x"]), float(q["y"])) if isinstance(q, dict) else (float(q[0]), float(q[1]))
        pts.append(_r(bilinear(points, ok, x, y)))
    cols, rows, g = grid_sample(points, ok, grid)
    return {"version": VERSION, "width": W, "height": H, "K": [round(v, 4) for v in moge_K(intr, W, H)],
            "points": pts, "grid": {"cols": cols, "rows": rows, "points": [_r(v) for v in g]}}


def normalise(conf: np.ndarray) -> np.ndarray:
    lo, hi = float(np.nanmin(conf)), float(np.nanmax(conf))
    return (conf - lo) / (hi - lo) if hi > lo else np.ones_like(conf)


def da3_export(depth: np.ndarray, extr: np.ndarray, intr: np.ndarray, grid: int, resolution: int,
               sky: np.ndarray | None = None, conf: np.ndarray | None = None, min_conf: float = 0.1) -> dict:
    """Multi-view DA3 geometry for ComfyChair's camera solve. depth (S, H, W) z-depth; extr (S, 3|4, 4)
    world-to-camera; intr (S, 3, 3) in the pixels the model ran at. Writes camera-to-world 3x4 per view,
    [fx, fy, cx, cy] per view in this picture's pixels and view 0's depth as a grid (None for sky and for
    the least confident pixels)."""
    S, H, W = depth.shape
    if not np.isfinite(extr).all():
        raise ValueError("Depth Anything 3 couldn't place the cameras (non-finite poses): try more or fewer views")
    if np.all(np.abs(intr[:, 0, 0] - 1) < 1e-6):   # (DA3Inference's identity stand-ins: the model gave no cameras)
        raise ValueError("Depth Anything 3 gave no cameras: use a Small or Base model in multiview mode")
    ok = np.isfinite(depth[0]) & (depth[0] > 0)
    if sky is not None:
        ok &= sky[0] < 0.5
    cn = None
    if conf is not None:
        cn = normalise(conf[0].astype(np.float64))
        ok &= cn >= min_conf
    cols, rows, g = grid_sample(depth[0], ok, grid)
    out = {"version": VERSION, "views": S, "width": W, "height": H, "resolution": resolution,
           "K": [[round(v, 4) for v in da3_K(intr[i], H, W, resolution)] for i in range(S)],
           "cams": [_r(invert34(extr[i]), 6) for i in range(S)],
           "depth": {"cols": cols, "rows": rows, "values": [None if v is None else round(float(v), 5) for v in g]}}
    if cn is not None:
        _, _, c = grid_sample(cn, None, grid)
        out["confidence"] = [None if v is None else round(float(v), 3) for v in c]
    return out
