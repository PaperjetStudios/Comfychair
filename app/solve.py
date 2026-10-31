"""3D camera solve: where the camera was, in 3D, for every frame of a clip, plus a few scene points and the
floor, for the 3D tab (web/track-math.js sceneFromSolve). The 2D point tracks come from tracking.py (KLT or
TAPNext++); the depth comes from ComfyUI's core geometry nodes, read back through comfy_nodes/deck_solve.

method "pnp": MoGe gives the first frame's 3D points (metres) and lens; every later frame's camera is the
pose that puts those points where the tracks saw them (OpenCV PnP with RANSAC, then Levenberg-Marquardt).
Tracks rarely last a clip, so tracks that start later get 3D too: from a few later MoGe anchor frames (picked
where the tracks with 3D thin out, all run at once, fitted to the solve by a similarity on shared points or
placed by their frame's camera), triangulated from two solved frames once the camera has moved enough, put
on the latest anchor's depth, or, last, given their 3D neighbours' depth. Tracks the
cameras don't agree with (water, a person) are dropped and the frames solved again; then every camera and point
is refined together (bundle_adjust: reprojection under a Huber loss, the scale held by weak priors towards each
anchor's depth, a weak motion prior), and the positions are lightly smoothed. Each frame's PnP is already pulled
towards the steady move of the frames before (far points barely pin a position). method "da3": Depth Anything 3 places the cameras of a few dozen evenly spaced frames together
(multi-view) and gives each view's depth (no real scale); each track takes its position from the first view
it's seen on, and every frame is then solved as above, DA3's interpolated camera standing in where a frame
can't be solved. Both also give "cloud": the first frame's depth as coloured points.

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
MOGE_GRID = 96       # (also the depth later tracks are put on: _onto_anchor)
SMOOTH_S = 0.04      # the Gaussian over the solved positions, in seconds
MAX_PTS = 400
MAX_CLOUD = 3600     # (about 130 KB of JSON)
MIN_VIS = 6
THR_K = 2.5          # RANSAC tolerance in analysis pixels (TRACK_W wide), at least 3 clip pixels
TRI_GAP = 6          # a later track is triangulated once seen this many frames on...
TRI_ANGLE = 2.0      # ...and once its two rays part by this many degrees
NEAR_N = 4           # a track nothing else places takes the depth of this many 3D neighbours...
NEAR_R = 0.15        # ...within this share of the picture's longer side, if they agree within 30 %
FLOOR_MIN = 50
ANCHOR_COVER = 0.4   # a new MoGe anchor where under this share of the tracks seen have one...
ANCHOR_EVERY = 3.0   # ...or this many seconds after the last, at the most
ANCHOR_GAP = 0.25    # ...but not closer than this many seconds
MAX_ANCHORS = 4      # (each is a MoGe pass of a few seconds)
ALIGN_MIN = 12       # shared points a later anchor needs to be fitted by a similarity (else by its frame's pose)...
ALIGN_SHARE = 0.5    # ...and over this share of them must agree with the fit, or the anchor is left out
GAP_MIN = 8          # a frame with fewer points with 3D than this is in a gap (the tracks ended: a whip, blur)...
GAP_LOOK = 12        # ...and, for the anchor picker, one where fewer than GAP_MIN of the tracks seen this many frames
GAP_SEE = 30         # earlier still are; it ends where this many tracks are seen again (a MoGe anchor there)
BRIDGE_STEPS = 12    # across a gap the camera turns as the 2D track says and moves on at the median of this many
BRIDGE_FADE = 24     # last steps, slowing to a stop over this many frames
WHIP = 0.04          # a frame whose picture slides by over this share of its width is bridged too (a whip: blur and
                     # the rolling shutter bend it, and PnP reads that as the camera moving metres)
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


def _pnp_pass(cv2, np, T, V, Xw, have, skip, Km, kx, ky, thr, prior, grow, anchor=None, anchors=(), motion_w=0.0,
              mats=None):
    """One run through the frames (see solve_pnp). Xw (Q, 3) / have (Q,) are updated with the points the later
    anchors, triangulation, the anchor's depth and the neighbours give. motion_w: each frame's pose is pulled
    towards where the last two put it (bundle_adjust's motion prior, only backwards), so far-off points that
    hardly pin the position don't make it jump (and the points lifted from it go wrong). A frame in a gap (under
    GAP_MIN points with 3D) is bridged (bridge(); mats: the 2D similarity track, _sim_mats, made when first
    needed) unless prior gives its camera; a later anchor there is placed by the bridged pose.
    Returns (cams, good, lost, bridged (N,) mask)."""
    Q, N = T.shape[:2]
    UV = to_clip(np, T, kx, ky)   # (Q, N, 2) clip px
    Kinv = np.linalg.inv(Km)
    cams = np.zeros((N, 3, 4))
    cams[0, :, :3] = np.eye(3)
    good = np.zeros(N, bool)
    good[0] = True
    w2c = [None] * N   # (R, t) world-to-camera of each solved frame
    w2c[0] = (np.eye(3), np.zeros(3))
    first = np.full(Q, -1)   # the first solved frame each track was seen on
    first[V[:, 0]] = 0
    rvec, tvec = np.zeros((3, 1)), np.zeros((3, 1))
    fresh, lost = True, 0
    later = {int(a["f"]): a for a in anchors if a["f"] > 0}
    solved = [0]   # the solved frames, in order
    bridged = np.zeros(N, bool)
    simm = [mats]   # (the 2D similarity track, made when first needed)

    whip = np.zeros(N, bool)
    if prior is None and mats is not None:
        p = np.array([(Km[0, 2] + 0.5) / kx - 0.5, (Km[1, 2] + 0.5) / ky - 0.5, 1.0])
        for f in range(1, N):
            q = mats[f] @ np.linalg.solve(mats[f - 1], p)
            whip[f] = np.hypot(*(q[:2] - p[:2])) > WHIP * 2 * (p[0] + 0.5)

    def in_gap(f):
        return prior is None and (whip[f] or (V[:, f] & have & ~skip).sum() < GAP_MIN)

    def bridged_pose(f):
        if simm[0] is None:
            simm[0] = _sim_mats(cv2, np, T, V)
        a = solved[-1]   # (the depth the last solved frame saw, for the slide its move gives)
        m = V[:, a] & have & ~skip
        z = (Xw[m] - cams[a][:, 3]) @ cams[a][:, 2] if m.any() else np.zeros(0)
        seen = all((V[:, g - 1] & V[:, g]).sum() >= 6 for g in range(a + 1, f + 1))   # (else the 2D track held still)
        zm = float(np.median(z[z > 0])) if (z > 0).any() and seen else None
        return bridge(np, cams, solved, f, simm[0], Km, kx, ky, zm)

    def try_pnp(f, fresh, rvec, tvec):
        use = V[:, f] & have & ~skip
        if use.sum() < MIN_VIS:
            return None
        obj = np.ascontiguousarray(Xw[use])
        img = np.ascontiguousarray(UV[use, f])
        try:
            if fresh:
                ok, r, t, inl = cv2.solvePnPRansac(obj, img, Km, None, flags=cv2.SOLVEPNP_SQPNP,
                                                   reprojectionError=thr, iterationsCount=300, confidence=0.999)
            else:
                ok, r, t, inl = cv2.solvePnPRansac(obj, img, Km, None, rvec=rvec.copy(), tvec=tvec.copy(), useExtrinsicGuess=True,
                                                   flags=cv2.SOLVEPNP_ITERATIVE, reprojectionError=thr, iterationsCount=300, confidence=0.999)
        except cv2.error:
            return None
        if not ok or inl is None or len(inl) < MIN_VIS:
            return None
        inl = inl.ravel()
        r, t = cv2.solvePnPRefineLM(obj[inl], img[inl], Km, None, r, t)
        if motion_w > 0 and len(solved) > 1 and np.isfinite(r).all() and np.isfinite(t).all():
            r, t = steady(f, obj[inl], img[inl], r, t)
        return (r, t) if np.isfinite(r).all() and np.isfinite(t).all() else None

    def steady(f, obj, img, r, t):
        """The pose refined with the motion prior: reprojection (clip px) plus motion_w px per unit of the centre's
        miss from the constant-speed guess over the points' median depth (spread over the frames since)."""
        from scipy.optimize import least_squares
        Rp, tp = predicted(f)
        Cp = -Rp.T @ tp
        R = cv2.Rodrigues(r)[0]
        z = (obj @ R.T + t.reshape(3))[:, 2]
        w = motion_w / max(float(np.median(z[z > 0])) if (z > 0).any() else 1.0, 1e-9) / (f - solved[-1])

        def res(p):
            Rr = cv2.Rodrigues(p[:3])[0]
            Xc = (obj - p[3:]) @ Rr.T
            zc = np.maximum(Xc[:, 2], 1e-9)
            e = np.c_[Km[0, 0] * Xc[:, 0] / zc + Km[0, 2], Km[1, 1] * Xc[:, 1] / zc + Km[1, 2]] - img
            return np.concatenate([e.ravel(), w * (p[3:] - Cp)])

        p = least_squares(res, np.r_[r.ravel(), -R.T @ t.reshape(3)], method="lm", max_nfev=100).x
        Rr = cv2.Rodrigues(p[:3])[0]
        return p[:3].reshape(3, 1), (-Rr @ p[3:]).reshape(3, 1)

    def predicted(f):
        """World-to-camera for frame f from the last solved frames, moving on at their speed."""
        a = solved[-1]
        R, C = cams[a][:, :3], cams[a][:, 3]
        if len(solved) > 1:
            b = solved[-2]
            C = C + (cams[a][:, 3] - cams[b][:, 3]) * (f - a) / (a - b)
        return R.T, -R.T @ C

    for f in range(1, N):
        got = None if whip[f] else try_pnp(f, fresh, rvec, tvec)
        if f in later:   # a later MoGe anchor: its points into the solve's frame, placed by this frame's camera (solved,
            # or foreseen from the last ones) unless enough are shared for a similarity; and its depth for the ray march
            pose = (cv2.Rodrigues(got[0])[0], got[1].reshape(3)) if got else bridged_pose(f) if in_gap(f) else predicted(f)
            sim = _place_anchor(np, later[f], Xw, have, skip, pose)
            if sim is not None and later[f].get("grid") is not None:
                anchor = {**later[f]["grid"], "sim": sim}
            if sim is not None:
                got = try_pnp(f, fresh, rvec, tvec) or got
        if got is not None:
            rvec, tvec = got
            fresh = False
            cams[f] = _c2w(cv2, np, rvec, tvec)
            good[f] = True
            w2c[f] = (cv2.Rodrigues(rvec)[0], tvec.reshape(3))
            solved.append(f)
        else:
            lost += 1
            fresh = True
            if in_gap(f):   # (the tracks have ended: turn as the picture does, and keep moving)
                R, t = bridged_pose(f)
                cams[f] = np.concatenate([R.T, (-R.T @ t)[:, None]], axis=1)
                bridged[f] = True
            else:
                cams[f] = cams[f - 1] if prior is None else prior[f]   # (DA3's own camera stands in)
            continue
        newly = V[:, f] & (first < 0)
        first[newly] = f
        if not grow:
            continue
        # tracks with no 3D yet, seen on an earlier solved frame a and now: triangulate once the rays part by
        # TRI_ANGLE (a hand-held camera walks; points that appear after frame 0 keep the solve going)
        cand = np.where(V[:, f] & ~have & ~skip & (first >= 0) & (f - first >= TRI_GAP))[0]
        if not len(cand):
            continue
        Rf, tf = w2c[f]
        for a in np.unique(first[cand]):
            qs = cand[first[cand] == a]
            Ra, ta = w2c[a]
            Pa, Pf = Km @ np.hstack([Ra, ta[:, None]]), Km @ np.hstack([Rf, tf[:, None]])
            Xh = cv2.triangulatePoints(Pa, Pf, UV[qs, a].T.astype(np.float64), UV[qs, f].T.astype(np.float64))
            Xt = (Xh[:3] / Xh[3]).T
            ca, cf = Xt @ Ra.T + ta, Xt @ Rf.T + tf
            da = (np.c_[UV[qs, a], np.ones(len(qs))] @ Kinv.T) @ Ra   # rays in world axes
            df = (np.c_[UV[qs, f], np.ones(len(qs))] @ Kinv.T) @ Rf
            cosang = np.sum(da * df, 1) / np.linalg.norm(da, axis=1) / np.linalg.norm(df, axis=1)
            ea = np.hypot(*(ca[:, :2] / ca[:, 2:3] @ Km[:2, :2].T + Km[:2, 2] - UV[qs, a]).T)
            ef = np.hypot(*(cf[:, :2] / cf[:, 2:3] @ Km[:2, :2].T + Km[:2, 2] - UV[qs, f]).T)
            keep = (ca[:, 2] > 0) & (cf[:, 2] > 0) & (cosang < math.cos(math.radians(TRI_ANGLE))) & (ea < thr) & (ef < thr)
            Xw[qs[keep]] = Xt[keep]
            have[qs[keep]] = True
        # the ones that still don't part (a camera on a tripod, or turning on the spot): onto the latest anchor's depth
        if anchor is not None:
            rest = cand[~have[cand]]
            if len(rest):
                Xa = _onto_anchor(np, anchor, Rf, tf, UV[rest, f], Kinv)
                ok = np.isfinite(Xa).all(axis=1)
                Xw[rest[ok]] = Xa[ok]
                have[rest[ok]] = True
        # and the rest (frame 0's view left behind by a pan): at the depth of their 3D neighbours in this frame
        rest = cand[~have[cand]]
        known = np.where(V[:, f] & have & ~skip)[0]
        if len(rest) and len(known) >= NEAR_N:
            zk = (Xw[known] @ Rf.T + tf)[:, 2]
            d = np.linalg.norm(UV[rest, f][:, None, :] - UV[known, f][None, :, :], axis=2)   # (rest, known) px
            near = np.argsort(d, axis=1)[:, :NEAR_N]
            dn, zn = np.take_along_axis(d, near, 1), zk[near]
            ok = (dn[:, -1] < NEAR_R * max(Km[0, 2], Km[1, 2]) * 2) & (zn.min(1) > 0) & (zn.max(1) < 1.3 * zn.min(1))
            if ok.any():
                w = 1 / (dn[ok] + 1.0)
                z = (zn[ok] * w).sum(1) / w.sum(1)
                Xc = (np.c_[UV[rest[ok], f], np.ones(ok.sum())] @ Kinv.T) * z[:, None]
                Xw[rest[ok]] = (Xc - tf) @ Rf
                have[rest[ok]] = True
    return cams, good, lost, bridged


