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
    extra = {}
    if name.lower().endswith(".json"):
        d = json.loads(data)
        # a video capture (Deck Save Body Motion) is in its camera's space; newer ones also say the lens (pixels)
        for k in ("source", "focal", "size"):
            if d.get(k) is not None:
                extra[k] = d[k]
        arrays = {"joints": d.get("frames", d.get("joints"))}
        if d.get("fps"):
            arrays["fps"] = d["fps"]
    else:
        with np.load(io.BytesIO(data), allow_pickle=False) as z:
            arrays = {k: z[k] for k in z.files}
    pos, fps = _pick(arrays)
    if not np.isfinite(pos).all():
        raise ValueError("The motion has missing (NaN) values")
    pos, M, t = _normalise(pos)
    return {"fps": round(fps or default_fps, 4), "frames": np.round(pos, 4).tolist(), "joints": N,
            "seconds": round((len(pos) - 1) / (fps or default_fps), 2),
            "space": {"m": np.round(M, 6).tolist(), "t": np.round(t, 5).tolist()}, **extra}
