"""3D camera solve (app/solve.py, comfy_nodes/deck_solve/geom.py): PnP recovers a known camera path from
synthetic tracks, the floor is found, DA3's sampled cameras are interpolated, and a whole pnp solve runs
against a fake ComfyUI and leaves nothing behind in it. Run: .venv/bin/python -m unittest discover tests"""
import asyncio
import importlib.util
import json
import math
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
os.environ.setdefault("DECK_COMFY_DIR", "")

try:
    import cv2
    import numpy as np
except ImportError:
    cv2 = None

from fastapi.testclient import TestClient  # noqa: E402

from app import config, main, solve, tracking  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "deck_solve_geom", Path(__file__).resolve().parent.parent / "comfy_nodes" / "deck_solve" / "geom.py")
geom = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(geom)

W, H, N = 640, 360, 40
K = [500.0, 500.0, (W - 1) / 2, (H - 1) / 2]


def rot(ax, ay, az):
    """Degrees about x, then y, then z."""
    return cv2.Rodrigues(np.radians([0, 0, az]))[0] @ cv2.Rodrigues(np.radians([0, ay, 0]))[0] @ cv2.Rodrigues(np.radians([ax, 0, 0]))[0]


def plane_z(v):
    """A sloping ground: 8 m away at the top of the picture, 3 m at the bottom (inverse depth linear in v)."""
    return 1 / (1 / 8 + (1 / 3 - 1 / 8) * (v + 0.5) / H)


def path(move=1.0):
    """A 40-frame camera path, camera-to-world: turning, and walking (scaled by move; 0: turning on the spot)."""
    cams = []
    for i in range(N):
        R = rot(0.1 * i, 0.4 * i, 0.05 * i)
        t = np.array([0.02 * i, -0.004 * i, 0.03 * i]) * move
        cams.append(np.concatenate([R, t[:, None]], axis=1))
    return np.array(cams)


def in_view(n, rng, plane=False, cam=None):
    """n points 3..8 m in front of a camera (camera 0 when cam is None; on plane_z with plane), in world axes."""
    u, v, z = rng.uniform(10, W - 10, n), rng.uniform(10, H - 10, n), rng.uniform(3, 8, n)
    if plane:
        z = plane_z(v)
    X = np.stack([(u - K[2]) / K[0] * z, (v - K[3]) / K[1] * z, z], axis=1)
    return X if cam is None else X @ cam[:, :3].T + cam[:, 3]


def project(X, cams, rng, noise):
    """2D tracks (Q, N, 2) of world points through the cameras and where each is seen (inside the picture);
    frame 0 exact, the others with noise px."""
    T, V = np.zeros((len(X), len(cams), 2)), np.zeros((len(X), len(cams)), bool)
    for f, c in enumerate(cams):
        Xc = (X - c[:, 3]) @ c[:, :3]
        uu, vv = K[0] * Xc[:, 0] / Xc[:, 2] + K[2], K[1] * Xc[:, 1] / Xc[:, 2] + K[3]
        T[:, f] = np.stack([uu, vv], 1) + (rng.normal(0, noise, (len(X), 2)) if f else 0)
        V[:, f] = (Xc[:, 2] > 0.1) & (uu >= 0) & (uu < W) & (vv >= 0) & (vv < H)
    return T, V


def scene(noise=0.1, seed=3, plane=False, move=1.0):
    """200 points 3..8 m in front of camera 0 (on plane_z with plane) and path(move): the points'
    2D tracks (Q, N, 2) and where each is seen."""
    rng = np.random.default_rng(seed)
    X, cams = in_view(200, rng, plane), path(move)
    T, V = project(X, cams, rng, noise)
    return X, cams, T, V


def churn(move=1.0, plane=False, later_from_0=False):
    """scene() whose frame-0 points are all lost after frame 19, and 200 others (in the last frame's view, or
    with later_from_0 on frame 0's surface) seen from frame 6 on."""
    X, cams, T, V = scene(plane=plane, move=move)
    rng = np.random.default_rng(11)
    XB = in_view(200, rng, plane, None if later_from_0 else cams[-1])
    TB, VB = project(XB, cams, rng, 0.1)
    V[:, 20:] = False
    VB[:, :6] = False
    churn.later = XB   # (the later points' true positions)
    return X, cams, np.concatenate([T, TB]), np.concatenate([V, VB])


def floor_grid(cols=48, seed=5):
    """A grid of the picture's 3D points: a floor 1.5 m below the camera (cv: y = 1.5), a back wall at 10 m and
    a side wall at x = 2.5, 1 cm of noise."""
    rng = np.random.default_rng(seed)
    rows = round(cols * H / W)
    pts = []
    for r in range(rows):
        for c in range(cols):
            u, v = (c + 0.5) * W / cols - 0.5, (r + 0.5) * H / rows - 0.5
            d = np.array([(u - K[2]) / K[0], (v - K[3]) / K[1], 1.0])
            z = 10.0
            if d[1] > 0:
                z = min(z, 1.5 / d[1])
            if d[0] > 0:
                z = min(z, 2.5 / d[0])
            pts.append(list(d * z + rng.normal(0, 0.01, 3)))
    return {"cols": cols, "rows": rows, "points": pts}


