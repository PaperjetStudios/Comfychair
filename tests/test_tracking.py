"""Motion tracking recovers a known pan, turn and zoom from a synthetic clip."""
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

from app import config, imageprep, main, tracking  # noqa: E402

W, H, N = 480, 270, 30


def make_clip(path, pan=(0.0, 0.0), turn=0.0, zoom=1.0, square=False):
    """A noisy picture moved by pan px, turn degrees and zoom (all per frame) about the centre."""
    rng = np.random.default_rng(7)
    base = cv2.GaussianBlur(rng.integers(0, 255, (1400, 1800, 3), dtype=np.uint8), (0, 0), 2.5)
    base = cv2.normalize(base, None, 0, 255, cv2.NORM_MINMAX)
    patch = cv2.GaussianBlur(rng.integers(0, 255, (120, 120, 3), dtype=np.uint8), (0, 0), 2)
    tmp = Path(tempfile.mkdtemp())
    for i in range(N):
        # content point p lands at s R (p - c) + c + t, where c is the frame centre
        M = cv2.getRotationMatrix2D((W / 2, H / 2), -turn * i, zoom ** i)   # (cv2 turns counter-clockwise for positive angles)
        M[:, 2] += (pan[0] * i, pan[1] * i)
        shift = np.array([[1, 0, -(1800 - W) / 2], [0, 1, -(1400 - H) / 2], [0, 0, 1]])
        full = np.vstack([M, [0, 0, 1]]) @ shift
        fr = cv2.warpAffine(base, full[:2], (W, H), borderMode=cv2.BORDER_REFLECT)
        if square:
            x = 300 - i * 6
            fr[60:180, x:x + 120] = patch
        cv2.imwrite(str(tmp / f"{i:03d}.png"), fr)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", "24", "-i", str(tmp / "%03d.png"),
                    "-c:v", "libx264", "-crf", "10", "-pix_fmt", "yuv420p", str(path)], check=True)