def _sim_mats(cv2, np, T, V):
    """The 2D similarity track (tracking._fit) as 3x3 matrices (N, 3, 3) taking frame 0's analysis pixels to
    each frame's."""
    frames, _ = tracking._fit(cv2, np, np.asarray(T, np.float32), V, 1.0, 0, 0)   # (centre 0: tx, ty the shift itself)
    out = np.zeros((len(frames), 3, 3))
    for i, fr in enumerate(frames):
        a, s = math.radians(fr["rot"]), fr["scale"]
        out[i] = [[s * math.cos(a), -s * math.sin(a), fr["tx"]], [s * math.sin(a), s * math.cos(a), fr["ty"]], [0, 0, 1]]
    return out


def bridge(np, cams, solved, f, mats, Km, kx, ky, zmed=None):
    """World-to-camera (R, t) for frame f in a gap, from the last solved frame a = solved[-1]: moved on at the
    median of the last BRIDGE_STEPS solved steps, slowing linearly to a stop over BRIDGE_FADE frames, and turned
    by the 2D similarity between a and f (mats, _sim_mats): the principal point's shift through the focal length
    is yaw and pitch (less the shift that move gives points zmed away), the picture's turn is roll; zoom is left
    out."""
    a = solved[-1]
    last = solved[-(BRIDGE_STEPS + 1):]
    v = np.zeros(3)
    if len(last) > 1:
        v = np.median([(cams[b][:, 3] - cams[c][:, 3]) / (b - c) for c, b in zip(last[:-1], last[1:])], axis=0)
        # (no faster than twice the solve's usual pace: the frames before a gap are often already going wrong)
        S = np.asarray(solved)
        pace = np.median(np.linalg.norm(np.diff(cams[S][:, :, 3], axis=0), axis=1) / np.diff(S)[:, None].ravel())
        if np.linalg.norm(v) > 2 * pace:
            v *= 2 * pace / np.linalg.norm(v)
    k = np.arange(1, f - a + 1)
    C = cams[a][:, 3] + v * np.clip(1 - k / BRIDGE_FADE, 0, None).sum()
    Mr = mats[f] @ np.linalg.inv(mats[a])
    p = np.array([(Km[0, 2] + 0.5) / kx - 0.5, (Km[1, 2] + 0.5) / ky - 0.5, 1.0])   # principal point, analysis px
    q = Mr @ p
    dx, dy = (q[0] - p[0]) * kx, (q[1] - p[1]) * ky
    if zmed:   # (a sideways move slides the picture too: that part isn't a turn)
        d = (C - cams[a][:, 3]) @ cams[a][:, :3]
        dx, dy = dx + Km[0, 0] * d[0] / zmed, dy + Km[1, 1] * d[1] / zmed
    yaw, pitch, roll = math.atan(dx / Km[0, 0]), -math.atan(dy / Km[1, 1]), math.atan2(Mr[1, 0], Mr[0, 0])
    cy_, sy_, cp, sp, cr, sr = math.cos(yaw), math.sin(yaw), math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    Ry = np.array([[cy_, 0, sy_], [0, 1, 0], [-sy_, 0, cy_]])
    Rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    Rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    R = Rx @ Ry @ Rz @ cams[a][:, :3].T
    return R, -R @ C