def angle(Ra, Rb):
    return math.degrees(np.linalg.norm(cv2.Rodrigues(Ra.T @ Rb)[0]))


@unittest.skipUnless(cv2, "needs numpy and opencv")
class Pnp(unittest.TestCase):
    def test_recovers_the_camera_path(self):
        X, cams, T, V = scene()
        got, q = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0)
        self.assertEqual(q["lost"], 0)
        np.testing.assert_allclose(got[0], np.eye(3, 4), atol=1e-9)
        for f in range(N):
            self.assertLess(np.linalg.norm(got[f][:, 3] - cams[f][:, 3]), 0.02, f)
            self.assertLess(angle(got[f][:, :3], cams[f][:, :3]), 0.3, f)
        self.assertLess(solve.reproj_err(got, X, np.arange(200), T, V, K, 1.0), 0.5)

    def test_too_few_points_hold_the_pose(self):
        X, cams, T, V = scene()
        V[:, 20:23] = False
        V[:5, 20:23] = True   # five seen: not enough
        got, q = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0)
        self.assertEqual(q["lost"], 3)
        self.assertLess(np.linalg.norm(got[30][:, 3] - cams[30][:, 3]), 0.02)   # and picks up again
        got, q = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0, ba=False)
        self.assertEqual(q["lost"], 3)
        np.testing.assert_allclose(got[22], got[19])
        got, q = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0)   # the bundle adjustment places them from the five
        for f in (20, 21, 22):                                        # and the motion prior
            self.assertLess(np.linalg.norm(got[f][:, 3] - cams[f][:, 3]), 0.01, f)

    def test_analysis_scale(self):
        X, cams, T, V = scene(noise=0)
        k = W / 320
        got, _ = solve.solve_pnp((T + 0.5) / k - 0.5, V, X, np.arange(200), K, k)
        self.assertLess(np.linalg.norm(got[-1][:, 3] - cams[-1][:, 3]), 0.02)

    def test_points_that_come_later_are_triangulated(self):
        # (the old solve lost every frame once frame 0's points had gone: a KLT track rarely lasts a whole clip)
        X, cams, T, V = churn()
        got, q = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0, grow=False)
        self.assertEqual(q["lost"], N - 20)
        got, q = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0)
        self.assertEqual(q["lost"], 0)
        self.assertGreater(q["used"], 300)
        for f in (20, N - 1):
            self.assertLess(np.linalg.norm(got[f][:, 3] - cams[f][:, 3]), 0.03, f)
            self.assertLess(angle(got[f][:, :3], cams[f][:, :3]), 0.3, f)

    def test_turning_on_the_spot_puts_new_points_on_frame_0s_depth(self):
        # no walking, so nothing triangulates: later points go onto frame 0's depth (a sloping ground here)
        X, cams, T, V = churn(move=0.0, plane=True, later_from_0=True)
        rows, cols = 54, 96
        Z = np.tile(plane_z((np.arange(rows) + 0.5) * H / rows - 0.5)[:, None], (1, cols))
        anchor = {"Z": Z, "K": K, "size": (W, H)}
        got, q = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0, anchor=anchor)
        self.assertEqual(q["lost"], 0)
        for f in (20, N - 1):
            self.assertLess(np.linalg.norm(got[f][:, 3]), 0.05, f)
            self.assertLess(angle(got[f][:, :3], cams[f][:, :3]), 0.3, f)
        # a ray from the last camera meets the ground where the point is
        Rf = cams[-1][:, :3].T
        tf = -Rf @ cams[-1][:, 3]
        q = np.where(V[200:, -1])[0]
        Kinv = np.linalg.inv(np.array([[K[0], 0, K[2]], [0, K[1], K[3]], [0, 0, 1]]))
        got = solve._onto_anchor(np, anchor, Rf, tf, T[200 + q, -1], Kinv)
        hit = np.isfinite(got).all(axis=1)   # (those inside frame 0's view)
        self.assertGreater(hit.sum(), 20)
        self.assertLess(np.median(np.linalg.norm(got[hit] - churn.later[q[hit]], axis=1)), 0.05)

    def test_after_a_pan_new_points_take_their_neighbours_depth(self):
        # turning on the spot past frame 0's view: no parallax, no frame-0 depth there; the neighbours' depth will do
        X, cams, T, V = churn(move=0.0, plane=True)
        got, q = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0, grow=False)
        self.assertEqual(q["lost"], N - 20)
        got, q = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0)
        self.assertEqual(q["lost"], 0)
        for f in (20, N - 1):
            self.assertLess(np.linalg.norm(got[f][:, 3]), 0.05, f)
            self.assertLess(angle(got[f][:, :3], cams[f][:, :3]), 0.3, f)

    def test_moving_things_are_dropped(self):
        # a fifth of the tracks are on something moving (a wave, a person): they go, the camera stays right
        X, cams, T, V = scene()
        T[:40] += np.arange(N)[None, :, None] * np.array([2.5, 1.0])
        got, q = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0)
        self.assertLessEqual(len(set(range(40)) & set(q["ids"].tolist())), 3)   # (a few seen only briefly may stay)
        for f in range(N):
            self.assertLess(np.linalg.norm(got[f][:, 3] - cams[f][:, 3]), 0.02, f)
            self.assertLess(angle(got[f][:, :3], cams[f][:, :3]), 0.3, f)

    def test_smoothing_keeps_a_steady_move(self):
        X, cams, T, V = scene(noise=0.3)
        got, q = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0, smooth=2.0)
        np.testing.assert_allclose(got[0], np.eye(3, 4), atol=1e-9)
        for f in range(N):
            self.assertLess(np.linalg.norm(got[f][:, 3] - cams[f][:, 3]), 0.02, f)
        self.assertLess(solve.reproj_err(got, q["X"], q["ids"], T, V, K, 1.0), 0.6)

    def test_lift(self):
        ids, X = solve.lift([[1, 2], [3, 4], [5, 6]], {"points": [[0, 0, 2], None, [1, 1, 3]]})
        self.assertEqual(list(ids), [0, 2])
        self.assertEqual(X.shape, (2, 3))


