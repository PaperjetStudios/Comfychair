"""Human motion files (text-to-motion, video mocap) as the 3D tab's motion: {fps, frames: [[22 x [x, y, z]]]}.

Joint positions in the SMPL / HumanML3D 22-joint order (SMPL-H and SMPL-X bodies start with the same 22),
metres, y up. Reads a .npz (the first array shaped (frames, joints >= 22, 3), plus a frame rate if it has
one) or a .json ({"fps", "frames"} or {"fps", "joints"}). Z-up files are turned to y-up, and the motion is
turned so the person starts facing +Z and stands on y = 0; web/motion.js puts it onto a figure.
"""
import io
import json
import math

N = 22
FPS_KEYS = ("fps", "mocap_framerate", "frame_rate", "framerate", "mocap_frame_rate")
POS_KEYS = ("joints", "posed_joints", "joint_positions", "positions", "keypoints3d", "global_joint_positions")


def _np():
    import numpy as np
    return np


def _pick(arrays: dict):
    """(positions (T, 22, 3), fps or None) from named arrays."""
    np = _np()
    cands = [k for k in POS_KEYS if k in arrays] + [k for k in arrays if k not in POS_KEYS]
    pos = None
    for k in cands:
        a = np.asarray(arrays[k])
        if a.ndim == 4 and a.shape[0] == 1:
            a = a[0]
        if a.ndim == 3 and a.shape[1] >= N and a.shape[2] == 3 and a.shape[0] >= 2 and np.issubdtype(a.dtype, np.number):
            pos = a[:, :N].astype(np.float64)
            break
    if pos is None:
        raise ValueError("No joint positions in that file (wanted an array shaped frames × 22+ joints × 3)")
    fps = None
    for k in FPS_KEYS:
        if k in arrays:
            try:
                fps = float(np.asarray(arrays[k]).reshape(-1)[0])
            except (TypeError, ValueError, IndexError):
                pass
            break
    return pos, fps


def _normalise(pos):
    """y up, facing +Z at the start, feet on the floor, starting over the origin. Also (M, t): what was done,
    as normalised = M @ given + t (so a camera-space capture can be put back where its camera saw it)."""
    np = _np()
    M = np.eye(3)
    up = (pos[:, 15] - pos[:, 0]).mean(axis=0)        # head minus pelvis
    if abs(up[2]) > abs(up[1]) and abs(up[2]) > abs(up[0]):
        s = 1.0 if up[2] > 0 else -1.0
        pos = np.stack([pos[..., 0], pos[..., 2] * s, -pos[..., 1] * s], axis=-1)   # z up -> y up
        M = np.array([[1, 0, 0], [0, 0, s], [0, -s, 0]], dtype=float)
    elif up[1] < 0:
        pos = pos * np.array([1, -1, -1])
        M = np.diag([1.0, -1.0, -1.0])
    left = pos[0, 1] - pos[0, 2]                       # left hip minus right hip: should point +X
    yaw = math.atan2(left[2], left[0])                 # turn about y that takes it to +X
    c, s = math.cos(yaw), math.sin(yaw)
    rot = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
    pos = pos @ rot.T
    t = np.array([-pos[0, 0, 0], -pos[:, [10, 11], 1].min(), -pos[0, 0, 2]])
    pos = pos + t                                     # the lowest toe on the floor, starting over the origin
    return pos, rot @ M, t


def read(data: bytes, name: str = "motion.npz", default_fps: float = 30.0) -> dict:
    np = _np()
    extra, doc = {}, {}
    if name.lower().endswith(".json"):
        doc = json.loads(data)
        # a video capture (Deck Save Body Motion) is in its camera's space; newer ones also say the lens (pixels)
        for k in ("source", "focal", "size"):
            if doc.get(k) is not None:
                extra[k] = doc[k]
        arrays = {"joints": doc.get("frames", doc.get("joints"))}
        if doc.get("fps"):
            arrays["fps"] = doc["fps"]
    else:
        with np.load(io.BytesIO(data), allow_pickle=False) as z:
            arrays = {k: z[k] for k in z.files}
    pos, fps = _pick(arrays)
    if not np.isfinite(pos).all():
        raise ValueError("The motion has missing (NaN) values")
    pos, M, t = _normalise(pos)
    extras = _extras(doc, M, t) if doc else {}
    return {"fps": round(fps or default_fps, 4), "frames": np.round(pos, 4).tolist(), "joints": N,
            "seconds": round((len(pos) - 1) / (fps or default_fps), 2),
            "space": {"m": np.round(M, 6).tolist(), "t": np.round(t, 5).tolist()}, **extra, **extras}