def choose_anchors(V, fps, cover=ANCHOR_COVER, every=ANCHOR_EVERY, gap=ANCHOR_GAP, most=MAX_ANCHORS):
    """The frames MoGe should give depth for, from the tracks' visibility alone (V (Q, N)): frame 0, then a frame
    wherever under `cover` of the tracks seen there were seen on an anchor already, or `every` seconds after
    the last one; never closer than `gap` seconds. With more than `most`, the ones nearest to `most` even
    steps through the clip (so a clip whose tracks churn early still has anchors at its end). Then, outside that
    count, the end of every visibility gap (gap_ends) without an anchor within GAP_LOOK frames: nothing is
    shared across a gap, so the solve starts again there from MoGe's depth."""
    import numpy as np
    V = np.asarray(V, bool)
    N = V.shape[1]
    covered = V[:, 0].copy()
    out = [0]
    for f in range(1, N):
        if f - out[-1] < gap * fps:
            continue
        seen = V[:, f]
        n = int(seen.sum())
        if n and ((seen & covered).sum() < cover * n or f - out[-1] >= every * fps):
            out.append(f)
            covered |= seen
    if len(out) > most:
        a = np.array(out)
        pick = [0]
        for target in np.linspace(0, N - 1, most)[1:]:
            cand = [x for x in a if x not in pick]
            pick.append(int(min(cand, key=lambda x: abs(x - target))))
        out = pick
    for e in gap_ends(V):
        if all(abs(e - x) > GAP_LOOK for x in out):
            out.append(e)
    return sorted(out)


def gap_ends(V, look=GAP_LOOK, few=GAP_MIN, see=GAP_SEE):
    """Where each visibility gap ends: a gap starts at a frame where fewer than `few` of the tracks seen `look`
    frames earlier are still seen (they all ended at once), and ends at the first frame from there on with `see`
    tracks seen. [frame...]."""
    import numpy as np
    V = np.asarray(V, bool)
    N = V.shape[1]
    out, f = [], look
    while f < N:
        if V[:, f - look].sum() >= few and (V[:, f] & V[:, f - look]).sum() < few:
            e = next((g for g in range(f, N) if V[:, g].sum() >= see), None)
            if e is None:
                break
            out.append(e)
            f = max(e, f) + look   # (one anchor per gap)
            continue
        f += 1
    return out


def similarity(A, B, iters=200, tol=None, seed=0):
    """The similarity B ≈ s·R·A + t (A, B (n, 3)) by RANSAC over Umeyama fits: (s, R, t, inliers) or None.
    tol: inlier distance, default 5 % of B's median distance from its centre."""
    import numpy as np
    A, B = np.asarray(A, np.float64), np.asarray(B, np.float64)
    n = len(A)
    if n < 3:
        return None

    def fit(a, b):
        ma, mb = a.mean(0), b.mean(0)
        a0, b0 = a - ma, b - mb
        U, S, Vt = np.linalg.svd(b0.T @ a0 / len(a))
        D = np.diag([1, 1, np.sign(np.linalg.det(U @ Vt)) or 1])
        R = U @ D @ Vt
        va = (a0 ** 2).sum() / len(a)
        if va <= 0:
            return None
        sc = float(np.trace(np.diag(S) @ D) / va)
        return sc, R, mb - sc * R @ ma

    if tol is None:
        tol = 0.05 * float(np.median(np.linalg.norm(B - B.mean(0), axis=1))) or 1e-6
    rng = np.random.default_rng(seed)
    best = None
    for _ in range(iters):
        pick = rng.choice(n, 3, replace=False)
        m = fit(A[pick], B[pick])
        if m is None or m[0] <= 0:
            continue
        inl = np.linalg.norm(m[0] * A @ m[1].T + m[2] - B, axis=1) < tol
        if best is None or inl.sum() > best.sum():
            best = inl
    if best is None or best.sum() < 3:
        return None
    m = fit(A[best], B[best])
    if m is None:
        return None
    inl = np.linalg.norm(m[0] * A @ m[1].T + m[2] - B, axis=1) < tol
    return (*fit(A[inl], B[inl]), inl) if inl.sum() >= 3 else (*m, best)