@unittest.skipUnless(cv2, "needs numpy and opencv")
class Anchors(unittest.TestCase):
    def test_chosen_where_coverage_drops(self):
        V = np.zeros((300, 200), bool)
        V[:100, :60] = True       # frame 0's tracks, gone at 60
        V[100:200, 40:140] = True   # others from 40: under 40 % covered once frame 0's go
        V[200:, 120:] = True
        self.assertEqual(solve.choose_anchors(V, 24.0), [0, 60, 132])   # (132: three seconds after 60)
        self.assertEqual(solve.choose_anchors(V, 24.0, every=1.0, most=99)[:3], [0, 24, 48])   # (or every second at most)
        a = solve.choose_anchors(V, 24.0, every=0.5)   # (too many: spread over the clip, not the first few)
        self.assertEqual((len(a), a[0]), (solve.MAX_ANCHORS, 0))
        self.assertGreater(a[-1], 180)
        self.assertEqual(solve.choose_anchors(V, 24.0, gap=5.0), [0, 120])   # (never closer than gap)

    def test_similarity_recovers_scale_turn_and_shift(self):
        rng = np.random.default_rng(2)
        A = rng.uniform(-3, 3, (60, 3)) + [0, 0, 6]
        R, t, sc = rot(10, -35, 20), np.array([0.4, -1.2, 2.0]), 1.7
        B = sc * A @ R.T + t + rng.normal(0, 0.005, A.shape)
        B[:10] += rng.uniform(-3, 3, (10, 3))   # a sixth wrong
        s2, R2, t2, inl = solve.similarity(A, B)
        self.assertAlmostEqual(s2, sc, delta=0.01)
        self.assertLess(angle(R2, R), 0.2)
        np.testing.assert_allclose(t2, t, atol=0.05)
        self.assertFalse(inl[:10].any())
        self.assertTrue(inl[10:].all())

    def test_a_later_anchor_by_similarity_or_by_pose(self):
        X, cams, T, V = scene()
        c = cams[20]
        w2c = (c[:, :3].T, -c[:, :3].T @ c[:, 3])
        Xc = (X - c[:, 3]) @ c[:, :3] * 0.5   # (MoGe at this frame puts things at half the distance)
        a = {"q": np.arange(200), "Xc": Xc}
        for shared in (60, 0):
            Xw, have = np.full((200, 3), np.nan), np.zeros(200, bool)
            Xw[:shared], have[:shared] = X[:shared], True
            if not shared:   # (none shared: its frame's camera, MoGe's own scale)
                sim = solve._place_anchor(np, a, Xw, have, np.zeros(200, bool), w2c)
                np.testing.assert_allclose(Xw[100:], 0.5 * (X[100:] - c[:, 3]) + c[:, 3], atol=1e-9)
                continue
            sim = solve._place_anchor(np, a, Xw, have, np.zeros(200, bool), w2c)
            self.assertAlmostEqual(sim[0], 2.0, delta=1e-6)
            np.testing.assert_allclose(Xw[shared:], X[shared:], atol=1e-6)
            self.assertTrue(have.all())

    def test_da3_lift_from_a_later_view(self):
        # a track first seen on view 2 takes its depth from view 2's grid and lands in view 0's frame
        X, cams, T, V = scene(noise=0)
        idx = [0, 10, 20]
        rows, cols = 54, 96
        u, v = np.meshgrid((np.arange(cols) + 0.5) * W / cols - 0.5, (np.arange(rows) + 0.5) * H / rows - 0.5)
        flat = np.full((rows, cols), 5.0)   # (each view sees a wall 5 m ahead)
        X2 = np.stack([(T[:, 20, 0] - K[2]) / K[0] * 5, (T[:, 20, 1] - K[3]) / K[1] * 5, np.full(200, 5.0)], 1) @ cams[20][:, :3].T + cams[20][:, 3]
        V[:, :20] = False
        ids, got = solve.da3_lift(T, V, 1.0, 1.0, K, W, H, idx, cams[idx], [flat, flat, flat])
        self.assertGreater(len(ids), 100)
        np.testing.assert_allclose(got, X2[ids], atol=1e-6)
        ids, _ = solve.da3_lift(T, V, 1.0, 1.0, K, W, H, idx, cams[idx], [flat])   # (an old export: view 0 only)
        self.assertEqual(len(ids), 0)
        # and the bundle adjustment's depth priors: every track seen on views 1 and 2, at their grid's depth
        pr = solve.da3_priors(T, V, 1.0, 1.0, W, H, idx, [flat, flat * 2, flat])
        self.assertEqual([p["f"] for p in pr], [20])   # (view 1, frame 10: nothing seen there)
        self.assertTrue(V[pr[0]["q"], 20].all())
        self.assertGreater(len(pr[0]["q"]), 0.9 * V[:, 20].sum())
        np.testing.assert_allclose(pr[0]["z"], 5.0)
        self.assertEqual(solve.da3_priors(T, V, 1.0, 1.0, W, H, idx, [flat]), [])

    def test_cloud(self):
        P = np.random.default_rng(0).uniform(1, 5, (90, 160, 3))
        P[:10] = np.nan
        img = np.zeros((360, 640, 3), np.uint8)
        img[:, 320:] = [255, 0, 0]
        pc = solve.cloud(np, P, img)
        self.assertEqual(len(pc), solve.MAX_CLOUD)
        self.assertTrue(all(len(p) == 6 and p[3] in (0, 255) for p in pc))
        self.assertLess(len(json.dumps(pc)), 150_000)


