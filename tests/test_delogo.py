"""Remove watermark (app/delogo.py): boxes to crops, the ProPainter workflow, ffmpeg's delogo and Find.
Run: .venv/bin/python -m unittest discover tests"""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

delogo = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global delogo
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from app import delogo as d
    delogo = d


HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def marked_clip(path: Path, still: bool = False):
    """3 s of moving noise (or a flat grey frame) with a white mark stuck in the top-right corner."""
    src = "color=c=gray:s=640x360:d=3:r=24" if still else "nullsrc=s=640x360:d=3:r=24,geq=random(1)*255:128:128"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", src, "-vf",
                    "drawbox=x=520:y=20:w=90:h=40:color=white:t=fill,drawbox=x=535:y=30:w=60:h=20:color=black:t=fill,format=yuv420p",
                    "-c:v", "libx264", "-crf", "12", str(path)], check=True)
    return path


class Boxes(unittest.TestCase):
    def test_fractions_to_pixels(self):
        self.assertEqual(delogo.boxes_px([{"x": 0.5, "y": 0.25, "w": 0.25, "h": 0.5}], 1920, 1080), [(960, 270, 1440, 810)])
        self.assertEqual(delogo.boxes_px([{"x": 0.9, "y": 0.9, "w": 0.5, "h": 0.5}], 100, 100), [(90, 90, 100, 100)])   # kept inside
        self.assertEqual(delogo.boxes_px([{"x": 0.5, "y": 0.5, "w": 0, "h": 0.1}], 100, 100), [])
        with self.assertRaises(ValueError):
            delogo.boxes_px([{"x": 0.5}], 100, 100)

    def test_regions_cover_the_boxes_on_the_grid(self):
        for rect in [(1800, 20, 1910, 70), (0, 0, 50, 30), (900, 1000, 1000, 1078)]:
            (r,) = delogo.regions([rect], 1918, 1080)
            self.assertEqual((r["w"] % 8, r["h"] % 8), (0, 0))
            self.assertLessEqual(r["x"], rect[0]); self.assertLessEqual(r["y"], rect[1])
            self.assertGreaterEqual(r["x"] + r["w"], rect[2]); self.assertGreaterEqual(r["y"] + r["h"], rect[3])
            self.assertLessEqual(r["x"] + r["w"], 1918); self.assertLessEqual(r["y"] + r["h"], 1080)

    def test_near_boxes_share_a_crop_far_ones_dont(self):
        near = delogo.regions([(1700, 20, 1760, 60), (1780, 20, 1900, 60)], 1920, 1080)
        self.assertEqual(len(near), 1)
        self.assertEqual(len(near[0]["boxes"]), 2)
        far = delogo.regions([(20, 20, 120, 60), (1780, 1000, 1900, 1060)], 1920, 1080)
        self.assertEqual(len(far), 2)

    def test_big_crop_runs_smaller(self):
        (r,) = delogo.regions([(100, 100, 1800, 1000)], 1920, 1080)
        self.assertLessEqual(r["pw"] * r["ph"], delogo.MAX_AREA)
        self.assertEqual((r["pw"] % 8, r["ph"] % 8), (0, 0))
        (s,) = delogo.regions([(20, 20, 120, 60)], 1920, 1080)
        self.assertEqual((s["pw"], s["ph"]), (s["w"], s["h"]))   # small: its own resolution


class Workflow(unittest.TestCase):
    def test_graph(self):
        wf = delogo.build("/clip.mp4", 1920, 1080, 30, 90, [(20, 20, 120, 60), (1780, 1000, 1900, 1060)], "comfydeck/x/delogo")
        classes = [n["class_type"] for n in wf.values()]
        self.assertEqual(classes.count("ProPainterInpaint"), 2)
        self.assertEqual(wf["src"]["inputs"]["frame_load_cap"], 90)
        self.assertEqual(wf["save"]["inputs"]["frame_rate"], 30)
        self.assertEqual(wf["save"]["inputs"]["images"], ["paste1", 0])   # the pastes chain over the frames
        self.assertEqual(wf["paste1"]["inputs"]["destination"], ["paste0", 0])
        self.assertEqual(wf["paste0"]["inputs"]["destination"], ["src", 0])
        for nid, n in wf.items():   # every link points at a node in the graph
            for v in n["inputs"].values():
                if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                    self.assertIn(v[0], wf, f"{nid} -> {v}")


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg")
class Clips(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="deck-delogo-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_fast_keeps_size_and_length(self):
        src = marked_clip(self.tmp / "m.mp4")
        got = delogo.fast(src, self.tmp / "out.mp4", [(515, 15, 615, 65)])
        self.assertEqual((got["width"], got["height"]), (640, 360))
        self.assertAlmostEqual(got["duration"], 3, delta=0.15)
        with self.assertRaises(ValueError):
            delogo.fast(src, self.tmp / "out2.mp4", [])

    def test_find_the_stuck_mark(self):
        boxes = delogo.find_boxes(marked_clip(self.tmp / "m.mp4"))
        self.assertTrue(boxes)
        b = boxes[0]
        cx, cy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
        self.assertAlmostEqual(cx, 565 / 640, delta=0.06)
        self.assertAlmostEqual(cy, 40 / 360, delta=0.08)

    def test_still_shot_finds_nothing(self):
        self.assertEqual(delogo.find_boxes(marked_clip(self.tmp / "s.mp4", still=True)), [])


if __name__ == "__main__":
    unittest.main()
