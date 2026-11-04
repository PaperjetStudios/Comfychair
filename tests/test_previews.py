"""Light previews for grids (app/previews.py). Run: .venv/bin/python -m unittest discover tests"""
import os
import shutil
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path

previews = config = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global previews, config
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from app import config as c, previews as p
    previews, config = p, c


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
class Previews(unittest.TestCase):
    def setUp(self):
        self.clip = config.MEDIA_DIR / "aaaa0000_t.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=2", "-pix_fmt", "yuv420p",
                        str(self.clip)], check=True)
        self.addCleanup(self.clip.unlink, missing_ok=True)

    def test_paths_stay_inside_the_files_folders(self):
        self.assertEqual(previews.source("/files/media/aaaa0000_t.mp4"), self.clip.resolve())
        for bad in ("/files/media/../deck.sqlite3", "/etc/passwd", "/files/media/missing.mp4"):
            with self.assertRaises(Exception):
                previews.source(bad)

    def test_still_and_clip(self):
        td = Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, td)
        previews.make_still(self.clip, td / "s.jpg", 320)
        self.assertGreater((td / "s.jpg").stat().st_size, 1000)
        previews.make_clip(self.clip, td / "c.mp4", 320)
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,r_frame_rate,codec_type", "-of", "csv=p=0",
                              str(td / "c.mp4")], capture_output=True, text=True).stdout.split()
        self.assertEqual(out, ["video,320,8/1"])   # small, 8 fps, no sound

    def test_wave(self):
        td = Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, td)
        snd = td / "s.m4a"   # quiet: the waveform is scaled up to fill the picture anyway
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-af", "volume=0.05",
                        str(snd)], check=True)
        previews.make_wave(snd, td / "w.png", 320)
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(td / "w.png")],
                             capture_output=True, text=True).stdout.split()
        self.assertEqual(out, ["320,106"])
        with self.assertRaises(RuntimeError):   # a clip without sound has no waveform
            previews.make_wave(self.clip, td / "x.png", 320)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
class Rotation(unittest.TestCase):
    def test_a_phone_clip_on_its_side_is_portrait(self):
        from app import videoedit, videoprep
        td = Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, td)
        flat = td / "flat.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=1", "-pix_fmt", "yuv420p", str(flat)], check=True)
        rot = td / "rot.mp4"   # the same frames, tagged to be shown turned 90 degrees, as phones store portrait video
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-display_rotation", "90", "-i", str(flat), "-c", "copy", str(rot)], check=True)
        info = videoedit.probe(rot)
        self.assertEqual((info["width"], info["height"], info["rotation"]), (360, 640, 90))
        with unittest.mock.patch.object(videoprep.config, "VIDEOPREP_DIR", td):
            out = videoprep.plan(rot, None, None, {})["path"]
        self.assertNotEqual(out, rot)                         # a copy with the turn baked in
        baked = videoedit.probe(Path(out))
        self.assertEqual((baked["width"], baked["height"], baked["rotation"]), (360, 640, 0))

class ModelShots(unittest.TestCase):
    JPEG = b"\xff\xd8\xff\xe0 a picture"

    def setUp(self):
        from fastapi.testclient import TestClient
        from app import main, storage
        self.c, self.storage = TestClient(main.app), storage
        self.model = config.MEDIA_DIR / "aaaa0001_t.glb"
        self.model.write_bytes(b"glTF model")
        self.u = f"/files/media/{self.model.name}"
        self.addCleanup(self.model.unlink, missing_ok=True)

    def test_kept_once_drawn_and_gone_with_the_model(self):
        self.assertEqual(self.c.get("/api/preview/shot", params={"u": self.u}).status_code, 204)
        self.assertEqual(self.c.post("/api/preview/shot", params={"u": self.u}, content=self.JPEG).status_code, 200)
        r = self.c.get("/api/preview/shot", params={"u": self.u})
        self.assertEqual((r.status_code, r.content), (200, self.JPEG))
        made = list(previews.DIR.glob(f"{self.storage.tag(self.model.resolve())}-*"))
        self.assertEqual(len(made), 1)
        self.storage.drop_caches(self.model.resolve())
        self.assertFalse(made[0].exists())
        self.assertEqual(self.c.get("/api/preview/shot", params={"u": self.u}).status_code, 204)

    def test_refuses_what_is_not_a_model_shot(self):
        self.assertEqual(self.c.post("/api/preview/shot", params={"u": self.u}, content=b"not a jpeg").status_code, 400)
        self.assertEqual(self.c.post("/api/preview/shot", params={"u": self.u}, content=b"\xff\xd8\xff" + bytes(previews.MAX_SHOT)).status_code, 413)
        self.assertEqual(self.c.get("/api/preview/shot", params={"u": "/files/media/nope.glb"}).status_code, 404)
        pic = config.MEDIA_DIR / "aaaa0002_t.png"
        pic.write_bytes(b"x")
        self.addCleanup(pic.unlink, missing_ok=True)
        self.assertEqual(self.c.get("/api/preview/shot", params={"u": f"/files/media/{pic.name}"}).status_code, 400)


class InputPictures(unittest.TestCase):
    """A timeline item made from one of the project's pictures (src {input}) has an /api/input?name= URL: its tile's poster."""
    def setUp(self):
        import io
        from PIL import Image
        self.name = f"{config.COMFY_INPUT_SUBFOLDER}/prev_test_pic.png"
        self.file = config.INPUT_DIR / "prev_test_pic.png"
        buf = io.BytesIO(); Image.new("RGB", (200, 100), (200, 40, 40)).save(buf, "PNG")
        self.file.write_bytes(buf.getvalue())
        self.addCleanup(self.file.unlink, missing_ok=True)

    def test_an_input_url_is_a_source(self):
        from urllib.parse import quote
        self.assertEqual(previews.source(f"/api/input?name={quote(self.name)}"), self.file.resolve())
        self.assertEqual(previews.source(f"/files/input/{quote(self.name)}"), self.file.resolve())
        for bad in ("/api/input?name=", "/api/input?name=elsewhere/prev_test_pic.png", f"/api/input?name={config.COMFY_INPUT_SUBFOLDER}/../deck.sqlite3",
                    f"/api/input?name={config.COMFY_INPUT_SUBFOLDER}/missing.png"):
            with self.assertRaises(Exception):
                previews.source(bad)