# SMPL 22, parent of each joint (pelvis has none). A child's bone is rescaled before its own children.
_PARENT = {1: 0, 2: 0, 3: 0, 4: 1, 5: 2, 6: 3, 7: 4, 8: 5, 9: 6, 10: 7, 11: 8, 12: 9, 13: 9, 14: 9,
           15: 12, 16: 13, 17: 14, 18: 16, 19: 17, 20: 18, 21: 19}
_L_TOE, _R_TOE, _L_ANK, _R_ANK = 10, 11, 7, 8
_L_WRIST, _R_WRIST, _HEAD = 20, 21, 15


def _alpha(cutoff, fps):
    tau = 1.0 / (2.0 * math.pi * max(cutoff, 1e-4))
    te = 1.0 / max(fps, 1e-3)
    return 1.0 / (1.0 + tau / te)


def _euro(x, fps, min_cutoff=1.0, beta=0.02, d_cutoff=1.0):
    """One Euro filter on one series: a slow move is smoothed, a fast one is followed."""
    np = _np()
    out = np.empty_like(x, dtype=np.float64)
    out[0] = x[0]
    x_hat, dx_hat = float(x[0]), 0.0
    a_d = _alpha(d_cutoff, fps)
    for i in range(1, len(x)):
        dx = (float(x[i]) - float(x[i - 1])) * fps
        dx_hat = a_d * dx + (1.0 - a_d) * dx_hat
        a = _alpha(min_cutoff + beta * abs(dx_hat), fps)
        x_hat = a * float(x[i]) + (1.0 - a) * x_hat
        out[i] = x_hat
    return out


def _fill(pos):
    """Linear fill of a missing joint (held at the ends). A whole column of gaps becomes 0."""
    np = _np()
    out = np.array(pos, dtype=np.float64, copy=True)
    idx = np.arange(len(out))
    for j in range(out.shape[1]):
        for c in range(3):
            col = out[:, j, c]
            bad = ~np.isfinite(col)
            if not bad.any():
                continue
            if bad.all():
                col[:] = 0.0
                continue
            col[bad] = np.interp(idx[bad], idx[~bad], col[~bad])
    return out


def _smooth(pos, fps):
    np = _np()
    out = np.empty_like(pos)
    for j in range(pos.shape[1]):
        for c in range(3):
            out[:, j, c] = _euro(pos[:, j, c], fps)
    return out


def _root_depth(pos, fps):
    """Pelvis z is the noisiest axis. Low-pass it harder, and take the whole body with it."""
    out = pos.copy()
    z = _euro(out[:, 0, 2], fps, min_cutoff=0.3, beta=0.0, d_cutoff=0.3)
    out[:, :, 2] += (z - out[:, 0, 2])[:, None]
    return out


def _bones(pos):
    """Each bone held at its median length, child pulled along the bone. Stops limbs stretching with depth noise."""
    np = _np()
    out = pos.copy()
    for child, parent in _PARENT.items():
        v = out[:, child] - out[:, parent]
        length = np.linalg.norm(v, axis=1)
        med = float(np.median(length))
        scale = med / np.maximum(length, 1e-6)
        out[:, child] = out[:, parent] + v * scale[:, None]
    return out


def _speed_xz(pos, joint, fps):
    np = _np()
    d = np.linalg.norm(np.diff(pos[:, joint][:, [0, 2]], axis=0), axis=1) * fps
    return np.concatenate([d, d[-1:]])


def _hysteresis(raw, n=3):
    """A contact turns on only after n frames of it, and off only after n frames without it."""
    state, run = False, 0
    out = []
    for v in raw:
        v = bool(v)
        if v == state:
            run = 0
        else:
            run += 1
            if run >= n:
                state, run = v, 0
        out.append(state)
    return out


def _spans(mask):
    spans, i, n = [], 0, len(mask)
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j < n and mask[j]:
            j += 1
        spans.append((i, j))
        i = j
    return spans