def _place_anchor(np, a, Xw, have, skip, pose):
    """Put a later anchor's points ({"q" tracks, "Xc" (n, 3) in its camera's frame, NaN for none}) into the
    world: fitted by a similarity on the tracks that already have a position (over ALIGN_SHARE of them must
    agree, else the anchor is left out), or with almost none of those, by its frame's camera (pose:
    world-to-camera (R, t)) at MoGe's scale.
    Tracks with no position yet take theirs. Returns (s, R, t), anchor camera to world, or None."""
    q, Xc = np.asarray(a["q"]), np.asarray(a["Xc"], np.float64)
    ok = np.isfinite(Xc).all(axis=1) & (Xc[:, 2] > 0) & ~skip[q]
    if ok.sum() < MIN_VIS:
        return None
    shared = ok & have[q]
    sim = None
    if shared.sum() >= ALIGN_MIN:
        m = similarity(Xc[shared], Xw[q[shared]])
        if m is not None and m[3].sum() >= max(ALIGN_MIN, ALIGN_SHARE * shared.sum()):
            sim = m[:3]
    if sim is None and shared.sum() < MIN_VIS:
        # (nothing to fit it to: the solve has lost its points here, so the anchor restarts it from this frame's
        # camera, at MoGe's scale)
        R, t = pose
        sim = (1.0, R.T, -R.T @ t)
    if sim is None:   # (shared points it disagrees with: the anchor's depth doesn't match the solve's; left out)
        return None
    sc, R, t = sim
    new = ok & ~have[q]   # (tracks that have a position keep it: replacing it would contradict the frames so far)
    Xw[q[new]] = sc * Xc[new] @ R.T + t
    have[q[new]] = True
    return sim


def _grid_z(np, Z, gx, gy):
    """Bilinear samples of a depth grid Z (rows, cols) at grid positions; NaN outside or next to a hole."""
    rows, cols = Z.shape
    x0 = np.clip(np.floor(gx).astype(int), 0, cols - 2)
    y0 = np.clip(np.floor(gy).astype(int), 0, rows - 2)
    fx, fy = gx - x0, gy - y0
    out = (Z[y0, x0] * (1 - fx) * (1 - fy) + Z[y0, x0 + 1] * fx * (1 - fy) + Z[y0 + 1, x0] * (1 - fx) * fy + Z[y0 + 1, x0 + 1] * fx * fy)
    inside = (gx >= -0.5) & (gx <= cols - 0.5) & (gy >= -0.5) & (gy <= rows - 0.5)
    return np.where(inside, out, np.nan)


def _onto_anchor(np, anchor, Rf, tf, uv, Kinv, steps=96):
    """3D points for pixels uv seen by a camera (world-to-camera Rf, tf): where each ray first goes behind an
    anchor frame's depth (anchor: {"Z" (rows, cols) z-depth grid, "K" [fx, fy, cx, cy] and "size" (w, h) of the
    picture it covers, "sim" (s, R, t): its camera's frame to the world, X = s·R·x + t; none for frame 0}).
    NaN rows where the ray never meets it inside that picture."""
    Z, (fx, fy, cx, cy), (w, h) = anchor["Z"], anchor["K"], anchor["size"]
    sa, Ra, ta = anchor.get("sim") or (1.0, np.eye(3), np.zeros(3))   # the anchor camera's frame to the world's
    rows, cols = Z.shape
    C = -Rf.T @ tf                                            # the camera's centre, in world axes
    d = (np.c_[uv, np.ones(len(uv))] @ Kinv.T) @ Rf          # rays in world axes (Rᵀ·ray, row by row)
    zmed = float(np.nanmedian(Z)) * sa
    s = np.geomspace(0.05 * zmed, 20 * zmed, steps)           # distances along the ray (z-units of the camera)
    P = C[None, None, :] + s[None, :, None] * d[:, None, :]  # (n, steps, 3) points in the world
    Pa = ((P - ta) @ Ra) / sa                                 # ...and in the anchor camera's frame
    with np.errstate(invalid="ignore", divide="ignore"):
        u = fx * Pa[..., 0] / Pa[..., 2] + cx
        v = fy * Pa[..., 1] / Pa[..., 2] + cy
        zs = _grid_z(np, Z, (u + 0.5) * cols / w - 0.5, (v + 0.5) * rows / h - 0.5)
        diff = Pa[..., 2] - zs                                # < 0: in front of the surface; > 0: behind it
    valid = np.isfinite(diff) & (Pa[..., 2] > 0)
    out = np.full((len(uv), 3), np.nan)
    for i in range(len(uv)):
        dd, ok = diff[i], valid[i]
        hit = np.where(ok[:-1] & ok[1:] & (dd[:-1] < 0) & (dd[1:] >= 0))[0]
        if not len(hit):
            continue
        j = hit[0]
        a = dd[j] / (dd[j] - dd[j + 1])
        out[i] = P[i, j] + a * (P[i, j + 1] - P[i, j])
    return out


