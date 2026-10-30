"""The combined depth video (/api/scene/depth-combine): the 3D objects' exact depth over the picture's estimate.
Run: .venv/bin/python -m unittest discover tests"""
import asyncio
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


def grey_at(path, x, y):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vf", f"format=gray,crop=2:2:{x}:{y}",
                          "-frames:v", "1", "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    return raw[0]


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg")
class DepthCombine(unittest.TestCase):
    def clip(self, src, name):
        rel = f"depthcombine/{os.urandom(4).hex()}-{name}.mp4"
        path = config.PROJECTS_DIR / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", src, "-pix_fmt", "yuv420p", str(path)], check=True)
        gid = db.create_generation(1, "3d scene", {}, {}, f"dc-{os.urandom(6).hex()}")
        db.update_generation(gid, status="done", outputs=[{"filename": path.name, "path": rel, "kind": "video"}])
        return gid

    def test_objects_over_the_picture(self):
        # the objects-only pass: black (Y 16 once encoded) where nothing was drawn, a far object at the floor (40), a near one at 200
        geo = self.clip("color=0x101010:s=160x120:r=24:d=2,drawbox=x=10:y=10:w=40:h=40:color=0x282828:t=fill,"
                        "drawbox=x=100:y=50:w=40:h=40:color=0xc8c8c8:t=fill", "geo")
        pic = self.clip("color=0x969696:s=320x240:r=30:d=3", "pic")   # bigger, another rate, longer
        g = asyncio.run(main.scene_depth_combine({"picture": pic, "geometry": geo}))
        self.assertEqual(g["status"], "done")
        out = main.output_file(g, g["outputs"][0])
        self.assertAlmostEqual(grey_at(out, 2, 2), 150, delta=6)     # the picture where nothing was drawn
        self.assertAlmostEqual(grey_at(out, 28, 28), 40, delta=6)    # a far object still wins
        self.assertAlmostEqual(grey_at(out, 118, 68), 200, delta=6)
        frames = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_entries", "stream=nb_read_frames,width",
                                 "-of", "csv=p=0", str(out)], capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(frames, "160,48")   # the geometry's size, rate and length

    def test_bad_ids(self):
        for body in ({"picture": "x", "geometry": 1}, {"picture": None, "geometry": None}):
            with self.assertRaises(main.HTTPException) as e:
                asyncio.run(main.scene_depth_combine(body))
            self.assertEqual(e.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
