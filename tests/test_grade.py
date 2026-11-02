"""Colour on clips: what /api/video/histogram sees, and that an export grades a clip as the preview's tables say (web/adjust.js)."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

videoedit = main = db = config = TestClient = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global videoedit, main, db, config, TestClient
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    from app import config as c, db as d, main as m, videoedit as v
    from fastapi.testclient import TestClient as T
    videoedit, main, db, config, TestClient = v, m, d, c, T


def ramp(path: Path):
    """A picture that goes through every level, left to right."""
    a = np.tile(np.linspace(0, 255, 256, dtype=np.uint8)[None, :, None], (64, 1, 3))
    Image.fromarray(a).save(path)


class Grade(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.dir = Path(self.td.name)

    def tearDown(self):
        self.td.cleanup()

    def clip(self, colour="0x804020", name="c.mp4"):
        p = self.dir / name
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={colour}:s=64x64:d=1:r=10", "-pix_fmt", "yuv444p", str(p)], check=True)
        return p

    def test_histogram_of_a_clip_counts_its_frames(self):
        h = videoedit.histogram(self.clip(), "video", 0.2, 0.5)
        self.assertEqual(sorted(h), ["b", "g", "r"])
        self.assertEqual(len(h["r"]), 256)
        self.assertGreater(sum(h["r"]), 1000)
        for ch, want in (("r", 0x80), ("g", 0x40), ("b", 0x20)):
            self.assertLess(abs(int(np.argmax(h[ch])) - want), 8, ch)

    def test_histogram_of_a_picture_skips_what_does_not_show(self):
        p = self.dir / "half.png"
        a = np.zeros((64, 640, 4), np.uint8)
        a[:, :320] = (200, 10, 10, 255)   # the other half is see-through
        Image.fromarray(a).save(p)
        h = videoedit.histogram(p, "image")
        self.assertEqual(int(np.argmax(h["r"])), 200)
        self.assertEqual(sum(h["r"]), h["r"][200])

    def test_grade_filters_go_through_ffmpeg_as_tables(self):
        src, out = self.dir / "ramp.png", self.dir / "out.png"
        ramp(src)
        inverse = [1 - i / 32 for i in range(33)]
        half = [0.5 * i / 32 for i in range(33)]
        same = [i / 32 for i in range(33)]
        vf = ",".join(videoedit.grade_filters({"r": inverse, "g": half, "b": same, "m": None}))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", vf, str(out)], check=True)
        a = np.asarray(Image.open(out).convert("RGB")).astype(int)[32]
        for x in (0, 64, 128, 200, 255):
            self.assertLess(abs(a[x, 0] - (255 - x)), 3)
            self.assertLess(abs(a[x, 1] - x / 2), 3)
            self.assertLess(abs(a[x, 2] - x), 3)

    def test_matrix_and_no_grade(self):
        self.assertEqual(videoedit.grade_filters(None), [])
        same = [i / 32 for i in range(33)]
        chain = videoedit.grade_filters({"r": same, "g": same, "b": same, "m": [0.2126, 0.7152, 0.0722] * 3})
        self.assertEqual(len(chain), 2)
        src, out = self.dir / "c.png", self.dir / "grey.png"
        Image.new("RGB", (32, 32), (200, 40, 40)).save(src)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", ",".join(chain), str(out)], check=True)
        r, g, b = Image.open(out).convert("RGB").getpixel((5, 5))
        self.assertLess(max(r, g, b) - min(r, g, b), 3)
        with self.assertRaises(ValueError):
            videoedit.grade_filters({"r": same, "g": same, "b": same, "m": [1, 2]})

    def test_export_grades_only_the_clip_that_has_one(self):
        clip, out = self.clip("0x808080"), self.dir / "out.mp4"
        dark = [0.25 * i / 32 for i in range(33)]
        item = {"path": str(clip), "kind": "video", "track": "v", "z": 0, "at": 0, "in": 0, "out": 0.5, "x": 0, "y": 0, "scale": 1, "fit": "fit", "opacity": 1, "volume": 1}
        videoedit.render([{**item, "grade": {"r": dark, "g": dark, "b": dark, "m": None}}, {**item, "at": 0.5}], out, 64, 64, 10)
        def level(t):
            r = subprocess.run(["ffmpeg", "-v", "error", "-ss", str(t), "-i", str(out), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, check=True)
            return np.frombuffer(r.stdout, np.uint8).mean()
        self.assertLess(abs(level(0.2) - 0x80 * 0.25), 12)
        self.assertLess(abs(level(0.8) - 0x80), 12)

    def test_route_answers_and_leaves_no_file(self):
        c = TestClient(main.app)
        pid = db.create_project("colour test")["id"]
        gid = db.create_generation(pid, "test", {}, {}, "colour-test", None)
        rel = f"{db.project_folder(pid)}/{gid:05d}_c.mp4"
        path = config.PROJECTS_DIR / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x804020:s=64x64:d=1:r=10", "-pix_fmt", "yuv444p", str(path)], check=True)
        db.update_generation(gid, status="done", outputs=[{"filename": path.name, "path": rel, "kind": "video", "node": "9"}])
        before = sorted(p for p in config.DATA_DIR.rglob("*") if p.is_file() and "sqlite" not in p.name)
        r = c.post("/api/video/histogram", json={"source": {"generation": gid, "index": 0}, "start": 0, "len": 1})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(json.loads(r.text)["g"]), 256)
        self.assertEqual(sorted(p for p in config.DATA_DIR.rglob("*") if p.is_file() and "sqlite" not in p.name), before)