@unittest.skipUnless(cv2, "needs numpy and opencv")
class Floor(unittest.TestCase):
    def test_floor_under_the_camera(self):
        fl = solve.floor_from_grid(floor_grid())
        self.assertIsNotNone(fl)
        np.testing.assert_allclose(fl["n"], [0, -1, 0], atol=0.02)
        self.assertAlmostEqual(fl["d"], 1.5, delta=0.03)

    def test_no_floor(self):
        g = floor_grid()
        g["points"] = [list(np.array(p) * 4 / p[2]) for p in g["points"]]   # a wall 4 m ahead fills the picture
        self.assertIsNone(solve.floor_from_grid(g))
        g = floor_grid()
        g["points"] = [list(np.array(p) * [1, -1, 1]) for p in g["points"]]   # a ceiling: the camera is under it
        self.assertIsNone(solve.floor_from_grid(g))


@unittest.skipUnless(cv2, "needs numpy and opencv")
class Interp(unittest.TestCase):
    def test_four_views_to_ten_frames(self):
        idx = [0, 3, 6, 9]
        Rs = [rot(0, 0, 0), rot(10, 20, 0), rot(15, 40, 5), rot(5, 60, -10)]
        cams = np.array([np.concatenate([R, np.array([[i], [0.5 * i], [i * i]])], axis=1) for i, R in enumerate(Rs)])
        out = solve.interp_cams(idx, cams, 10)
        self.assertEqual(out.shape, (10, 3, 4))
        for j, i in enumerate(idx):
            np.testing.assert_allclose(out[i], cams[j], atol=1e-9)
        # frame 4: a third of the way from view 1 to view 2, along the shortest turn
        rv = cv2.Rodrigues(Rs[1].T @ Rs[2])[0]
        want = Rs[1] @ cv2.Rodrigues(rv / 3)[0]
        self.assertLess(angle(out[4][:, :3], want), 1e-4)
        np.testing.assert_allclose(out[4][:, 3], cams[1][:, 3] * 2 / 3 + cams[2][:, 3] / 3)

    def test_relative_to_first(self):
        X, cams, _, _ = scene()
        rel = solve.relative_to_first(np.array([geom.invert34(cams[5]) @ np.vstack([c, [0, 0, 0, 1]]) for c in cams]))
        # (expressed in camera 5's frame first, then back to camera 0's: the original path)
        np.testing.assert_allclose(rel, cams, atol=1e-9)


