"""Stabilising: the warp maths, the zoom that hides the edges, and a shaky clip that comes out still."""
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
os.environ.setdefault("DECK_COMFY_DIR", "")

try:
    import cv2
    import numpy as np
except ImportError:
    cv2 = None

from app import imageprep  # noqa: E402

HAVE = bool(cv2) and imageprep.ffmpeg_available()

if HAVE:
    from app import stabilise, tracking, videoedit  # noqa: E402
    from tests.test_tracking import H, N, W, make_clip  # noqa: E402


@unittest.skipUnless(HAVE, "needs numpy, opencv and ffmpeg")
class Maths(unittest.TestCase):
    def test_similarity_matches_make_clip(self):
        # make_clip moves content by getRotationMatrix2D(c, -turn*i, zoom**i) plus pan*i
        turn, zoom, pan, i = 0.7, 1.01, (3.0, -2.0), 5
        M = cv2.getRotationMatrix2D((W / 2, H / 2), -turn * i, zoom ** i)
        M[:, 2] += (pan[0] * i, pan[1] * i)
        # the track reports where the centre went, its turn and scale
        S = stabilise.similarity({"tx": pan[0] * i, "ty": pan[1] * i, "rot": turn * i, "scale": zoom ** i}, W, H)
        np.testing.assert_allclose(S[:2], M, atol=1e-9)

    def test_path_lock_is_identity(self):
        fr = [{"tx": i * 2.0, "ty": -i, "rot": 0.3 * i, "scale": 1 + 0.01 * i} for i in range(10)]
        for t in stabilise.path(fr, 2, "lock"):
            self.assertEqual(t, {"tx": 0.0, "ty": 0.0, "rot": 0.0, "scale": 1.0})
        for w in stabilise.corrections(fr, W, H, mode="lock"):
            self.assertEqual(w.shape, (2, 3))
        # the first frame needs no correction; later ones undo their motion
        np.testing.assert_allclose(stabilise.corrections(fr, W, H, mode="lock")[0], [[1, 0, 0], [0, 1, 0]], atol=1e-9)

    def test_path_smooth_flattens_noise(self):
        fr = [{"tx": 5.0 * (-1) ** i, "ty": 0.0, "rot": 0.0, "scale": 1.0} for i in range(30)]
        sm = stabilise.path(fr, 3, "smooth")
        self.assertLess(max(abs(t["tx"]) for t in sm[5:-5]), 0.5)
        self.assertEqual(len(sm), 30)

    def test_no_roll_keeps_the_turn(self):
        fr = [{"tx": 1.0 * i, "ty": 0.0, "rot": 0.5 * i, "scale": 1.0} for i in range(10)]
        for mode in ("lock", "smooth"):
            sm = stabilise.path(fr, 2, mode, roll=False)
            np.testing.assert_allclose([t["rot"] for t in sm], [f["rot"] for f in fr], atol=1e-9)
        self.assertEqual(stabilise.path(fr, 2, "lock")[9]["rot"], 0.0)

    def test_fit_zoom(self):
        ident = np.array([[1, 0, 0], [0, 1, 0]], float)
        self.assertAlmostEqual(stabilise.fit_zoom([ident], W, H), 1.0)
        down = np.array([[1, 0, 0], [0, 1, 10]], float)    # the picture moved down 10 px: the top 10 rows are empty
        self.assertAlmostEqual(stabilise.fit_zoom([ident, down], W, H), (H / 2) / (H / 2 - 10), places=6)
        self.assertAlmostEqual(stabilise.fit_zoom([down], W, H), 1 + 2 * 10 / H, delta=0.01)
        right = np.array([[1, 0, 10], [0, 1, 0]], float)
        self.assertAlmostEqual(stabilise.fit_zoom([right], W, H), (W / 2) / (W / 2 - 10), places=6)
        far = np.array([[1, 0, 200], [0, 1, 0]], float)
        self.assertEqual(stabilise.fit_zoom([far], W, H, cap=1.3), 1.3)
        turned = cv2.getRotationMatrix2D((W / 2, H / 2), 5, 1)
        z = stabilise.fit_zoom([turned], W, H)
        self.assertTrue(1.05 < z < 1.3, z)


@unittest.skipUnless(HAVE, "needs numpy, opencv and ffmpeg")
class Render(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.d = Path(tempfile.mkdtemp(prefix="deck-stab-"))
        cls.src = cls.d / "shaky.mp4"
        make_clip(cls.src, pan=(2.0, 1.0), turn=0.3)
        cls.track = tracking.analyse(cls.src)

    def test_lock_holds_still(self):
        out = self.d / "locked.mp4"
        r = stabilise.render(self.src, out, self.track, 0, None, mode="lock")
        self.assertEqual((r["width"], r["height"]), (W, H))
        self.assertGreater(r["zoom"], 1.0)
        after = tracking.analyse(out)
        self.assertEqual(after["n"], N)
        for f in after["frames"]:
            self.assertLess(abs(f["tx"]), 1.5, f)
            self.assertLess(abs(f["ty"]), 1.5, f)
        self.assertLess(abs(after["frames"][-1]["rot"]), 0.3)

    def test_smooth_keeps_every_frame(self):
        out = self.d / "smooth.mp4"
        r = stabilise.render(self.src, out, self.track, 0, None, sigma=3, mode="smooth", zoom="none")
        self.assertEqual(r["zoom"], 1.0)
        info = videoedit.probe(out)
        self.assertEqual(round(info["duration"] * info["fps"]), N)
        self.assertFalse(info["audio"])

    def test_sound_is_kept(self):
        withsound = self.d / "sound.mp4"
        import subprocess
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(self.src), "-f", "lavfi", "-i", "sine=f=440:d=2",
                        "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", str(withsound)], check=True)
        out = self.d / "sound_out.mp4"
        stabilise.render(withsound, out, self.track, 0, None, zoom=1.1)
        info = videoedit.probe(out)
        self.assertTrue(info["audio"])
        self.assertAlmostEqual(info["duration"], N / 24, delta=0.15)


@unittest.skipUnless(HAVE, "needs numpy, opencv and ffmpeg")
class Endpoint(unittest.TestCase):
    def test_round_trip(self):
        from fastapi.testclient import TestClient
        from app import config, db, main
        c = TestClient(main.app)
        config.MEDIA_DIR.mkdir(parents=True, exist_ok=True)
        src = config.MEDIA_DIR / "stab_test.mp4"
        make_clip(src, pan=(1.0, 0.5))
        track = tracking.analyse(src)
        body = {"src": {"media": "stab_test.mp4"}, "project_id": None, "start": 0, "track": track, "mode": "lock"}
        self.assertEqual(c.post("/api/video/stabilise", json={**body, "sigma": 99}).status_code, 400)
        self.assertEqual(c.post("/api/video/stabilise", json={**body, "zoom": 9}).status_code, 400)
        self.assertEqual(c.post("/api/video/stabilise", json={**body, "mode": "wobble"}).status_code, 400)
        self.assertEqual(c.post("/api/video/stabilise", json={**body, "track": {}}).status_code, 400)
        r = c.post("/api/video/stabilise", json=body)
        self.assertEqual(r.status_code, 200, r.text)
        g = r.json()
        self.assertEqual((g["template"], g["status"]), ("stabilise", "done"))
        self.assertEqual(g["params"]["mode"], "lock")
        out = config.PROJECTS_DIR / g["outputs"][0]["path"]
        self.assertTrue(out.is_file() and out.name.endswith("stable.mp4"))
        self.assertEqual(db.get_generation(g["id"])["status"], "done")


if __name__ == "__main__":
    unittest.main()