@unittest.skipUnless(cv2 and imageprep.ffmpeg_available(), "needs numpy, opencv and ffmpeg")
class Track(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = Path(tempfile.mkdtemp())

    def clip(self, name, **kw):
        p = self.d / f"{name}.mp4"
        make_clip(p, **kw)
        return p

    def test_pan(self):
        r = tracking.analyse(self.clip("pan", pan=(2.0, -1.0)))
        last = r["frames"][-1]
        self.assertEqual(r["n"], N)
        self.assertEqual(r["size"], [W, H])
        self.assertAlmostEqual(last["tx"], 2.0 * (N - 1), delta=3)
        self.assertAlmostEqual(last["ty"], -1.0 * (N - 1), delta=3)
        self.assertAlmostEqual(last["rot"], 0, delta=0.5)
        self.assertAlmostEqual(last["scale"], 1, delta=0.01)
        self.assertTrue(r["tracks"])

    def test_turn_and_zoom(self):
        r = tracking.analyse(self.clip("tz", turn=0.4, zoom=1.004))
        last = r["frames"][-1]
        self.assertAlmostEqual(last["rot"], 0.4 * (N - 1), delta=0.8)
        self.assertAlmostEqual(last["scale"], 1.004 ** (N - 1), delta=0.02)
        self.assertAlmostEqual(last["tx"], 0, delta=3)

    def test_exclude_ignores_a_moving_square(self):
        p = self.clip("sq", pan=(1.5, 0.0), square=True)
        r = tracking.analyse(p, exclude=[0.2, 0.15, 0.8, 0.75])
        self.assertAlmostEqual(r["frames"][-1]["tx"], 1.5 * (N - 1), delta=3)
        self.assertAlmostEqual(r["frames"][-1]["ty"], 0, delta=3)

    def test_region_and_range(self):
        r = tracking.analyse(self.clip("rg", pan=(2.0, 0.0)), start=0.2, end=0.9, region=[0, 0, 0.5, 1])
        self.assertLess(r["n"], N)
        self.assertGreater(r["frames"][-1]["tx"], 20)
        for t in r["tracks"]:
            self.assertLessEqual(max(x for x, _ in t["p"]), 0.6)

    def test_atlas(self):
        out = self.d / "atlas.jpg"
        r = tracking.analyse(self.clip("at", pan=(1.0, 0.0)), atlas_path=out)
        a = r["atlas"]
        self.assertTrue(out.is_file())
        self.assertGreaterEqual(a["cols"] * a["rows"], a["count"])
        im = cv2.imread(str(out))
        self.assertEqual(im.shape[:2], (a["rows"] * a["tile"][1], a["cols"] * a["tile"][0]))


class Endpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(main.app)

    def test_missing_deps_is_a_clear_400(self):
        with mock.patch.object(tracking, "_libs", side_effect=tracking.MissingDeps("Motion tracking needs numpy and OpenCV: run `pip install numpy opencv-python-headless`")):
            r = self.c.post("/api/track", json={"src": {"media": "x.mp4"}})
        self.assertEqual(r.status_code, 400)
        self.assertIn("pip install", r.json()["detail"])

    @unittest.skipUnless(cv2 and imageprep.ffmpeg_available(), "needs numpy, opencv and ffmpeg")
    def test_job_round_trip(self):
        config.MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        make_clip(config.MEDIA_DIR / "trk_test.mp4", pan=(2.0, 0.0))
        r = self.c.post("/api/track", json={"src": {"media": "trk_test.mp4"}, "project_id": None})
        self.assertEqual(r.status_code, 200, r.text)
        jid = r.json()["job"]
        for _ in range(200):
            s = self.c.get(f"/api/track/{jid}").json()
            if s["state"] != "running":
                break
            time.sleep(0.1)
        self.assertEqual(s["state"], "done", s)
        self.assertAlmostEqual(s["result"]["frames"][-1]["tx"], 2.0 * (N - 1), delta=3)
        self.assertTrue(s["result"]["atlas"]["url"].endswith("backdrop.jpg"))
        self.assertEqual(self.c.get("/api/track/nope").status_code, 404)


class TapFit(unittest.TestCase):
    """_fit: transforms from given point tracks (the TAPNext++ path)."""

    def test_pan_and_hidden_points(self):
        cv2, np = tracking._libs()
        rng = np.random.default_rng(1)
        base = rng.uniform(50, 590, (40, 2)).astype(np.float32)
        P = np.stack([base + [3.0 * f, -1.0 * f] for f in range(10)], axis=1)   # (Q, N, 2): drifts right and up
        V = np.ones(P.shape[:2], bool)
        V[:5, 4:] = False                                                       # some points go out of sight
        P[:3, :, 0] += rng.uniform(-40, 40, (3, 10))                            # and a few wander (a moving subject)
        out, lost = tracking._fit(cv2, np, P, V, 2.0, 640, 360)
        self.assertEqual((len(out), lost), (10, 0))
        self.assertAlmostEqual(out[-1]["tx"], 27 * 2.0, delta=0.5)              # 9 frames x 3 px x (W / tw)
        self.assertAlmostEqual(out[-1]["ty"], -9 * 2.0, delta=0.5)
        self.assertAlmostEqual(out[-1]["scale"], 1.0, places=3)

    def test_too_few_points_holds_still(self):
        cv2, np = tracking._libs()
        P = np.zeros((4, 3, 2), np.float32)
        out, lost = tracking._fit(cv2, np, P, np.ones((4, 3), bool), 1.0, 100, 100)
        self.assertEqual(lost, 2)
        self.assertEqual(out[-1]["tx"], 0.0)

    def test_queries_skip_excluded(self):
        _, np = tracking._libs()
        allq = tracking._queries(np, 640, 360, None, None)
        some = tracking._queries(np, 640, 360, None, (0, 0, 0.5, 1))
        self.assertEqual(len(allq), tracking.TAP_GRID ** 2)
        self.assertTrue(all(q["x"] > 320 for q in some))


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(subprocess.run(["which", "ffmpeg"], capture_output=True).returncode == 0, "ffmpeg missing")
class TapJob(unittest.TestCase):
    """analyse_tapnext against a fake ComfyUI that 'tracks' the queued grid by shifting it 4 px a frame."""

    def test_round_trip(self):
        import asyncio
        import json
        td = Path(tempfile.mkdtemp(prefix="deck-tap-"))
        src = td / "c.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=320x180:r=10:d=1",
                        "-pix_fmt", "yuv420p", str(src)], check=True)
        seen = {}

        class Fake:
            async def object_info(self):
                return {"DeckTAPNextTrack": {}}

            async def queue(self, wf, preview=None):
                seen["wf"] = wf
                self.clip_exists = Path(wf["1"]["inputs"]["video"]).is_file()
                return {"prompt_id": "p1"}

            async def history(self, pid):
                pts = json.loads(seen["wf"]["2"]["inputs"]["points"])
                tracks = [[[p["x"] + 4 * f, p["y"], 1] for f in range(10)] for p in pts]
                self.payload = json.dumps({"tracks": tracks}).encode()
                return {pid: {"status": {"status_str": "success"},
                              "outputs": {"2": {"files": [{"filename": "t.json", "subfolder": "", "type": "output"}]}}}}

            async def view(self, filename, subfolder="", type_="output"):
                return self.payload, "application/json"

            async def forget(self, pid):   # (the run leaves ComfyUI's history: storage.py)
                seen["forgot"] = pid

        fake = Fake()
        with mock.patch.object(tracking, "comfy", fake), mock.patch.object(tracking.config, "DATA_DIR", td):
            r = asyncio.run(tracking.analyse_tapnext(src, atlas_path=td / "a.jpg"))
        self.assertTrue(fake.clip_exists)
        self.assertEqual(seen.get("forgot"), "p1")
        self.assertFalse(list((td / "tmp" / "track").glob("*.mp4")))   # the cut clip is cleaned up
        self.assertEqual((r["method"], r["n"], r["lost"]), ("tapnext", 10, 0))
        self.assertAlmostEqual(r["frames"][-1]["tx"], 36.0, delta=0.5)   # 9 x 4 px at full size (320 wide = analysis width)
        self.assertTrue(r["tracks"] and r["atlas"]["count"] >= 1)