@unittest.skipUnless(cv2, "needs numpy and opencv")
class Geom(unittest.TestCase):
    def test_bilinear(self):
        yy, xx = np.mgrid[0:20, 0:30].astype(float)
        img = np.stack([xx, yy, 5 + 0.01 * xx], axis=-1)
        np.testing.assert_allclose(geom.bilinear(img, None, 3.25, 7.5), [3.25, 7.5, 5.0325])
        ok = np.ones((20, 30), bool)
        ok[8, 4] = False
        self.assertIsNone(geom.bilinear(img, ok, 3.25, 7.5))
        self.assertIsNone(geom.bilinear(img, None, 40, 2))
        img[..., 2][:, 4:] = 50   # a depth edge between x 3 and 4: the nearest, not a blend
        np.testing.assert_allclose(geom.bilinear(img, None, 3.25, 7.5)[2], 5.03)

    def test_invert34_round_trip(self):
        M = np.concatenate([rot(10, -30, 45), [[1], [2], [3]]], axis=1)
        inv = geom.invert34(M)
        np.testing.assert_allclose(geom.invert34(inv), M, atol=1e-12)
        np.testing.assert_allclose((np.vstack([inv, [0, 0, 0, 1]]) @ np.vstack([M, [0, 0, 0, 1]]))[:3], np.eye(3, 4), atol=1e-12)

    def test_intrinsics_in_pixels(self):
        fx, fy, cx, cy = geom.moge_K(np.array([[0.8, 0, 0.5], [0, 1.4, 0.5], [0, 0, 1]]), 640, 360)
        np.testing.assert_allclose((fx, fy, cx, cy), (512.0, 504.0, 319.5, 179.5))
        self.assertEqual(geom.da3_target_size(280, 504, 504), (280, 504))
        fx, _, cx, _ = geom.da3_K(np.array([[400, 0, 252], [0, 400, 140], [0, 0, 1]]), 280, 504, 504)
        self.assertEqual((fx, cx), (400.0, 251.5))

    def test_moge_export(self):
        X, _, T, _ = scene(noise=0)
        u, v = np.meshgrid(np.arange(W) + 0.0, np.arange(H) + 0.0)
        z = np.full((H, W), 4.0)
        pmap = np.stack([(u - K[2]) / K[0] * z, (v - K[3]) / K[1] * z, z], axis=-1)
        intr = np.array([[K[0] / W, 0, (K[2] + 0.5) / W], [0, K[1] / H, (K[3] + 0.5) / H], [0, 0, 1]])
        mask = np.ones((H, W), bool)
        mask[:10] = False
        ex = geom.moge_export(pmap, mask, intr, [[100.5, 200.25], [50, 3]], 16)
        np.testing.assert_allclose(ex["K"], K, atol=1e-3)
        np.testing.assert_allclose(ex["points"][0], [(100.5 - K[2]) / K[0] * 4, (200.25 - K[3]) / K[1] * 4, 4], atol=1e-4)
        self.assertIsNone(ex["points"][1])
        self.assertEqual((ex["grid"]["cols"], ex["grid"]["rows"]), (16, 9))
        json.dumps(ex)

    def test_da3_export(self):
        S = 3
        depth = np.full((S, 28, 50), 2.0)
        w2c = np.array([geom.invert34(np.concatenate([rot(0, 5 * i, 0), [[i], [0], [0]]], axis=1)) for i in range(S)])
        intr = np.tile(np.array([[40.0, 0, 25], [0, 40, 14], [0, 0, 1]]), (S, 1, 1))
        sky = np.zeros((S, 28, 50))
        sky[:, :5] = 1
        ex = geom.da3_export(depth, w2c, intr, 10, 50, sky=sky, conf=np.random.default_rng(0).uniform(1, 2, (S, 28, 50)))
        np.testing.assert_allclose(np.array(ex["cams"][2]).reshape(3, 4)[:, 3], [2, 0, 0], atol=1e-5)
        self.assertIsNone(ex["depth"]["values"][0])   # sky
        self.assertEqual(len(ex["K"]), S)
        self.assertEqual((ex["version"], len(ex["depths"])), (2, S))   # (every view's depth, coarser)
        self.assertIsNone(ex["depths"][1]["values"][0])   # (sky in every view)
        self.assertAlmostEqual(ex["depths"][1]["values"][-1], 2.0)
        json.dumps(ex)
        # DA3's confidence is long-tailed: the least confident fifth goes, not everything under a tenth of the range
        conf = np.broadcast_to(np.exp(8 * np.linspace(0, 1, 50)), (S, 28, 50))   # (smooth, as DA3's is)
        ex = geom.da3_export(depth, w2c, intr, 10, 50, conf=conf)
        kept = np.mean([v is not None for v in ex["depth"]["values"]])
        self.assertTrue(0.7 < kept < 0.9, kept)


def ba_scene(n_frames, n_pts, seed=1, noise=0.5):
    """A camera walking sideways and yawing (0.3° a frame at 60 frames) past n_pts points 3..8 m away, seen
    with noise px: (X, cams, T, V)."""
    rng = np.random.default_rng(seed)
    k = 60 / n_frames
    cams = np.array([np.concatenate([rot(0, 0.3 * i * k, 0), np.array([[0.01], [0], [0.005]]) * i * k], axis=1)
                     for i in range(n_frames)])
    X = in_view(n_pts, rng)
    T, V = np.zeros((n_pts, n_frames, 2)), np.zeros((n_pts, n_frames), bool)
    for f, c in enumerate(cams):
        Xc = (X - c[:, 3]) @ c[:, :3]
        uu, vv = K[0] * Xc[:, 0] / Xc[:, 2] + K[2], K[1] * Xc[:, 1] / Xc[:, 2] + K[3]
        T[:, f] = np.stack([uu, vv], 1) + rng.normal(0, noise, (n_pts, 2))
        V[:, f] = (Xc[:, 2] > 0.1) & (uu >= 0) & (uu < W) & (vv >= 0) & (vv < H)
    return X, cams, T, V


def depth_priors(X, cams, V, frames):
    """MoGe-like depth (exact) of the points seen on each of frames, as bundle_adjust's anchors."""
    out = []
    for f in frames:
        q = np.where(V[:, f])[0]
        out.append({"f": f, "q": q, "z": ((X[q] - cams[f][:, 3]) @ cams[f][:, :3])[:, 2]})
    return out


