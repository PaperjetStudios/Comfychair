"""Pose video association (app/posefind.py, POST /api/pose/find): which finished Pose preview a drive can take.
Run: .venv/bin/python -m unittest discover tests"""
import asyncio
import os
import shutil
import subprocess
import tempfile
import unittest

main = db = config = posefind = None
HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global main, db, config, posefind
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from app import config as c, db as d, main as m, posefind as p
    main, db, config, posefind = m, d, c, p


def pose_gen(media, trim=None, crop=None, secs=5.0, poser="dwpose", status="done", file=b"x", real_secs=None):
    """A finished Pose preview of a media clip; its output file holds `file` (None: no file), or is a real clip of
    real_secs at 24 fps."""
    src = {"media": media, **({"trim": trim} if trim else {}), **({"crop": crop} if crop else {})}
    gid = db.create_generation(1, posefind.TEMPLATES[poser], {"src.video": src, "secs.value": secs}, {}, f"pose-{os.urandom(6).hex()}")
    rel = f"posefind/{gid:05d}_pose.mp4"
    path = config.PROJECTS_DIR / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if real_secs:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size=64x64:rate=24:duration={real_secs}",
                        "-pix_fmt", "yuv420p", str(path)], check=True)
    elif file is not None:
        path.write_bytes(file)
    db.update_generation(gid, status=status, outputs=[{"filename": "pose.mp4", "path": rel, "kind": "video"}])
    return gid


def find(**body):
    return asyncio.run(main.pose_find({"poser": "dwpose", "len": 5, **body}))


class Rules(unittest.TestCase):
    def test_same_clip(self):
        self.assertTrue(posefind.same_clip({"generation": 4, "index": 0}, {"generation": "4"}))
        self.assertFalse(posefind.same_clip({"generation": 4, "index": 1}, {"generation": 4, "index": 0}))
        self.assertTrue(posefind.same_clip({"media": "a.mp4", "trim": {"start": 1}}, {"media": "a.mp4"}))
        self.assertFalse(posefind.same_clip({"media": "a.mp4"}, {"generation": 1}))
        self.assertFalse(posefind.same_clip({"media": ""}, {"media": ""}))

    def test_same_crop(self):
        full = {"x": 0, "y": 0, "w": 1, "h": 1}
        self.assertTrue(posefind.same_crop(None, full))
        self.assertTrue(posefind.same_crop({"x": 0.1, "y": 0, "w": 0.5, "h": 1}, {"x": 0.1005, "y": 0, "w": 0.5, "h": 1}))
        self.assertFalse(posefind.same_crop({"x": 0.1, "y": 0, "w": 0.5, "h": 1}, None))
        self.assertFalse(posefind.same_crop({"x": 0.1, "y": 0, "w": 0.5, "h": 1}, {"x": 0.2, "y": 0, "w": 0.5, "h": 1}))

    def test_frames_needed(self):
        self.assertEqual(posefind.frames_needed(None, 5), 121)                       # LTX's 8n+1 at 5 s
        self.assertEqual(posefind.frames_needed({"start": 1, "len": 2}, 5), 49)      # the trim is shorter
        self.assertEqual(posefind.frames_needed({"start": 8}, 5, clip_secs=10), 48)  # the clip ends first


class Find(unittest.TestCase):
    def test_match_rules(self):
        clip = "11111_posefind_a.mp4"
        trim = {"start": 1.0, "len": 4.0}
        g1 = pose_gen(clip, trim)                                            # 97 frames
        pose_gen(clip, trim, crop={"x": 0.2, "y": 0, "w": 0.6, "h": 1})      # another crop
        g3 = pose_gen(clip, trim, poser="sdpose")
        g4 = pose_gen(clip, {"start": 1.02, "len": 4.0}, secs=3.0)           # same start within a frame, but 3 s
        pose_gen(clip, trim, status="error")
        pose_gen(clip, trim, file=None)                                      # its file is gone
        pose_gen(clip, {"start": 2.0, "len": 4.0})                           # another start

        r = find(source={"media": clip}, trim=trim)
        self.assertEqual((r["generation"], r["index"], r["frames"]), (g1, 0, 97))
        self.assertEqual(find(source={"media": clip}, trim=trim, len=3)["generation"], g4)   # the newest that covers
        self.assertEqual(find(source={"media": clip}, trim=trim, poser="sdpose")["generation"], g3)
        self.assertIsNone(find(source={"media": clip}, trim={"start": 0.5, "len": 4.0}))
        self.assertIsNone(find(source={"media": clip}, trim=trim, crop={"x": 0.3, "y": 0, "w": 0.6, "h": 1}))
        self.assertIsNone(find(source={"media": "22222_posefind_other.mp4"}, trim=trim))
        self.assertEqual(find(source={"media": clip}, trim=trim, len=10)["generation"], g1)   # the trim caps it at 4 s

    def test_generation_source(self):
        gid = db.create_generation(1, posefind.TEMPLATES["dwpose"], {"src.video": {"generation": 900001, "index": 1}, "secs.value": 5.0},
                                   {}, "pose-gen-src")
        rel = f"posefind/{gid:05d}_pose.mp4"
        (config.PROJECTS_DIR / rel).parent.mkdir(parents=True, exist_ok=True)
        (config.PROJECTS_DIR / rel).write_bytes(b"x")
        db.update_generation(gid, status="done", outputs=[{"filename": "x.png", "path": "x.png", "kind": "image"},
                                                          {"filename": "pose.mp4", "path": rel, "kind": "video"}])
        r = find(source={"generation": 900001, "index": 1})
        self.assertEqual((r["generation"], r["index"]), (gid, 1))
        self.assertIsNone(find(source={"generation": 900001, "index": 0}))

    @unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg")
    def test_measured_length_wins(self):
        clip = "33333_posefind_b.mp4"
        g = pose_gen(clip, secs=5.0, real_secs=2)          # says 5 s, but the file has 48 frames
        self.assertIsNone(find(source={"media": clip}))
        r = find(source={"media": clip}, len=1.5)
        self.assertEqual((r["generation"], r["frames"]), (g, 48))

    def test_bad_requests(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException):
            find(source={})
        with self.assertRaises(HTTPException):
            find(source={"media": "a.mp4"}, poser="openpose")


if __name__ == "__main__":
    unittest.main()
