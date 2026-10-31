"""Cropped copies of Board pictures and clips (app/main.py POST /api/crop): a new generation in History whose output
is the crop, with the original as its parent. Run: .venv/bin/python -m unittest discover tests"""
import os
import shutil
import subprocess
import tempfile
import time
import unittest

config = main = db = TestClient = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global config, main, db, TestClient
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from fastapi.testclient import TestClient as T
    from app import config as c, db as d, main as m
    config, main, db, TestClient = c, m, d, T
    assert not str(config.DATA_DIR).startswith(str(config.BASE_DIR / "data")), config.DATA_DIR


class Crop(unittest.TestCase):
    def setUp(self):
        self.pid = db.create_project(f"Crop {time.time_ns()}")["id"]
        self.c = TestClient(main.app)

    def output(self, name, make, kind):
        gid = db.create_generation(self.pid, "t", {}, {}, f"p-{time.time_ns()}")
        rel = f"{db.project_folder(self.pid)}/{gid:05d}_{name}"
        path = config.PROJECTS_DIR / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        make(path)
        db.update_generation(gid, status="done", outputs=[{"filename": path.name, "path": rel, "kind": kind, "node": "9"}])
        return gid

    def crop(self, gid, **body):
        return self.c.post("/api/crop", json={"source": {"generation": gid, "index": 0}, "project_id": self.pid, **body})

    def test_picture(self):
        from PIL import Image
        gid = self.output("pic.png", lambda p: Image.new("RGBA", (200, 100), (255, 0, 0, 128)).save(p), "image")
        r = self.crop(gid, crop={"x": 0.25, "y": 0.5, "w": 0.5, "h": 0.5})
        self.assertEqual(r.status_code, 200, r.text)
        g = r.json()
        self.assertEqual(g["template"], "crop")
        self.assertEqual(g["status"], "done")
        self.assertEqual(g["parent"]["generation"], gid)
        out = config.PROJECTS_DIR / g["outputs"][0]["path"]
        with Image.open(out) as im:
            self.assertEqual(im.size, (100, 50))
            self.assertEqual(im.mode, "RGBA")   # see-through kept
        self.assertTrue((config.PROJECTS_DIR / db.get_generation(gid)["outputs"][0]["path"]).is_file())   # the original stays

    def test_no_crop_is_refused(self):
        from PIL import Image
        gid = self.output("pic.png", lambda p: Image.new("RGB", (64, 64)).save(p), "image")
        self.assertEqual(self.crop(gid, crop=None).status_code, 400)
        self.assertEqual(self.crop(gid, crop={"x": 0, "y": 0, "w": 1, "h": 1}).status_code, 400)

    @unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
    def test_clip_with_trim(self):
        def clip(p):
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=4",
                            "-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                            "-shortest", str(p)], check=True)
        gid = self.output("clip.mp4", clip, "video")
        r = self.crop(gid, crop={"x": 0, "y": 0, "w": 0.5, "h": 0.5}, trim={"start": 1, "len": 2})
        self.assertEqual(r.status_code, 200, r.text)
        o = r.json()["outputs"][0]
        self.assertEqual(o["kind"], "video")
        info = main.videoedit.probe(config.PROJECTS_DIR / o["path"])
        self.assertEqual((info["width"], info["height"]), (160, 90))
        self.assertAlmostEqual(info["duration"], 2, delta=0.2)
        self.assertTrue(info["audio"])


if __name__ == "__main__":
    unittest.main()