@unittest.skipUnless(cv2, "needs numpy and opencv")
class BundleAdjust(unittest.TestCase):
    def test_poses_and_scale_come_back(self):
        X, cams, T, V = ba_scene(60, 200)
        rng = np.random.default_rng(7)
        init = cams.copy()
        for f in range(1, 60):   # every pose 5 cm and 2° off, and the points 1.3x too far
            d, a = rng.normal(size=3), rng.normal(size=3)
            init[f][:, :3] = cv2.Rodrigues(a / np.linalg.norm(a) * math.radians(2))[0] @ cams[f][:, :3]
            init[f][:, 3] += d / np.linalg.norm(d) * 0.05
        got, Xg, info = solve.bundle_adjust(init, X * 1.3, T, V, K, 1.0, anchors=depth_priors(X, cams, V, (0, 30)))
        np.testing.assert_allclose(got[0], cams[0], atol=1e-12)   # (camera 0 is held)
        for f in range(60):
            self.assertLess(np.linalg.norm(got[f][:, 3] - cams[f][:, 3]), 0.01, f)
            self.assertLess(angle(got[f][:, :3], cams[f][:, :3]), 0.2, f)
        self.assertLess(abs(np.median(np.linalg.norm(Xg, axis=1) / np.linalg.norm(X, axis=1)) - 1), 0.02)
        self.assertLess(info["err"], 1.0)

    def test_tracks_without_3d_are_left_alone(self):
        X, cams, T, V = ba_scene(20, 60)
        Xn = X.copy()
        Xn[:10] = np.nan
        got, Xg, _ = solve.bundle_adjust(cams, Xn, T, V, K, 1.0, anchors=depth_priors(X, cams, V, (0,)))
        self.assertTrue(np.isnan(Xg[:10]).all())
        self.assertLess(np.abs(Xg[10:] - X[10:]).max(), 0.1)

    def test_sparsity(self):
        oc, op = np.array([0, 1, 2, 2]), np.array([0, 0, 1, 2])
        A = solve.ba_sparsity(3, 3, oc, op, pc=[0, 2], pp=[1, 2])
        self.assertEqual(A.shape, (2 * 4 + 2 + 3 * 1, 6 * 2 + 3 * 3))   # (camera 0 has no columns)
        D = A.toarray()
        np.testing.assert_array_equal(D[0:2, :12], 0)        # an observation in camera 0: its point only
        np.testing.assert_array_equal(D[0:2, 12:15], 1)
        np.testing.assert_array_equal(D[2:4, 0:6], 1)        # camera 1 (columns 0..5) and point 0
        np.testing.assert_array_equal(D[2:4, 6:12], 0)
        self.assertEqual(D[8].sum(), 3)                       # camera 0's depth prior: its point only
        self.assertEqual(D[9, 6:12].sum() + D[9, 12:].sum(), 6 + 3)
        np.testing.assert_array_equal(D[10:13, 0:3], 0)       # the motion prior: the centres (3..5) only
        np.testing.assert_array_equal(D[10:13, [3, 4, 5]], np.eye(3))

    def test_a_long_clip_is_quick(self):
        X, cams, T, V = ba_scene(360, 400)
        t = time.time()
        got, _, info = solve.bundle_adjust(cams, X * 1.1, T, V, K, 1.0, anchors=depth_priors(X, cams, V, (0, 180)))
        self.assertLess(time.time() - t, 10)
        self.assertLess(info["err"], 1.0)

    def test_solve_reports_it(self):
        X, cams, T, V = scene()
        got, q = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0)
        self.assertIsNotNone(q["ba_err"])
        self.assertLess(q["ba_err"], 0.5)
        for f in range(N):
            self.assertLess(np.linalg.norm(got[f][:, 3] - cams[f][:, 3]), 0.02, f)
        _, q = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0, ba=False)
        self.assertIsNone(q["ba_err"])

    def test_repeatable(self):
        X, cams, T, V = scene(noise=0.5)
        a, _ = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0)
        b, _ = solve.solve_pnp(T, V, X, np.arange(200), K, 1.0)
        np.testing.assert_array_equal(a, b)


