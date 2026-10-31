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


def scene(noise=0.1, seed=3):
    """200 points 3..8 m in front of camera 0 and a 40-frame camera path (camera-to-world): the points'
    2D tracks (Q, N, 2) and where each is seen (inside the picture)."""
    rng = np.random.default_rng(seed)
    u, v, z = rng.uniform(10, W - 10, 200), rng.uniform(10, H - 10, 200), rng.uniform(3, 8, 200)
    X = np.stack([(u - K[2]) / K[0] * z, (v - K[3]) / K[1] * z, z], axis=1)
    cams = []
    for i in range(N):
        R = rot(0.1 * i, 0.4 * i, 0.05 * i)
        t = np.array([0.02 * i, -0.004 * i, 0.03 * i])
        cams.append(np.concatenate([R, t[:, None]], axis=1))
    T, V = np.zeros((200, N, 2)), np.zeros((200, N), bool)
    for f, c in enumerate(cams):
        Xc = (X - c[:, 3]) @ c[:, :3]
        uu, vv = K[0] * Xc[:, 0] / Xc[:, 2] + K[2], K[1] * Xc[:, 1] / Xc[:, 2] + K[3]
        T[:, f] = np.stack([uu, vv], 1) + (rng.normal(0, noise, (200, 2)) if f else 0)
        V[:, f] = (Xc[:, 2] > 0.1) & (uu >= 0) & (uu < W) & (vv >= 0) & (vv < H)
    return X, np.array(cams), T, V


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
        np.testing.assert_allclose(got[22], got[19])
        self.assertLess(np.linalg.norm(got[30][:, 3] - cams[30][:, 3]), 0.02)   # and picks up again

    def test_analysis_scale(self):
        X, cams, T, V = scene(noise=0)
        k = W / 320
        got, _ = solve.solve_pnp((T + 0.5) / k - 0.5, V, X, np.arange(200), K, k)
        self.assertLess(np.linalg.norm(got[-1][:, 3] - cams[-1][:, 3]), 0.02)

    def test_lift(self):
        ids, X = solve.lift([[1, 2], [3, 4], [5, 6]], {"points": [[0, 0, 2], None, [1, 1, 3]]})
        self.assertEqual(list(ids), [0, 2])
        self.assertEqual(X.shape, (2, 3))


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
        json.dumps(ex)


