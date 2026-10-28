"""What a run's outputs keep about themselves (main.fill_facts): lengths, sizes, frame rates, and the kind of a file
saved before the motion and 3D kinds.
Run: .venv/bin/python -m unittest discover tests"""
import os
import shutil
import subprocess
import tempfile
import unittest

main = db = config = None
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global main, db, config
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from app import config as c, db as d, main as m
    main, db, config = m, d, c


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg")
class Durations(unittest.TestCase):
    def run_with(self, outputs):
        gid = db.create_generation(1, "t", {}, {}, f"len-{os.urandom(6).hex()}")
        db.update_generation(gid, status="done", outputs=outputs)
        return gid

    def test_video_gets_its_length_once(self):
        rel = f"durations/{os.urandom(4).hex()}.mp4"
        path = config.PROJECTS_DIR / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=24:duration=2.5",
                        "-pix_fmt", "yuv420p", str(path)], check=True)
        gid = self.run_with([{"filename": path.name, "path": rel, "kind": "video"},
                             {"filename": "x.png", "path": "durations/x.png", "kind": "image"}])
        self.assertTrue(main.fill_facts(db.get_generation(gid)))
        g = db.get_generation(gid)
        self.assertAlmostEqual(g["outputs"][0]["duration"], 2.5, delta=0.1)
        self.assertNotIn("duration", g["outputs"][1])
        self.assertFalse(main.fill_facts(g))   # already there: nothing to do

    def test_sizes_and_kinds(self):
        from PIL import Image
        import json
        d = config.PROJECTS_DIR / "facts"
        d.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (40, 30)).save(d / "a.png")
        (d / "walk.json").write_text(json.dumps({"fps": 20, "frames": [[[0, 1, 0]] * 22] * 41}))
        (d / "thing.glb").write_bytes(b"glTF")
        (d / "notes.json").write_text("{}")
        gid = self.run_with([{"filename": n, "path": f"facts/{n}", "kind": k} for n, k in
                             [("a.png", "image"), ("walk.json", "file"), ("thing.glb", "file"), ("notes.json", "file")]])
        self.assertTrue(main.fill_facts(db.get_generation(gid)))
        img, mot, mesh, other = db.get_generation(gid)["outputs"]
        self.assertEqual((img["width"], img["height"]), (40, 30))
        self.assertEqual((mot["kind"], mot["fps"], mot["frames"], mot["duration"]), ("motion", 20, 41, 2.0))
        self.assertEqual(mesh["kind"], "mesh")
        self.assertEqual(other["kind"], "file")

    def test_missing_file_is_left(self):
        gid = self.run_with([{"filename": "gone.mp4", "path": "durations/gone.mp4", "kind": "video"}])
        self.assertFalse(main.fill_facts(db.get_generation(gid)))
        self.assertNotIn("duration", db.get_generation(gid)["outputs"][0])


if __name__ == "__main__":
    unittest.main()
