"""Video input trim/crop: validation, loader mapping, ffmpeg command, cache key, real output of a tiny clip."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app import config, videoedit, videoprep as vp

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))
INFO = {"width": 640, "height": 360, "duration": 4.0, "fps": 25.0, "video": True, "audio": True}


class Params(unittest.TestCase):
    def test_trim(self):
        self.assertIsNone(vp.norm_trim(None, 4))
        self.assertIsNone(vp.norm_trim({"start": 0, "len": 4}, 4))          # the whole clip
        self.assertEqual(vp.norm_trim({"start": 1, "len": 1.5}, 4), (1.0, 1.5))
        self.assertEqual(vp.norm_trim({"start": 3, "len": 5}, 4), (3.0, 1.0))  # clamped to the clip
        self.assertEqual(vp.norm_trim({"start": 1}, 4), (1.0, 3.0))
        for bad in ({"start": -1, "len": 1}, {"start": 1, "len": 0}, {"start": 4, "len": 1}, {"start": "x"}, {"start": float("nan")}):
            with self.assertRaises(ValueError, msg=bad):
                vp.norm_trim(bad, 4)

    def test_crop(self):
        self.assertIsNone(vp.norm_crop({"x": 0, "y": 0, "w": 1, "h": 1}, 640, 360))
        self.assertEqual(vp.norm_crop({"x": 0, "y": 0, "w": 0.5, "h": 1}, 640, 360), (0, 0, 320, 360))
        x, y, w, h = vp.norm_crop({"x": 0.1, "y": 0.1, "w": 0.333, "h": 0.333}, 641, 361)   # odd source: even sizes
        self.assertTrue(w % 2 == 0 and h % 2 == 0 and x + w <= 641 and y + h <= 361)
        for bad in ({"x": 0.6, "y": 0, "w": 0.6, "h": 1}, {"x": 0, "y": 0, "w": 0, "h": 1}, {"x": 0}, {"x": 0, "y": 0, "w": "a", "h": 1}):
            with self.assertRaises(ValueError, msg=bad):
                vp.norm_crop(bad, 640, 360)

    def test_cmd(self):
        c = vp.build_cmd(Path("in.mp4"), Path("out.mp4"), INFO, (1.0, 1.5), (0, 0, 320, 360))
        self.assertEqual(c[c.index("-ss") + 1], "1.000")
        self.assertEqual(c[c.index("-t") + 1], "1.500")
        self.assertEqual(c[c.index("-vf") + 1], "crop=320:360:0:0")
        self.assertIn("aac", c)
        self.assertLess(c.index("-i"), c.index("-ss"))   # after -i: frame-accurate
        c = vp.build_cmd(Path("in.mp4"), Path("out.mp4"), {**INFO, "audio": False}, None, (0, 0, 2, 2))
        self.assertIn("-an", c)
        self.assertNotIn("-ss", c)

    def test_loader(self):
        base = {"force_rate": 24, "frame_load_cap": 0, "skip_first_frames": 0, "select_every_nth": 1}
        self.assertEqual(vp.loader_trim(INFO, (1.0, 2.5), base), {"skip_first_frames": 24, "frame_load_cap": 60})
        self.assertEqual(vp.loader_trim(INFO, (1.0, None), base), {"skip_first_frames": 24})
        # force_rate 0: the clip's own rate (25 fps)
        self.assertEqual(vp.loader_trim(INFO, (1.0, 2.0), {**base, "force_rate": 0}), {"skip_first_frames": 25, "frame_load_cap": 50})
        self.assertEqual(vp.loader_trim(INFO, (0.0, 2.0), {**base, "select_every_nth": 2}), {"skip_first_frames": 0, "frame_load_cap": 24})
        # the user's own skip/cap stack
        self.assertEqual(vp.loader_trim(INFO, (1.0, 2.0), {**base, "skip_first_frames": 10, "frame_load_cap": 20}),
                         {"skip_first_frames": 34, "frame_load_cap": 20})
        self.assertIsNone(vp.loader_trim(INFO, (1.0, 2.0), {"force_rate": 24}))                 # inputs not there
        self.assertIsNone(vp.loader_trim(INFO, (1.0, 2.0), {**base, "force_rate": ["3", 0]}))   # wired from another node


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg")
class Real(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.clip = cls.tmp / "src.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=4",
                        "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", str(cls.clip)], check=True)
        cls.patch = mock.patch.object(config, "VIDEOPREP_DIR", cls.tmp / "prep")
        cls.patch.start()
        (cls.tmp / "prep").mkdir()

    @classmethod
    def tearDownClass(cls):
        cls.patch.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_trim_crop_output(self):
        r = vp.prep(self.clip, {"start": 1.0, "len": 1.5}, {"x": 0, "y": 0, "w": 0.5, "h": 1})
        self.assertFalse(r["cached"])
        self.assertEqual((r["width"], r["height"]), (160, 180))
        self.assertAlmostEqual(r["duration"], 1.5, delta=0.1)
        self.assertTrue(videoedit.probe(r["path"])["audio"])           # sound kept
        again = vp.prep(self.clip, {"start": 1.0, "len": 1.5}, {"x": 0, "y": 0, "w": 0.5, "h": 1})
        self.assertTrue(again["cached"])
        self.assertEqual(again["path"], r["path"])
        other = vp.prep(self.clip, {"start": 1.0, "len": 1.0}, {"x": 0, "y": 0, "w": 0.5, "h": 1})
        self.assertNotEqual(other["path"], r["path"])                   # other params, other file

    def test_plan(self):
        base = {"force_rate": 25, "frame_load_cap": 0, "skip_first_frames": 0, "select_every_nth": 1}
        p = vp.plan(self.clip, {"start": 1, "len": 2}, None, base)       # trim only: the loader does it
        self.assertEqual((p["path"], p["inputs"]), (self.clip, {"skip_first_frames": 25, "frame_load_cap": 50}))
        p = vp.plan(self.clip, {"start": 1, "len": 2}, None, {"force_rate": 25})   # no inputs: ffmpeg trims
        self.assertNotEqual(p["path"], self.clip)
        self.assertAlmostEqual(videoedit.probe(p["path"])["duration"], 2.0, delta=0.1)
        p = vp.plan(self.clip, None, {"x": 0.5, "y": 0, "w": 0.5, "h": 1}, base)    # crop: ffmpeg, whole length
        self.assertEqual(p["inputs"], {})
        self.assertAlmostEqual(videoedit.probe(p["path"])["duration"], 4.0, delta=0.1)
        self.assertEqual(vp.plan(self.clip, None, None, base), {"path": self.clip, "inputs": {}})

    def test_prune(self):
        old = config.VIDEOPREP_DIR / "vprep_old.mp4"
        old.write_bytes(b"x")
        import os, time
        os.utime(old, (time.time() - 40 * 86400,) * 2)
        vp.prune()
        self.assertFalse(old.exists())


if __name__ == "__main__":
    unittest.main()