@unittest.skipUnless(cv2 and subprocess.run(["which", "ffmpeg"], capture_output=True).returncode == 0, "needs opencv and ffmpeg")
class EndToEnd(unittest.TestCase):
    """solve(method="pnp") against a fake ComfyUI whose MoGe answers from the synthetic scene."""

    def test_pnp(self):
        # frame 0's points are all gone after frame 19 and new ones come from frame 6: the later MoGe anchors
        # carry the solve on (the fake MoGe answers from the true scene, in each anchor camera's frame)
        td = Path(tempfile.mkdtemp(prefix="deck-solve-"))
        src = td / "c.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=s={W}x{H}:r=24:d=2",
                        "-pix_fmt", "yuv420p", str(src)], check=True)
        out_dir, in_dir = td / "comfy" / "output", td / "comfy" / "input"
        X, cams, T, V = churn(plane=True, later_from_0=True)   # (on a sloping ground: frame 0's depth grid below)
        XA = np.concatenate([X, churn.later])
        frames = solve.choose_anchors(V, 24.0)
        rows = 54
        ground = {"cols": 96, "rows": rows, "points": [list(np.array([((c + 0.5) * W / 96 - 0.5 - K[2]) / K[0], ((r + 0.5) * H / rows - 0.5 - K[3]) / K[1], 1])
                                                            * plane_z((r + 0.5) * H / rows - 0.5)) for r in range(rows) for c in range(96)]}
        seen = {"inputs": [], "outs": []}

        class Fake:
            async def object_info(self):
                return {"DeckMoGeExport": {}, "MoGeInference": {},
                        "LoadMoGeModel": {"input": {"required": {"model_name": [["moge_2_vitl.safetensors", "moge_3_vitl_fp16.safetensors"]]}}}}

            async def upload_image(self, data, filename, subfolder=""):
                seen["png"] = data[:8]
                p = in_dir / subfolder / filename
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
                seen["inputs"].append(p)
                return f"{subfolder}/{filename}"

            async def queue(self, wf, preview=None):
                seen["wf"] = wf
                return {"prompt_id": "p1"}

            async def history(self, pid):
                wf, outs, self.payload = seen["wf"], {}, {}
                for i, f in enumerate(frames):
                    c = cams[f]
                    pts = []
                    for x, y in json.loads(wf[f"x{i}"]["inputs"]["points"]):   # the scene point that sits there
                        d = np.where(V[:, f], np.hypot(T[:, f, 0] - x, T[:, f, 1] - y), np.inf)
                        pts.append(list((XA[int(d.argmin())] - c[:, 3]) @ c[:, :3]) if d.min() < 0.05 else None)
                    if i == 0:
                        pts[0] = None   # (one with no depth)
                    name = f"moge_{i:05d}_.json"
                    grid = ground if i == 0 else {"cols": 96, "rows": rows, "points": [None] * (96 * rows)}   # (later: no depth grid)
                    self.payload[name] = json.dumps({"version": 1, "width": W, "height": H, "K": K, "points": pts, "grid": grid}).encode()
                    sub = wf[f"x{i}"]["inputs"]["filename_prefix"].rpartition("/")[0] + "/run-abc"
                    p = out_dir / sub / name
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_bytes(self.payload[name])
                    seen["outs"].append(p)
                    outs[f"x{i}"] = {"files": [{"filename": name, "subfolder": sub, "type": "output"}]}
                return {pid: {"status": {"status_str": "success"}, "outputs": outs}}

            async def view(self, filename, subfolder="", type_="output"):
                return self.payload[filename], "application/json"

            async def forget(self, pid):
                seen["forgot"] = pid

        def fake_analyse(**kw):
            self.assertTrue(kw["full"])
            return {"v": 1, "fps": 24.0, "size": [W, H], "start": 0.0, "n": N, "frames": [], "tracks": [], "lost": 0,
                    "_full": {"T": T.astype(np.float32), "V": V, "tw": W, "th": H}}

        with mock.patch.object(tracking, "comfy", Fake()), mock.patch.object(tracking, "analyse", side_effect=fake_analyse), \
                mock.patch.object(config, "COMFY_OUTPUT_DIR", out_dir), mock.patch.object(config, "COMFY_INPUT_DIR", in_dir), \
                mock.patch.object(config, "DATA_DIR", td):
            out_dir.mkdir(parents=True)
            r = asyncio.run(solve.solve(src, method="pnp", tracker="klt"))
        self.assertGreater(len(frames), 1)
        self.assertEqual(seen["wf"]["m"]["inputs"]["model_name"], "moge_3_vitl_fp16.safetensors")
        self.assertEqual(seen["png"], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(len(json.loads(seen["wf"]["x0"]["inputs"]["points"])), int(V[:, 0].sum()))
        # ComfyUI keeps nothing: the frames, the answers, their run folder and the history entry
        self.assertEqual(len(seen["inputs"]), len(frames))
        self.assertFalse(any(p.exists() for p in seen["inputs"] + seen["outs"]) or seen["outs"][0].parent.exists())
        self.assertEqual(seen.get("forgot"), "p1")
        self.assertFalse(list((td / "tmp" / "track").iterdir()))

        json.dumps(r)
        self.assertEqual((r["v"], r["method"], r["n"], r["size"], r["metric"]), (1, "pnp", N, [W, H], True))
        self.assertEqual(len(r["cams"]), N)
        self.assertEqual(r["cams"][0], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
        for f in (25, N - 1):
            got = np.array(r["cams"][f]).reshape(3, 4)
            self.assertLess(np.linalg.norm(got[:, 3] - cams[f][:, 3]), 0.03, f)
        self.assertTrue(0 < len(r["pts"]) <= 400)
        q = r["quality"]
        self.assertEqual((q["lost"], q["anchors"]), (0, len(frames)))
        self.assertLess(q["err"], 1)
        self.assertIsNotNone(r["floor"])
        self.assertAlmostEqual(q["drift"], np.median(np.linalg.norm(np.diff(cams[:, :, 3], axis=0), axis=1)) / r["floor"]["d"], delta=0.002)
        self.assertTrue(0 < len(r["cloud"]) <= 4000 and all(len(p) == 6 for p in r["cloud"]))
        self.assertLess(len(json.dumps(r["cloud"])), 150_000)
        self.assertGreaterEqual(r["cost"], 0)

    def test_da3(self):
        td = Path(tempfile.mkdtemp(prefix="deck-solve-"))
        src = td / "c.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=s={W}x{H}:r=24:d=2",
                        "-pix_fmt", "yuv420p", str(src)], check=True)
        X, cams, T, V = scene(plane=True)
        G = np.vstack([np.concatenate([rot(20, -50, 10), [[3], [1], [-2]]], axis=1), [0, 0, 0, 1]])   # DA3's own world
        wi, hi = 504, 280
        # (DA3 guesses each field of view on its own: on a portrait iPhone clip fx 3401 vs fy 4036. Pixels are
        # square, so the solve takes their geometric mean)
        Ki = [K[0] * wi / W * 1.2, K[1] * hi / H / 1.2, (K[2] + 0.5) * wi / W - 0.5, (K[3] + 0.5) * hi / H - 0.5]
        g = floor_grid(96)
        seen = {}

        class Fake:
            async def object_info(self):
                return {n: {} for n in ("DeckDA3Export", "DA3Inference", "VHS_LoadVideoPath")} | {
                    "LoadDA3Model": {"input": {"required": {"model_name": ["COMBO", {"options": ["depth_anything_3_small.safetensors"]}]}}}}

            async def queue(self, wf, preview=None):
                seen["wf"] = wf
                clip = Path(wf["1"]["inputs"]["video"])
                seen["clip"] = clip
                seen["frames"] = int(subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames,width,height",
                                                     "-of", "csv=p=0", str(clip)], capture_output=True, text=True).stdout.strip().split(",")[-1])
                return {"prompt_id": "p2"}

            async def history(self, pid):
                n = seen["frames"]
                idx = sorted({int(round(v)) for v in np.linspace(0, N - 1, n)})
                c2w = [(G @ np.vstack([cams[i], [0, 0, 0, 1]]))[:3] for i in idx]
                self.payload = json.dumps({"version": 1, "views": n, "width": wi, "height": hi, "K": [Ki] * n,
                                           "cams": [list(c.ravel()) for c in c2w],
                                           "depth": {"cols": g["cols"], "rows": g["rows"],   # (view 0's depth: the sloping ground)
                                                     "values": [float(plane_z((r + 0.5) * H / g["rows"] - 0.5))
                                                                for r in range(g["rows"]) for _ in range(g["cols"])]}}).encode()
                return {pid: {"status": {"status_str": "success"},
                              "outputs": {"4": {"files": [{"filename": "d.json", "subfolder": "", "type": "output"}]}}}}

            async def view(self, filename, subfolder="", type_="output"):
                return self.payload, "application/json"

            async def forget(self, pid):
                seen["forgot"] = pid

        def fake_analyse(**kw):
            return {"v": 1, "fps": 24.0, "size": [W, H], "start": 0.0, "n": N, "frames": [], "tracks": [], "lost": 0,
                    "_full": {"T": T.astype(np.float32), "V": V, "tw": W, "th": H}}

        with mock.patch.object(tracking, "comfy", Fake()), mock.patch.object(tracking, "analyse", side_effect=fake_analyse), \
                mock.patch.object(config, "DATA_DIR", td):
            r = asyncio.run(solve.solve(src, method="da3", views=10))
        ins = seen["wf"]["3"]["inputs"]
        self.assertEqual((ins["mode"], ins["mode.ref_view_strategy"], ins["mode.pose_method"]), ("multiview", "first", "cam_dec"))
        self.assertEqual(seen["frames"], 10)
        self.assertFalse(seen["clip"].exists())
        self.assertEqual(seen["forgot"], "p2")
        json.dumps(r)
        self.assertEqual((r["method"], r["metric"], len(r["cams"])), ("da3", False, N))
        np.testing.assert_allclose(r["K"], K, atol=0.01)
        for f in (0, 13, N - 1):   # (13 falls between views: interpolated, close to the true path)
            got = np.array(r["cams"][f]).reshape(3, 4)
            self.assertLess(np.linalg.norm(got[:, 3] - cams[f][:, 3]), 0.01 if f != 13 else 0.02)
            self.assertLess(angle(got[:, :3], cams[f][:, :3]), 0.05)
        self.assertIsNotNone(r["floor"])
        self.assertTrue(r["pts"])
        self.assertLess(r["quality"]["err"], 1)


