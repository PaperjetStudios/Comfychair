"""Steady DWPose or SDPose keypoints over a clip (numpy only, so the tests run without ComfyUI).

DWPose looks at every frame on its own, so points shake from frame to frame, flicker out for a frame or two and
now and then jump to the wrong place. This works on the whole clip at once (no lag, unlike a live filter):
people are followed from frame to frame by where their body is, short gaps are filled in, points that jump away
from their neighbours are pulled back, and every point is averaged with its neighbours in time (a Gaussian of
Smoothing frames). Points that are missing for longer than Max gap stay missing.
"""
import numpy as np

PARTS = ("pose_keypoints_2d", "face_keypoints_2d", "hand_left_keypoints_2d", "hand_right_keypoints_2d")


def _points(person, part):
    v = person.get(part)
    if not v:
        return None
    a = np.asarray(v, dtype=np.float64).reshape(-1, 3)
    return a


def _centre(person):
    a = _points(person, PARTS[0])
    if a is None or not (a[:, 2] > 0).any():
        return None
    return a[a[:, 2] > 0, :2].mean(0)


def _size(person):
    a = _points(person, PARTS[0])
    if a is None or (a[:, 2] > 0).sum() < 2:
        return None
    p = a[a[:, 2] > 0, :2]
    return float(np.linalg.norm(p.max(0) - p.min(0)))


def tracks(frames):
    """[[person or None per frame] per track]: each frame's people matched to the nearest track of the frame before."""
    out, last = [], []          # last: (track index, centre, size) seen on the previous frame with a body
    for f, frame in enumerate(frames):
        people = [p for p in (frame or {}).get("people") or [] if p]
        taken, now = set(), []
        for p in people:
            c, s = _centre(p), _size(p) or 0.0
            best = None
            if c is not None:
                cands = [(np.linalg.norm(c - lc), t) for t, lc, ls in last if t not in taken and np.linalg.norm(c - lc) < max(ls, s) * 0.75 + 1e-9]
                best = min(cands)[1] if cands else None
            if best is None:
                best = len(out)
                out.append([None] * len(frames))
            taken.add(best)
            out[best][f] = p
            if c is not None:
                now.append((best, c, s))
        # a track keeps its last place while it is missing, so it can pick up again after a gap
        last = now + [x for x in last if x[0] not in taken]
    return out


def _fill(xy, ok, max_gap):
    """Gaps of up to max_gap frames between two found points: linear. A point seen on one frame alone is dropped."""
    ok = ok.copy()
    n = len(ok)
    for i in range(n):
        if ok[i] and (i == 0 or not ok[i - 1]) and (i == n - 1 or not ok[i + 1]) and n > 2:
            ok[i] = False
    idx = np.flatnonzero(ok)
    filled = ok.copy()
    for a, b in zip(idx[:-1], idx[1:]):
        if 1 < b - a <= max_gap + 1:
            t = (np.arange(a + 1, b) - a) / (b - a)
            xy[a + 1:b] = xy[a] + (xy[b] - xy[a]) * t[:, None]
            filled[a + 1:b] = True
    return filled


def _despike(xy, ok, limit):
    """A point further than limit from the median of its five neighbours in time is put on that median."""
    out = xy.copy()
    n = len(ok)
    for i in np.flatnonzero(ok):
        j = [k for k in range(max(0, i - 2), min(n, i + 3)) if ok[k]]
        if len(j) < 3:
            continue
        m = np.median(xy[j], axis=0)
        if np.linalg.norm(xy[i] - m) > limit:
            out[i] = m
    return out


def _gauss(xy, ok, sigma):
    if sigma <= 0:
        return xy
    r = max(1, int(np.ceil(sigma * 3)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    n = len(ok)
    out = xy.copy()
    for i in np.flatnonzero(ok):
        lo, hi = max(0, i - r), min(n, i + r + 1)
        w = k[lo - i + r:hi - i + r] * ok[lo:hi]
        out[i] = (xy[lo:hi] * w[:, None]).sum(0) / w.sum()
    return out


def threshold(frames, min_score):
    """Points scored below min_score as not found (SDPose gives real scores; DWPose only 1 or 0), the rest as 1."""
    out = []
    for f in frames:
        people = []
        for p in (f or {}).get("people") or []:
            q = dict(p)
            for part in PARTS:
                v = p.get(part)
                if v:
                    a = np.asarray(v, dtype=np.float64).reshape(-1, 3)
                    keep = a[:, 2] >= max(min_score, 1e-9)
                    a[keep, 2], a[~keep] = 1.0, 0.0
                    q[part] = [float(x) for x in a.reshape(-1)]
            people.append(q)
        out.append({**(f or {}), "people": people})
    return out


def smooth(frames, smoothing=2.0, max_gap=6, min_score=0.3):
    """frames: POSE_KEYPOINT from DWPose or SDPose (one OpenPose dict per frame). Returns new dicts, same layout."""
    T = len(frames)
    if T == 0:
        return []
    frames = threshold(frames, min_score)
    tr = tracks(frames)
    people = [[] for _ in range(T)]
    for track in tr:
        sizes = [s for s in (_size(p) for p in track if p) if s]
        scale = float(np.median(sizes)) if sizes else 1.0
        done = [dict(p) if p else None for p in track]
        for part in PARTS:
            arrs = [_points(p, part) if p else None for p in track]
            K = max((len(a) for a in arrs if a is not None), default=0)
            if not K:
                continue
            xy = np.zeros((T, K, 2))
            ok = np.zeros((T, K), bool)
            for f, a in enumerate(arrs):
                if a is not None and len(a) == K:
                    xy[f], ok[f] = a[:, :2], a[:, 2] > 0
            # hands and faces are small and quick: a smaller jump counts as a spike, and they get half the smoothing
            body = part == PARTS[0]
            limit, sig = scale * (0.12 if body else 0.06), smoothing if body else smoothing * 0.5
            new_ok = np.zeros_like(ok)
            for k in range(K):
                o = _fill(xy[:, k], ok[:, k], max_gap)
                xy[:, k] = _gauss(_despike(xy[:, k], o, limit), o, sig)
                new_ok[:, k] = o
            for f in range(T):
                if not new_ok[f].any():
                    if done[f] is not None:
                        done[f][part] = None
                    continue
                if done[f] is None:
                    done[f] = {q: None for q in PARTS}
                done[f][part] = [float(v) for k in range(K)
                                 for v in ((xy[f, k, 0], xy[f, k, 1], 1.0) if new_ok[f, k] else (0.0, 0.0, 0.0))]
        for f, p in enumerate(done):
            if p is not None and p.get(PARTS[0]):
                people[f].append(p)
    return [{**(frames[f] or {}), "people": people[f]} for f in range(T)]
