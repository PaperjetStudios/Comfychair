"""Refine matte (videoedit.matte_filters / refine_matte): combining two mattes, growing, shrinking, edges.
Run: .venv/bin/python -m unittest discover tests"""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

videoedit = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global videoedit
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from app import videoedit as v
    videoedit = v


HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def box_matte(path: Path, size: int, box: tuple[int, int, int, int]):
    x, y, w, h = box
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c=black:s={size}x{size}:d=1:r=24",
                    "-vf", f"drawbox=x={x}:y={y}:w={w}:h={h}:color=white:t=fill", "-c:v", "libx264", "-crf", "0",
                    "-pix_fmt", "yuv420p", str(path)], check=True)
    return path


def frame(path: Path) -> tuple[bytes, int]:
    size = int(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width",
                               "-of", "csv=p=0", str(path)], capture_output=True, text=True).stdout)
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         capture_output=True, check=True).stdout
    return raw, size


def at(img, x, y):
    raw, w = img
    return raw[y * w + x]


class Filters(unittest.TestCase):
    def test_order_and_modes(self):
        fc = videoedit.matte_filters("subtract", grow=-2, close=1, smooth=3, feather=4, low=0.2, high=0.8, invert=True)
        self.assertIn("blend=all_mode=subtract", fc)
        self.assertIn("scale2ref", fc)
        chain = fc.split("[c]")[-1]
        order = [chain.index(x) for x in ("dilation", "erosion", "tmix=frames=3", "lutyuv", "gblur=sigma=2.00", "negate")]
        self.assertEqual(order, sorted(order))
        self.assertEqual(chain.count("erosion"), 3)   # close 1 (dilate, erode) then grow -2

    def test_one_matte_has_no_blend(self):
        fc = videoedit.matte_filters(None, grow=2)
        self.assertNotIn("blend", fc)
        self.assertEqual(fc.count("dilation"), 2)
        with self.assertRaises(ValueError):
            videoedit.matte_filters("xor")


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")
class Real(unittest.TestCase):
    def setUp(self):
        self.td = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.td)
        self.a = box_matte(self.td / "a.mp4", 64, (8, 8, 20, 20))       # top left
        self.b = box_matte(self.td / "b.mp4", 128, (80, 80, 40, 40))    # bottom right, at twice the size

    def test_union_intersect_subtract(self):
        u = frame(self.td / "u.mp4") if videoedit.refine_matte(self.a, self.td / "u.mp4", self.b, combine="union") else None
        self.assertGreater(at(u, 15, 15), 200)
        self.assertGreater(at(u, 50, 50), 200)   # B's box, scaled to A's size
        self.assertLess(at(u, 34, 5), 40)
        videoedit.refine_matte(self.a, self.td / "i.mp4", self.b, combine="intersect")
        i = frame(self.td / "i.mp4")
        self.assertLess(at(i, 15, 15), 40)
        self.assertLess(at(i, 50, 50), 40)
        videoedit.refine_matte(self.a, self.td / "s.mp4", self.b, combine="subtract")
        s = frame(self.td / "s.mp4")
        self.assertGreater(at(s, 15, 15), 200)
        self.assertLess(at(s, 50, 50), 40)

    def test_grow_and_shrink(self):
        videoedit.refine_matte(self.a, self.td / "g.mp4", grow=3)
        videoedit.refine_matte(self.a, self.td / "e.mp4", grow=-3)
        g, e = frame(self.td / "g.mp4"), frame(self.td / "e.mp4")
        self.assertGreater(at(g, 6, 15), 200)    # 2 px outside the box: grown into
        self.assertLess(at(e, 9, 15), 40)        # 1 px inside the edge: shrunk away
        self.assertGreater(at(e, 15, 15), 200)

    def test_encoder_falls_back_to_libx264(self):
        args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=s=16x16:d=0.2", *videoedit.h264(18),
                "-pix_fmt", "yuv420p", str(self.td / "t.mp4")]
        r = videoedit.run_ffmpeg(args, timeout=60)   # NVENC refuses frames this small: libx264 takes over
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.td / "t.mp4").stat().st_size > 0)

    def test_invert_and_size(self):
        info = videoedit.refine_matte(self.a, self.td / "n.mp4", invert=True)
        n = frame(self.td / "n.mp4")
        self.assertLess(at(n, 15, 15), 40)
        self.assertEqual((info["width"], info["height"]), (64, 64))


if __name__ == "__main__":
    unittest.main()
