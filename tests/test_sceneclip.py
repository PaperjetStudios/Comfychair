"""3D composition clips: frames from the browser become a temporary video the video render can use (/api/scene/clip)."""
import os
import struct
import tempfile
import unittest
import zlib

os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
os.environ.setdefault("DECK_COMFY_DIR", "")

from fastapi.testclient import TestClient  # noqa: E402

from app import config, imageprep, main, videoedit  # noqa: E402


def png(w=32, h=18, rgb=(200, 40, 40)):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))  # noqa: E731
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


@unittest.skipUnless(imageprep.ffmpeg_available(), "needs ffmpeg")
class SceneClip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(main.app)

    def send(self, token, start, n, done=False, fps=12, data=None):
        files = [("frames", (f"f{i}.png", data or png(), "image/png")) for i in range(n)]
        return self.c.post("/api/scene/clip", files=files, data={"token": token, "start": start, "fps": fps, "done": "true" if done else "false"})

    def test_batches_make_a_clip(self):
        t = "a1" * 8
        r = self.send(t, 0, 3)
        self.assertEqual((r.status_code, r.json()), (200, {"frames": 3}))
        r = self.send(t, 3, 3, done=True)
        self.assertEqual(r.status_code, 200, r.text)
        j = r.json()
        self.assertEqual((j["frames"], j["duration"]), (6, 0.5))
        path = config.SCENE_CLIP_DIR / j["clip"]
        self.assertTrue(path.is_file())
        self.assertFalse((config.SCENE_CLIP_DIR / f"{t}.frames").exists())  # the frames are gone
        info = videoedit.probe(path)
        self.assertEqual((info["width"], info["height"]), (32, 18))

    def test_rejects_bad_requests(self):
        self.assertEqual(self.send("../evil", 0, 1).status_code, 400)           # token must be hex
        self.assertEqual(self.send("b2" * 8, 0, 1, data=b"not a png").status_code, 400)
        self.assertEqual(self.send("c3" * 8, 0, 1, fps=0).status_code, 400)
        r = self.send("d4" * 8, 2, 1, done=True)                               # frame 0 never came
        self.assertEqual(r.status_code, 400, r.text)

    def timeline(self, src):
        return {"tracks": [{"id": "v1", "kind": "video"}], "width": 64, "height": 36,
                "items": [{"track": "v1", "src": src, "at": 0, "in": 0, "out": 0.5, "opacity": 1, "volume": 1, "scale": 1, "scene": {"id": "s1", "name": "Shot", "look": "depth", "rev": 3}}]}

    def test_render_takes_the_clip_as_a_source(self):
        t = "e5" * 8
        clip = self.send(t, 0, 6, done=True).json()["clip"]
        r = self.c.post("/api/video/render", json=self.timeline({"clip": clip}))
        self.assertEqual(r.status_code, 200, r.text)
        g = r.json()
        self.assertEqual(g["status"], "done")
        self.assertEqual(g["params"]["scenes"], [{"id": "s1", "name": "Shot", "look": "depth", "rev": 3}])

    def test_render_refuses_a_missing_or_unsafe_clip(self):
        self.assertEqual(self.c.post("/api/video/render", json=self.timeline({"clip": "nope.mp4"})).status_code, 400)
        outside = config.DATA_DIR / "secret.mp4"
        outside.write_bytes(b"x")
        self.assertEqual(self.c.post("/api/video/render", json=self.timeline({"clip": "../secret.mp4"})).status_code, 400)

    def test_old_clips_are_swept(self):
        old = config.SCENE_CLIP_DIR / "old.mp4"
        old.write_bytes(b"x")
        os.utime(old, (1, 1))
        self.send("f6" * 8, 0, 1, done=True)
        self.assertFalse(old.exists())


if __name__ == "__main__":
    unittest.main()