def solve_pnp(T, V, X, ids, K, k_scale, prior=None, grow=True, thr=None, anchor=None, smooth=0.0, anchors=(), priors=(),
              ba=True):
    """Camera-to-world 3x4 for every frame from tracks T (Q, N, 2, analysis px) seen where V (Q, N), of which
    tracks ids have world positions X (M, 3). K [fx, fy, cx, cy] in clip pixels; k_scale: analysis to clip
    pixels (a number or (kx, ky)). Frame 0 is the identity. A frame with under 6 points seen, or no solve,
    keeps the previous pose (or prior's, cameras to start each frame from) and counts as lost; in a gap (under
    GAP_MIN points with 3D, no prior) it is bridged instead (bridge: the 2D track's turn, the last steady move),
    and the bundle adjustment leaves it there. Other lost frames the bundle adjustment places from what they see
    and the motion prior.
    Tracks that appear later are triangulated from two solved frames (grow), and tracks the cameras don't
    agree with (a wave, a person walking: over 2x the threshold on the median frame) are dropped and the
    frames solved again (kept only if that loses no more frames). With anchor (frame 0's depth grid, see
    _onto_anchor), tracks that never part enough to triangulate are put on frame 0's depth instead; anchors:
    later frames' MoGe points ({"f", "q", "Xc", "grid"}, see _place_anchor) join where they're reached. smooth: a
    Gaussian over the positions (frames, sigma), for the jitter a few far points leave.
    ba: then all cameras and points are refined together (bundle_adjust, before the smoothing), the scale held by
    the depth the points were given: frame 0's (X's z for the ids seen there), each later anchor's, and priors
    ([{"f", "q", "z"}], more of the same, e.g. DA3's other views); tracks still off by over 2x the threshold
    are then dropped and it runs once more.
    Returns (cams (N, 3, 4), {"used", "lost", "ids", "X", "ba_err"}): ids/X the points used; ba_err the median
    reprojection error after the bundle adjustment (None without it)."""
    cv2, np = tracking._libs()
    cv2.setRNGSeed(0)   # (RANSAC: the same clip solves the same way every time)
    kx, ky = (k_scale, k_scale) if isinstance(k_scale, (int, float)) else k_scale
    Km = np.array([[K[0], 0, K[2]], [0, K[1], K[3]], [0, 0, 1]], np.float64)
    if thr is None:
        thr = max(3.0, THR_K * max(kx, ky))   # (never finer than the tracks themselves: 8 px on a 4K phone clip)
    Q = T.shape[0]
    T, V = np.asarray(T, np.float64), np.asarray(V, bool)
    skip = np.zeros(Q, bool)
    best = None
    mats = _sim_mats(cv2, np, T, V) if prior is None else None   # (the 2D track: bridges and whips)
    for rnd in range(3):
        Xw, have = np.full((Q, 3), np.nan), np.zeros(Q, bool)
        Xw[ids], have[ids] = np.asarray(X, np.float64), True
        cams, good, lost, bridged = _pnp_pass(cv2, np, T, V, Xw, have, skip.copy(), Km, kx, ky, thr, prior, grow, anchor, anchors,
                                     motion_w=PNP_MOTION_W if ba else 0.0, mats=mats)
        if best is not None and lost > best[3]:   # (the dropped tracks were holding frames up: keep the last round)
            break
        best = (cams, Xw, have & ~skip, lost, good, bridged)
        err = track_err(cams, Xw, T, V & good[None, :], K, (kx, ky))
        bad = have & ~skip & (err > 2 * thr)
        if rnd == 2 or not bad.any():
            break
        skip |= bad
    cams, Xw, use, lost, good, bridged = best
    ba_err = None
    if ba and use.sum() >= MIN_VIS:
        ids = np.asarray(ids, np.int64)
        z0 = np.asarray(X, np.float64).reshape(-1, 3)[:, 2]
        seen0 = V[ids, 0]
        deps = [{"f": 0, "q": ids[seen0], "z": z0[seen0]}]
        deps += [{"f": int(a["f"]), "q": np.asarray(a["q"]), "z": np.asarray(a["Xc"], np.float64)[:, 2]} for a in anchors]
        deps += list(priors or ())
        Xb = np.where(use[:, None], Xw, np.nan)
        for rnd in range(2):
            cams, Xb, info = bundle_adjust(cams, Xb, T, V, K, (kx, ky), anchors=deps, huber=thr, hold=bridged)
            bad = use & (track_err(cams, Xb, T, V, K, (kx, ky)) > 2 * thr)   # (what still doesn't fit: once more without it)
            if rnd or not bad.any() or (use & ~bad).sum() < MIN_VIS:
                break
            use = use & ~bad
            Xb[bad] = np.nan
        Xw, ba_err = Xb, info["err"]
    if smooth > 0:
        cams = cams.copy()
        sm = _gauss(np, cams[:, :, 3], smooth)
        fade = np.exp(-0.5 * (np.arange(len(sm)) / (2 * smooth)) ** 2)[:, None]
        cams[:, :, 3] = sm - sm[:1] * fade   # (camera 0 stays the world's origin, without a step after it)
        # a frame's turn and position trade off against each other: with the position moved, turn it again to
        # fit its points (bearings, Kabsch), so the smoothing doesn't show up as points sliding
        UV = to_clip(np, T, kx, ky)
        Kinv = np.linalg.inv(Km)
        for f in np.where(good)[0][1:]:
            m = V[:, f] & use
            if m.sum() < MIN_VIS:
                continue
            R, t = cams[f][:, :3], cams[f][:, 3]
            d = Xw[m] - t
            Xc = d @ R
            pr = Xc[:, :2] / Xc[:, 2:3] @ Km[:2, :2].T + Km[:2, 2]
            inl = (Xc[:, 2] > 0) & (np.hypot(*(pr - UV[m, f]).T) < 2 * thr)
            if inl.sum() < MIN_VIS:
                continue
            b = np.c_[UV[m, f][inl], np.ones(inl.sum())] @ Kinv.T
            b /= np.linalg.norm(b, axis=1, keepdims=True)
            dw = d[inl] / np.linalg.norm(d[inl], axis=1, keepdims=True)
            U, _, Vt = np.linalg.svd(b.T @ dw)   # camera-from-world turn taking dw onto b
            Rw2c = U @ np.diag([1, 1, np.linalg.det(U @ Vt)]) @ Vt
            cams[f][:, :3] = Rw2c.T
    keep = np.where(use)[0]
    return cams, {"used": int(len(keep)), "lost": lost, "ids": keep, "X": Xw[keep], "ba_err": ba_err}


def _gauss(np, A, sigma):
    """A Gaussian over the rows of A (frames); the ends are mirrored through the end value, so a steady
    move keeps going rather than slowing into a hold."""
    r = min(max(1, int(3 * sigma)), len(A) - 1)
    if r < 1:
        return A
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    pad = np.concatenate([2 * A[:1] - A[r:0:-1], A, 2 * A[-1:] - A[-2:-r - 2:-1]])
    return np.stack([np.convolve(pad[:, j], k, mode="valid") for j in range(A.shape[1])], axis=1)


def track_err(cams, Xw, T, V, K, k_scale):
    """Each track's median reprojection error (clip px) over the frames it's seen on (inf without 3D or frames)."""
    _, np = tracking._libs()
    kx, ky = (k_scale, k_scale) if isinstance(k_scale, (int, float)) else k_scale
    R, t = cams[:, :, :3], cams[:, :, 3]   # (N, 3, 3), (N, 3)
    Xc = np.einsum("nji,qnj->qni", R, Xw[:, None, :] - t[None])   # Rᵀ(X − t) for every track and frame
    with np.errstate(invalid="ignore", divide="ignore"):
        u = K[0] * Xc[..., 0] / Xc[..., 2] + K[2]
        v = K[1] * Xc[..., 1] / Xc[..., 2] + K[3]
        UV = to_clip(np, T, kx, ky)
        e = np.hypot(u - UV[..., 0], v - UV[..., 1])
        e = np.where(V & (Xc[..., 2] > 0) & np.isfinite(e), e, np.nan)
        out = np.nanmedian(np.where(np.isnan(e).all(1, keepdims=True), np.inf, e), axis=1)
    return np.where(np.isfinite(out), out, np.inf)


# ---- bundle adjustment: all the cameras and points together, so the scale holds over the clip ----
BA_PRIOR_W = 50.0    # depth prior: clip px per unit of relative depth error (10 % off the anchor's depth costs 5 px)
BA_SMOOTH_W = 2000.0  # motion prior: clip px per unit of a camera centre's second difference over the scene depth
PNP_MOTION_W = 5000.0  # the same, per frame while solving (a 1 cm miss from the steady guess at 10 m costs 5 px)
BA_NFEV = 20         # least_squares evaluations (each a sparse Jacobian), over its two reweighting rounds