@unittest.skipUnless(cv2 and subprocess.run(["which", "ffmpeg"], capture_output=True).returncode == 0, "needs opencv and ffmpeg")
class EndToEnd(unittest.TestCase):
    """solve(method="pnp") against a fake ComfyUI whose MoGe answers from the synthetic scene."""

    def test_pnp(self):
        td = Path(tempfile.mkdtemp(prefix="deck-solve-"))
        src = td / "c.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=s={W}x{H}:r=24:d=2",
                        "-pix_fmt", "yuv420p", str(src)], check=True)
        out_dir, in_dir = td / "comfy" / "output", td / "comfy" / "input"
        X, cams, T, V = scene()
        V[150:, 0] = False   # (some points start later: they have no 3D)
        seen = {}

        class Fake:
            async def object_info(self):
                return {"DeckMoGeExport": {}, "MoGeInference": {},
                        "LoadMoGeModel": {"input": {"required": {"model_name": [["moge_2_vitl.safetensors", "moge_3_vitl_fp16.safetensors"]]}}}}

            async def upload_image(self, data, filename, subfolder=""):
                seen["png"] = data[:8]
                p = in_dir / subfolder / filename
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
                seen["input"] = p
                return f"{subfolder}/{filename}"

            async def queue(self, wf, preview=None):
                seen["wf"] = wf
                return {"prompt_id": "p1"}

            async def history(self, pid):
                q = json.loads(seen["wf"]["4"]["inputs"]["points"])
                pts = []
                for x, y in q:   # the scene point that sits there in frame 0
                    d = np.hypot(T[:, 0, 0] - x, T[:, 0, 1] - y)
                    pts.append(list(X[int(d.argmin())]) if d.min() < 0.05 else None)
                pts[0] = None   # (one with no depth)
                self.payload = json.dumps({"version": 1, "width": W, "height": H, "K": K, "points": pts, "grid": floor_grid()}).encode()
                sub = seen["wf"]["4"]["inputs"]["filename_prefix"].rpartition("/")[0] + "/run-abc"
                f = out_dir / sub / "moge_00001_.json"
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_bytes(self.payload)
                seen["out"] = f
                return {pid: {"status": {"status_str": "success"},
                              "outputs": {"4": {"files": [{"filename": f.name, "subfolder": sub, "type": "output"}]}}}}

            async def view(self, filename, subfolder="", type_="output"):
                return self.payload, "application/json"

            async def forget(self, pid):
                seen["forgot"] = pid

        def fake_analyse(**kw):
            self.assertTrue(kw["full"])
            return {"v": 1, "fps": 24.0, "size": [W, H], "start": 0.0, "n": N, "frames": [], "tracks": [], "lost": 0,
                    "_full": {"T": T.astype(np.float32), "V": V, "tw": W, "th": H}}

        with mock.patch.object(tracking, "comfy", Fake()), mock.patch.object(tracking, "analyse", side_effect=fake_analyse), \
                mock.patch.object(config, "COMFY_OUTPUT_DIR", out_dir), mock.patch.object(config, "COMFY_INPUT_DIR", in_dir):
            out_dir.mkdir(parents=True)
            r = asyncio.run(solve.solve(src, method="pnp", tracker="klt"))
        self.assertEqual(seen["wf"]["2"]["inputs"]["model_name"], "moge_3_vitl_fp16.safetensors")
        self.assertEqual(seen["png"], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(len(json.loads(seen["wf"]["4"]["inputs"]["points"])), 150)
        # ComfyUI keeps nothing: the frame, the answer, its run folder and the history entry
        self.assertFalse(seen["input"].exists())
        self.assertFalse(seen["out"].exists() or seen["out"].parent.exists())
        self.assertEqual(seen.get("forgot"), "p1")

        json.dumps(r)
        self.assertEqual((r["v"], r["method"], r["n"], r["size"], r["metric"]), (1, "pnp", N, [W, H], True))
        self.assertEqual(len(r["cams"]), N)
        self.assertEqual(r["cams"][0], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
        last = np.array(r["cams"][-1]).reshape(3, 4)
        self.assertLess(np.linalg.norm(last[:, 3] - cams[-1][:, 3]), 0.02)
        self.assertTrue(0 < len(r["pts"]) <= 400)
        self.assertEqual(r["quality"]["used"], 149)
        self.assertLess(r["quality"]["err"], 1)
        np.testing.assert_allclose(r["floor"]["n"], [0, -1, 0], atol=0.02)
        self.assertEqual(len(r["K"]), 4)
        self.assertGreaterEqual(r["cost"], 0)


    def test_da3(self):
        td = Path(tempfile.mkdtemp(prefix="deck-solve-"))
        src = td / "c.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=s={W}x{H}:r=24:d=2",
                        "-pix_fmt", "yuv420p", str(src)], check=True)
        X, cams, T, V = scene()
        G = np.vstack([np.concatenate([rot(20, -50, 10), [[3], [1], [-2]]], axis=1), [0, 0, 0, 1]])   # DA3's own world
        wi, hi = 504, 280
        Ki = [K[0] * wi / W, K[1] * hi / H, (K[2] + 0.5) * wi / W - 0.5, (K[3] + 0.5) * hi / H - 0.5]
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
                                           "depth": {"cols": g["cols"], "rows": g["rows"], "values": [p[2] for p in g["points"]]}}).encode()
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
        np.testing.assert_allclose(r["floor"]["n"], [0, -1, 0], atol=0.02)
        self.assertTrue(r["pts"])


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