@unittest.skipUnless(cv2 and subprocess.run(["which", "ffmpeg"], capture_output=True).returncode == 0, "needs opencv and ffmpeg")
class FullTracks(unittest.TestCase):
    def test_klt_keeps_every_track_when_asked(self):
        from test_tracking import N as TN, make_clip
        p = Path(tempfile.mkdtemp(prefix="deck-solve-")) / "pan.mp4"
        make_clip(p, pan=(3.0, 0.0))
        r = tracking.analyse(p, full=True)
        f = r["_full"]
        self.assertEqual(f["T"].shape[1:], (TN, 2))
        self.assertEqual(f["V"].shape, f["T"].shape[:2])
        both = f["V"][:, 0] & f["V"][:, -1]
        self.assertGreater(both.sum(), 20)
        np.testing.assert_allclose(np.median(f["T"][both, -1] - f["T"][both, 0], axis=0), [3.0 * (TN - 1), 0], atol=1.5)
        self.assertNotIn("_full", tracking.analyse(p))


class Route(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(main.app)

    def test_needs_comfyui(self):
        with mock.patch.object(tracking, "comfy", None):
            r = self.c.post("/api/track/solve", json={"src": {"media": "x.mp4"}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("ComfyUI isn't connected", r.json()["detail"])

    def test_checks_its_options(self):
        with mock.patch.object(tracking, "comfy", object()):
            for bad in ({"method": "sfm"}, {"tracker": "x"}, {"method": "da3", "views": 4}, {"model": "../x.safetensors"}):
                r = self.c.post("/api/track/solve", json={"src": {"media": "x.mp4"}, **bad})
                self.assertEqual(r.status_code, 400, bad)


if __name__ == "__main__":
    unittest.main()