def _plant(pos, fps):
    """A foot that stays low and slow is pinned to that step's place. The body follows the planted feet.
    The pin blends in and out over 3 frames."""
    np = _np()
    T = len(pos)
    feet = (("l", _L_TOE, _L_ANK), ("r", _R_TOE, _R_ANK))
    masks = {}
    for side, toe, _ank in feet:
        raw = (pos[:, toe, 1] < 0.03) & (_speed_xz(pos, toe, fps) < 0.25)
        masks[side] = _hysteresis(raw)
    orig = pos.copy()
    corr = np.zeros((T, 2))
    weight = np.zeros(T)
    pins = []
    for side, toe, ank in feet:
        for a, b in _spans(masks[side]):
            tx, tz = float(orig[a:b, toe, 0].mean()), float(orig[a:b, toe, 2].mean())
            ax, az = float(orig[a:b, ank, 0].mean()), float(orig[a:b, ank, 2].mean())
            for i in range(a, b):
                u = 1.0
                if i - a < 3:
                    u = min(u, (i - a + 1) / 3.0)
                if b - 1 - i < 3:
                    u = min(u, (b - i) / 3.0)
                corr[i, 0] += (tx - orig[i, toe, 0]) * u
                corr[i, 1] += (tz - orig[i, toe, 2]) * u
                weight[i] += 1.0
                pins.append((i, toe, ank, tx, tz, ax, az, u))
    on = weight > 0
    corr[on] /= weight[on, None]
    pos = orig.copy()
    pos[:, :, 0] += corr[:, 0][:, None]
    pos[:, :, 2] += corr[:, 1][:, None]
    for i, toe, ank, tx, tz, ax, az, u in pins:
        pos[i, toe, 0] = orig[i, toe, 0] * (1.0 - u) + tx * u
        pos[i, toe, 2] = orig[i, toe, 2] * (1.0 - u) + tz * u
        pos[i, ank, 0] = orig[i, ank, 0] * (1.0 - u) + ax * u
        pos[i, ank, 2] = orig[i, ank, 2] * (1.0 - u) + az * u
    contacts = {s: [int(v) for v in masks[s]] for s, _t, _a in feet}
    return pos, contacts


def _ground(pos, contacts):
    """The floor is the contact frames' toe height, not the lowest toe in the clip."""
    np = _np()
    if not contacts:
        return pos
    ys = []
    for i, (lv, rv) in enumerate(zip(contacts["l"], contacts["r"])):
        if lv:
            ys.append(pos[i, _L_TOE, 1])
        if rv:
            ys.append(pos[i, _R_TOE, 1])
    if not ys:
        return pos
    out = pos.copy()
    out[:, :, 1] -= float(np.median(ys))
    return out


def clean(pos, fps, opts=None):
    """Jitter, bone lengths, pelvis depth, planted feet, then the floor. opts picks the steps
    (smooth, bones, feet, ground). Returns (positions, contacts or None)."""
    o = opts or {}
    pos = _fill(pos)
    contacts = None
    if o.get("smooth"):
        pos = _smooth(pos, fps)
        pos = _root_depth(pos, fps)
    if o.get("bones"):
        pos = _bones(pos)
    if o.get("feet"):
        pos, contacts = _plant(pos, fps)
    if o.get("ground"):
        pos = _ground(pos, contacts)
    return pos, contacts


def _xform(points, M, t):
    """The same turn and shift _normalise used, on extra points shaped (frames, points, 3)."""
    np = _np()
    p = np.asarray(points, dtype=np.float64)
    return np.einsum("ij,...j->...i", M, p) + t


def _extras(d, M, t):
    """Hands, face and the raw camera shift, in the same space as the normalised joints. Absent on an old file."""
    np = _np()
    out = {}
    hands = d.get("hands")
    if isinstance(hands, dict) and hands.get("l") and hands.get("r"):
        out["hands"] = {s: np.round(_xform(hands[s], M, t), 4).tolist() for s in ("l", "r")}
    if d.get("face"):
        out["face"] = np.round(_xform(d["face"], M, t), 4).tolist()
    if d.get("cam_t"):
        out["cam_t"] = d["cam_t"]
    return out


def _shift(points, delta):
    np = _np()
    return np.round(np.asarray(points, dtype=np.float64) + delta[:, None, :], 4).tolist()


def apply_clean(m, opts):
    """clean() on a motion dict. Hands follow the wrist and the face follows the head, so they stay on the body."""
    np = _np()
    if not opts or not any(opts.get(k) for k in ("smooth", "bones", "feet", "ground")):
        return m
    before = np.asarray(m["frames"], dtype=np.float64)
    pos, contacts = clean(before, float(m.get("fps") or 24), opts)
    out = {**m, "frames": np.round(pos, 4).tolist()}
    if contacts is not None:
        out["contacts"] = contacts
    if m.get("hands"):
        out["hands"] = {"l": _shift(m["hands"]["l"], pos[:, _L_WRIST] - before[:, _L_WRIST]),
                        "r": _shift(m["hands"]["r"], pos[:, _R_WRIST] - before[:, _R_WRIST])}
    if m.get("face"):
        out["face"] = _shift(m["face"], pos[:, _HEAD] - before[:, _HEAD])
    return out