def _rodrigues(np, r):
    """Rotation matrices (n, 3, 3) for the Rodrigues vectors in the rows of r (vectorised cv2.Rodrigues)."""
    th = np.linalg.norm(r, axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        k = np.where(th[:, None] > 1e-12, r / th[:, None], 0.0)
    c, s = np.cos(th)[:, None, None], np.sin(th)[:, None, None]
    Kx = np.zeros((len(r), 3, 3))
    Kx[:, 0, 1], Kx[:, 0, 2], Kx[:, 1, 2] = -k[:, 2], k[:, 1], -k[:, 0]
    Kx[:, 1, 0], Kx[:, 2, 0], Kx[:, 2, 1] = k[:, 2], -k[:, 1], k[:, 0]
    return c * np.eye(3) + s * Kx + (1 - c) * k[:, :, None] * k[:, None, :]


def ba_sparsity(ncams, npts, oc, op, pc=(), pp=(), smooth=True, free=None):
    """The Jacobian's pattern for bundle_adjust (scipy.sparse lil): 2 rows per observation (camera oc, point op), 1
    per depth prior (camera pc, point pp), then 3 per inner frame of the motion prior; columns 6 per free camera
    (its Rodrigues turn, then its centre; free: a mask, default every camera but 0, which is held and has none) and
    3 per point. The motion prior depends on the centres only (fewer column groups for the finite differences)."""
    import numpy as np
    from scipy.sparse import coo_matrix
    oc, op, pc, pp = (np.asarray(a, np.int64).ravel() for a in (oc, op, pc, pp))
    if free is None:
        free = np.arange(ncams) > 0
    free = np.asarray(free, bool)
    slot = np.cumsum(free) - 1   # (a free camera's place among the free ones)
    nco = 6 * int(free.sum())
    rows, cols = [], []

    def cam(r, c, which=range(6)):   # (rows r depend on camera c's numbers `which`, if it has them)
        m, w = free[c], np.asarray(list(which))
        rows.append(np.repeat(r[m], len(w))); cols.append((6 * slot[c[m]])[:, None].repeat(len(w), 1).ravel() + np.tile(w, m.sum()))

    def pt(r, p):
        rows.append(np.repeat(r, 3)); cols.append(nco + (3 * p)[:, None].repeat(3, 1).ravel() + np.tile(np.arange(3), len(p)))

    n0 = 2 * len(oc)
    for d in (0, 1):
        r = 2 * np.arange(len(oc)) + d
        cam(r, oc); pt(r, op)
    r = n0 + np.arange(len(pc))
    cam(r, pc); pt(r, pp)
    n1 = n0 + len(pc)
    nsm = max(0, ncams - 2) if smooth else 0
    for d in range(3):
        r = n1 + 3 * np.arange(nsm) + d
        for o in (0, 1, 2):
            cam(r, np.arange(nsm) + o, (3 + d,))
    nrows = n1 + 3 * nsm
    rr, cc = (np.concatenate(a) if a else np.zeros(0, np.int64) for a in (rows, cols))
    return coo_matrix((np.ones(len(rr)), (rr, cc)), shape=(nrows, nco + 3 * npts)).tolil()


def bundle_adjust(cams, X, T, V, K, k_scale, anchors=None, prior_w=BA_PRIOR_W, huber=3.0, smooth_w=BA_SMOOTH_W,
                  max_nfev=BA_NFEV, hold=None):
    """All camera poses (camera-to-world (N, 3, 4); camera 0 held) and 3D points (X (Q, 3), NaN rows: tracks not
    in the solve) refined together to fit the tracks T (Q, N, 2, analysis px) where V (Q, N): reprojection errors
    in clip px under a Huber loss (huber: its knee, px), sparse Jacobian (scipy least_squares, trf). The scale,
    which reprojection can't see, is held by weak depth priors: anchors [{"f": frame, "q": tracks, "z": the
    depth each has in that frame's camera}] (MoGe's metres, or DA3's units) pull each point's depth in that
    camera towards it (prior_w px per unit of relative error). A weak motion prior (the camera centres' second
    difference over the median scene depth, smooth_w px per unit) keeps frames with few points from jumping.
    hold: a mask of cameras kept as they are, besides camera 0 (bridged across a gap: nothing there to refine them).
    Returns (cams, X, info {"err": median reprojection px, "nfev", "time"})."""
    cv2, np = tracking._libs()
    from scipy.optimize import least_squares
    t0 = time.time()
    kx, ky = (k_scale, k_scale) if isinstance(k_scale, (int, float)) else k_scale
    cams, X = np.asarray(cams, np.float64), np.asarray(X, np.float64)
    T, V = np.asarray(T, np.float64), np.asarray(V, bool)
    N = len(cams)
    free = np.arange(N) > 0
    if hold is not None:
        free &= ~np.asarray(hold, bool)
    nf = int(free.sum())
    pts = np.where(np.isfinite(X).all(axis=1))[0]
    M = len(pts)
    slot = np.full(len(X), -1)
    slot[pts] = np.arange(M)
    UV = to_clip(np, T, kx, ky)
    op, oc = np.nonzero(V[pts])          # observations: point slot, frame
    uv = UV[pts[op], oc]
    pc, pp, pz = [], [], []
    for a in anchors or ():
        q, z = np.asarray(a["q"], np.int64), np.asarray(a["z"], np.float64)
        ok = (slot[q] >= 0) & np.isfinite(z) & (z > 0)
        pc.append(np.full(ok.sum(), int(a["f"]))); pp.append(slot[q[ok]]); pz.append(z[ok])
    pc, pp, pz = (np.concatenate(v) if v else np.zeros(0) for v in (pc, pp, pz))
    pc, pp = pc.astype(np.int64), pp.astype(np.int64)
    if not M or not len(oc):
        return cams, X, {"err": None, "nfev": 0, "time": 0.0}
    # each camera as its world-to-camera turn (Rodrigues) and its centre
    r0, c0 = np.zeros((N, 3)), cams[:, :, 3].copy()
    for f in range(N):
        r0[f] = cv2.Rodrigues(cams[f][:, :3].T)[0].ravel()
    z0 = X[pts, 2]
    zref = float(np.median(np.abs(pz))) if len(pz) else float(np.median(np.abs(z0[z0 > 0]))) if (z0 > 0).any() else 1.0
    zeps = 1e-3 * zref
    fx, fy, cx, cy = K
    nsm = N - 2 if smooth_w > 0 else 0
    sw = smooth_w / zref

    def unpack(x):
        c = x[:6 * nf].reshape(nf, 6)
        r, t = r0.copy(), c0.copy()
        r[free], t[free] = c[:, :3], c[:, 3:]
        return r, t, x[6 * nf:].reshape(M, 3)

    def raw(x):
        """(reprojection errors (n_obs, 2), depth prior residuals, motion residuals), unweighted by the loss."""
        r, t, P = unpack(x)
        R = _rodrigues(np, r)   # (t: the centres)
        Xc = np.einsum("nij,nj->ni", R[oc], P[op] - t[oc])
        z = np.maximum(Xc[:, 2], zeps)
        e = np.empty((len(oc), 2))
        e[:, 0] = fx * Xc[:, 0] / z + cx - uv[:, 0]
        e[:, 1] = fy * Xc[:, 1] / z + cy - uv[:, 1]
        d = prior_w * (np.einsum("nj,nj->n", R[pc, 2], P[pp] - t[pc]) - pz) / pz if len(pc) else np.zeros(0)
        if nsm > 0:
            m = sw * (t[:-2] - 2 * t[1:-1] + t[2:]).ravel()
        else:
            m = np.zeros(0)
        return e, d, m

    # the Huber loss by reweighting (IRLS): weights from the current errors (an observation's 2D error as one), then
    # plain least squares; scipy's own robust loss crawls when most errors start beyond the knee
    A = ba_sparsity(N, M, oc, op, pc, pp, smooth=nsm > 0, free=free)
    x = np.concatenate([np.hstack([r0[free], c0[free]]).ravel(), X[pts].ravel()])
    nfev = 0
    for rnd in range(2):
        e, d, _ = raw(x)
        we = np.sqrt(np.minimum(1.0, huber / np.maximum(np.hypot(e[:, 0], e[:, 1]), 1e-9)))[:, None]
        wd = np.sqrt(np.minimum(1.0, huber / np.maximum(np.abs(d), 1e-9)))

        def fun(x, we=we, wd=wd):
            e, d, m = raw(x)
            return np.concatenate([(e * we).ravel(), d * wd, m])

        kw = dict(method="trf", x_scale="jac", max_nfev=max(5, max_nfev // 2), tr_solver="lsmr", ftol=1e-5,
                  tr_options={"regularize": False, "maxiter": 100})   # (lsmr: regularised it needs twice the iterations;
        # and capped, as an ill-posed real problem (lost frames, points seen from one place) would run to thousands)
        res = least_squares(fun, x, jac_sparsity=A, **kw)
        x, nfev = res.x, nfev + res.nfev
    r, t, P = unpack(x)
    out = cams.copy()
    for f in np.where(free)[0]:
        out[f] = np.concatenate([cv2.Rodrigues(r[f])[0].T, t[f][:, None]], axis=1)
    Xo = X.copy()
    Xo[pts] = P
    e = np.hypot(*raw(x)[0].T)
    return out, Xo, {"err": float(np.median(e)), "nfev": int(nfev), "time": time.time() - t0}


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
    """Queue a workflow, wait for it, read the JSON node_id saved (a list of ids: {id: JSON} for each), and leave
    nothing in ComfyUI."""
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
        out = {}
        try:
            for nid in ([node_id] if isinstance(node_id, str) else node_id):
                files = entry.get("outputs", {}).get(nid, {}).get("files") or []
                if not files:
                    raise ValueError(f"{what} gave nothing back")
                data, _ = await comfy.view(files[0]["filename"], files[0].get("subfolder", ""), files[0].get("type", "output"))
                out[nid] = json.loads(data)
        finally:   # (ComfyUI keeps nothing: storage.py)
            storage.drop_comfy_read([f for o in entry.get("outputs", {}).values() for f in (o.get("files") or [])])
        return out[node_id] if isinstance(node_id, str) else out
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


async def _pnp(path, start, W, H, T, V, kx, ky, oi, progress, cancel, smooth=0.0):
    cv2, np = tracking._libs()
    models = [m for m in _models(oi, "LoadMoGeModel") if "moge" in m.lower()]
    model = "moge_3_vitl_fp16.safetensors" if "moge_3_vitl_fp16.safetensors" in models else (models or [None])[0]
    if not model:
        raise ValueError("No MoGe model: put one from Comfy-Org/MoGe (Hugging Face) in ComfyUI/models/geometry_estimation")
    q0 = np.where(V[:, 0])[0]
    if len(q0) < MIN_VIS:
        raise ValueError("Too few points were tracked in the first frame to solve the camera")
    fps = smooth / SMOOTH_S if smooth else 24.0
    frames = choose_anchors(V, fps)
    qs = [np.where(V[:, f])[0] for f in frames]
    UV = to_clip(np, T, kx, ky)
    # the anchor frames as PNGs into ComfyUI's input folder (gone again once read: CLAUDE.md), one MoGe chain
    # each in one run (the model loads once; Deck MoGe Export as it is reads the first picture of a batch)
    tmp = config.DATA_DIR / "tmp" / "track" / f"solve_{uuid.uuid4().hex[:12]}"
    tmp.mkdir(parents=True, exist_ok=True)
    names = []
    try:
        sel = "+".join(f"eq(n,{f})" for f in frames)
        await _ffmpeg(["ffmpeg", "-v", "error", "-y", "-ss", f"{start:.3f}", "-i", str(path), "-an", "-frames:v", str(len(frames)),
                       "-vf", f"select='{sel}',scale={W}:{H}", "-fps_mode", "passthrough", str(tmp / "%03d.png")], "read the anchor frames")
        pngs = sorted(tmp.glob("*.png"))
        if len(pngs) != len(frames):
            raise ValueError(f"Read {len(pngs)} of the {len(frames)} anchor frames")
        img0 = cv2.imread(str(pngs[0]), cv2.IMREAD_COLOR)   # (the cloud's colours)
        for p in pngs:
            names.append(await tracking.comfy.upload_image(p.read_bytes(), f"solve_{uuid.uuid4().hex[:12]}.png", config.COMFY_INPUT_SUBFOLDER))
        wf = {"m": {"class_type": "LoadMoGeModel", "inputs": {"model_name": model}}}
        for i, (name, q) in enumerate(zip(names, qs)):
            wf[f"i{i}"] = {"class_type": "LoadImage", "inputs": {"image": name}}
            wf[f"g{i}"] = {"class_type": "MoGeInference", "inputs": {"moge_model": ["m", 0], "image": [f"i{i}", 0], "resolution_level": 9,
                           "fov_x_degrees": 0.0, "batch_size": 1, "force_projection": True, "apply_mask": True, "refine_steps": 3}}
            wf[f"x{i}"] = {"class_type": MOGE_NODE, "inputs": {"moge_geometry": [f"g{i}", 0], "grid": MOGE_GRID, "filename_prefix": _prefix("moge"),
                           "points": json.dumps([[round(float(x), 2), round(float(y), 2)] for x, y in UV[q, frames[i]]])}}
        exs = await _run(wf, [f"x{i}" for i in range(len(frames))], "MoGe", progress, cancel)
    finally:
        storage.remove([p for n in names if (p := storage.comfy_input(n))])   # (the frames go once read: CLAUDE.md)
        storage.remove([tmp])
    ex = exs["x0"]
    ids, X = lift(UV[q0, 0], ex)
    if len(ids) < MIN_VIS:
        raise ValueError("MoGe found depth for too few of the tracked points")
    ids = q0[ids]
    # MoGe ran on the clip-sized frame, so its K is in clip pixels
    K = [float(v) for v in ex["K"]]
    if ex.get("width") and ex["width"] != W:
        s = W / ex["width"]
        K = [K[0] * s, K[1] * H / ex["height"], (K[2] + 0.5) * s - 0.5, (K[3] + 0.5) * H / ex["height"] - 0.5]

    def grid(e):
        gr = e["grid"]
        Z = np.array([np.nan if p is None else p[2] for p in gr["points"]], np.float64).reshape(gr["rows"], gr["cols"])
        if not np.isfinite(Z).any():
            return None
        return {"Z": Z, "K": [float(v) for v in e["K"]], "size": (e.get("width") or W, e.get("height") or H)}

    later = []
    for i in range(1, len(frames)):
        e = exs[f"x{i}"]
        Xc = np.array([[np.nan] * 3 if p is None else p for p in e["points"]], np.float64).reshape(-1, 3)
        later.append({"f": frames[i], "q": qs[i], "Xc": Xc, "grid": grid(e)})
    cams, q = await asyncio.to_thread(lambda: solve_pnp(T, V, X, ids, K, (kx, ky), anchor=grid(ex), smooth=smooth, anchors=later))
    gr = ex["grid"]
    P = np.array([[np.nan] * 3 if p is None else p for p in gr["points"]], np.float64).reshape(gr["rows"], gr["cols"], 3)
    pc = cloud(np, P, img0[..., ::-1]) if img0 is not None else []
    return {"K": K, "cams": cams, "X": q["X"], "ids": q["ids"], "floor": floor_from_grid(ex["grid"]), "metric": True,
            "lost": q["lost"], "anchors": len(frames), "cloud": pc, "ba_err": q.get("ba_err")}


def da3_lift(T, V, kx, ky, K, W, H, idx, views, grids):
    """3D positions (view 0's frame) for the tracks, from DA3's depth: each track from the first sampled view it's
    seen on with depth there (grids[j]: view j's z-depth grid over the picture; fewer grids than views: only
    those), unprojected with K (clip pixels) and moved by that view's camera (views (S, 3, 4) camera-to-world,
    relative to view 0). Returns (ids, X (M, 3))."""
    _, np = tracking._libs()
    UV = to_clip(np, T, kx, ky)
    have = np.zeros(T.shape[0], bool)
    ids, X = [], []
    for j, G in enumerate(grids):
        f = int(idx[j])
        q = np.where(V[:, f] & ~have)[0]
        if not len(q):
            continue
        rows, cols = G.shape
        u, v = UV[q, f, 0], UV[q, f, 1]
        z = _grid_z(np, G, (u + 0.5) * cols / W - 0.5, (v + 0.5) * rows / H - 0.5)
        ok = np.isfinite(z) & (z > 0)
        Xc = np.stack([(u - K[2]) / K[0] * z, (v - K[3]) / K[1] * z, z], axis=1)[ok]
        R, t = views[j][:, :3], views[j][:, 3]
        ids.extend(q[ok].tolist())
        X.extend((Xc @ R.T + t).tolist())
        have[q[ok]] = True
    return np.array(ids, np.int64), np.array(X, np.float64).reshape(-1, 3)


def da3_priors(T, V, kx, ky, W, H, idx, grids):
    """The bundle adjustment's depth priors from DA3's views after the first (view 0's are the lifted points'
    own): [{"f", "q", "z"}], every track seen on view j's frame with its depth there (grids[j], DA3's units)."""
    _, np = tracking._libs()
    UV = to_clip(np, T, kx, ky)
    out = []
    for j, G in enumerate(grids[1:], 1):
        f = int(idx[j])
        q = np.where(V[:, f])[0]
        rows, cols = G.shape
        z = _grid_z(np, G, (UV[q, f, 0] + 0.5) * cols / W - 0.5, (UV[q, f, 1] + 0.5) * rows / H - 0.5)
        ok = np.isfinite(z) & (z > 0)
        if ok.any():
            out.append({"f": f, "q": q[ok], "z": z[ok]})
    return out


def cloud(np, P, img, most=MAX_CLOUD):
    """The scene as coloured points: P (rows, cols, 3) positions (NaN: none) on a regular grid over a picture
    img (h, w, 3 RGB uint8), coloured from it at the cells' centres; thinned evenly to at most `most`.
    [[x, y, z, r, g, b]...], 3 dp."""
    rows, cols = P.shape[:2]
    h, w = img.shape[:2]
    r, c = np.mgrid[0:rows, 0:cols]
    ok = np.isfinite(P).all(axis=2)
    r, c = r[ok], c[ok]
    if len(r) > most:
        pick = np.linspace(0, len(r) - 1, most).round().astype(int)
        r, c = r[pick], c[pick]
    px = np.clip(np.round((c + 0.5) * w / cols - 0.5).astype(int), 0, w - 1)
    py = np.clip(np.round((r + 0.5) * h / rows - 0.5).astype(int), 0, h - 1)
    rgb = img[py, px]
    return [[round(float(a), 3) for a in P[i, j]] + [int(x) for x in col] for i, j, col in zip(r, c, rgb)]


def drift(cams, floor, X):
    """The camera's median step per frame over the floor height (the median point depth with no floor), so a
    number that reads alike for metric and unscaled solves: 0.02 is 2 % of its height a frame."""
    _, np = tracking._libs()
    if len(cams) < 2:
        return 0.0
    step = float(np.median(np.linalg.norm(np.diff(np.asarray(cams)[:, :, 3], axis=0), axis=1)))
    ref = floor["d"] if floor else (float(np.median(np.asarray(X)[:, 2])) if len(X) else 0.0)
    return round(step / ref, 5) if ref > 0 else None


def _da3_size(W, H):
    g = geom()
    h, w = g.da3_target_size(H, W, DA3_RES)
    return w, h


async def _da3(path, start, W, H, T, V, kx, ky, views, model, oi, progress, cancel, smooth=0.0):
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
        png = await _ffmpeg(["ffmpeg", "-v", "error", "-i", str(clip), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
                            "read the first view")   # (the cloud's colours: what DA3 saw)
    finally:
        clip.unlink(missing_ok=True)
    S = int(ex["views"])
    if S != len(idx):
        raise ValueError(f"Depth Anything 3 saw {S} views, not the {len(idx)} it was given")
    views = relative_to_first(np.array(ex["cams"], np.float64).reshape(S, 3, 4))
    cams = interp_cams(idx, views, N)
    # one lens for the clip (no zoom): the views' median, from the views' pixels to the clip's
    wi, hi = ex["width"], ex["height"]
    # DA3 guesses the two fields of view apart and on a portrait clip they disagree (fx 3401, fy 4036 on a 4K
    # iPhone clip): pixels are square, so one focal length, their geometric mean in clip pixels
    Ki = np.median(np.array(ex["K"], np.float64), axis=0)
    sx, sy = W / wi, H / hi
    f = math.sqrt(Ki[0] * sx * Ki[1] * sy)
    K = [f, f, float((Ki[2] + 0.5) * sx - 0.5), float((Ki[3] + 0.5) * sy - 0.5)]
    Ki = [f / sx, f / sy, Ki[2], Ki[3]]
    dg = {**ex["depth"], "width": wi, "height": hi}
    cols, rows = dg["cols"], dg["rows"]
    D = np.array([np.nan if v is None else v for v in dg["values"]], np.float64).reshape(rows, cols)
    grids = [D] + [np.array([np.nan if v is None else v for v in d["values"]], np.float64).reshape(d["rows"], d["cols"])
                   for d in (ex.get("depths") or [])[1:]]   # (version 2: every view's depth; else view 0 only)
    ids, X = da3_lift(T, V, kx, ky, K, W, H, idx, views, grids)
    if len(ids) < MIN_VIS:
        raise ValueError("Depth Anything 3 found depth for too few of the tracked points")
    floor = floor_from_grid(grid_xyz(dg, [float(v) for v in Ki]))
    # DA3's own cameras, between views only interpolated, wander (0.3 of the floor height on a locked-off shot):
    # each frame is solved from the tracks against view 0's depth instead, starting from (and, when lost, keeping)
    # DA3's camera for it
    anchor = {"Z": D, "K": [float(v) for v in Ki], "size": (wi, hi)}
    priors = da3_priors(T, V, kx, ky, W, H, idx, grids)
    cams, q = await asyncio.to_thread(lambda: solve_pnp(T, V, np.array(X), np.array(ids, np.int64), K, (kx, ky), prior=cams,
                                                        anchor=anchor, smooth=smooth, priors=priors))
    gp = grid_xyz(dg, [float(v) for v in Ki])
    P = np.array([[np.nan] * 3 if p is None else p for p in gp["points"]], np.float64).reshape(gp["rows"], gp["cols"], 3)
    img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
    pc = cloud(np, P, img[..., ::-1]) if img is not None else []
    return {"K": K, "cams": cams, "X": q["X"], "ids": q["ids"], "floor": floor, "metric": False, "lost": q["lost"],
            "anchors": len(grids), "cloud": pc, "ba_err": q.get("ba_err")}


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
        s = await _pnp(path, start, W, H, T, V, kx, ky, oi, part(0.45, 0.9), cancel, smooth=SMOOTH_S * tr["fps"])
    else:
        s = await _da3(path, start, W, H, T, V, kx, ky, max(8, min(64, int(views))), model, oi, part(0.45, 0.9), cancel,
                       smooth=SMOOTH_S * tr["fps"])
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
           "quality": {"used": int(len(s["ids"])), "err": None if err is None else round(err, 3), "lost": int(s["lost"]),
                       "drift": drift(s["cams"], fl, X), "anchors": int(s.get("anchors", 1)),
                       "ba_err": None if s.get("ba_err") is None else round(float(s["ba_err"]), 3)},
           "cloud": s.get("cloud") or [],
           "cost": round(time.time() - t_start, 2)}
    if progress:
        progress(1.0)
    return out
