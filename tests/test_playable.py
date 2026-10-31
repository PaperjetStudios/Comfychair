"""Clips the browser can't play (ProRes, MJPEG, PCM sound) get an H.264/AAC copy for the player; the original stays.
Run: .venv/bin/python -m pytest tests/test_playable.py"""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

config = main = storage = playable = videoedit = TestClient = None


def setUpModule():
    global config, main, storage, playable, videoedit, TestClient
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from fastapi.testclient import TestClient as T
    from app import config as c, main as m, playable as p, storage as s, videoedit as v
    config, main, storage, playable, videoedit, TestClient = c, m, s, p, v, T
    assert not str(config.DATA_DIR).startswith(str(config.BASE_DIR / "data")), config.DATA_DIR


def ff(out: Path, *args):
    subprocess.run(["ffmpeg", "-v", "error", "-y", *args, "-t", "0.5", str(out)], check=True, capture_output=True)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg")
class Playable(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix="deck-play-"))
        vid = ["-f", "lavfi", "-i", "testsrc=size=64x64:rate=12"]
        enc = subprocess.run(["ffmpeg", "-encoders"], capture_output=True, text=True).stdout
        cls.mov = cls.dir / "pro.mov"
        ff(cls.mov, *vid, "-c:v", "prores_ks" if "prores_ks" in enc else "mjpeg", *([] if "prores_ks" in enc else ["-pix_fmt", "yuvj420p"]))
        cls.pcm = cls.dir / "pcm.mov"
        ff(cls.pcm, *vid, "-f", "lavfi", "-i", "sine=duration=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le")
        cls.mp4 = cls.dir / "ok.mp4"
        ff(cls.mp4, *vid, "-f", "lavfi", "-i", "sine=duration=0.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac")
        cls.client = TestClient(main.app)

    def upload(self, p: Path):
        r = self.client.post("/api/media", files={"file": (p.name, p.read_bytes(), "video/quicktime")})
        self.assertEqual(r.status_code, 200, r.text)
        self.addCleanup(lambda: self.client.delete("/api/media", params={"name": r.json()["name"]}))
        return r.json()

    def test_browser_plays(self):
        self.assertFalse(playable.browser_plays(self.mov))
        self.assertFalse(playable.browser_plays(self.pcm))   # h264 video, PCM sound
        self.assertTrue(playable.browser_plays(self.mp4))
        self.assertEqual(videoedit.probe(self.mp4)["vcodec"], "h264")

    def test_upload_makes_a_copy_and_delete_removes_it(self):
        for src in (self.mov, self.pcm):
            e = self.upload(src)
            self.assertTrue(e["url"].endswith("-play.mp4"), e)
            self.assertEqual(e["source"], f"/files/media/{e['name']}")
            copy = playable.path_for(e["name"])
            info = videoedit.probe(copy)
            self.assertEqual(info["vcodec"], "h264")
            self.assertTrue(playable.browser_plays(info))
            self.assertEqual(info["width"] % 2, 0)
            self.assertTrue((config.MEDIA_DIR / e["name"]).is_file())   # the original stays
            self.assertEqual(self.client.get(e["url"]).status_code, 200)
            self.assertIn(e["url"], [m["url"] for m in self.client.get("/api/media").json()])
            self.assertEqual(self.client.delete("/api/media", params={"name": e["name"]}).status_code, 200)
            self.assertFalse(copy.exists())
            self.assertFalse((config.MEDIA_DIR / e["name"]).exists())

    def test_playable_upload_gets_no_copy(self):
        e = self.upload(self.mp4)
        self.assertEqual(e["url"], f"/files/media/{e['name']}")
        self.assertNotIn("source", e)
        self.assertFalse(playable.path_for(e["name"]).exists())


if __name__ == "__main__":
    unittest.main()
