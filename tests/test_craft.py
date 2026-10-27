"""PhotoCraft / EffectCraft documents built from an edit (app/craft.py); with the apps installed, real ones headless.
Run: .venv/bin/python -m unittest discover tests"""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

craft = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global craft
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from app import craft as c
    craft = c


HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def clip(path: Path, secs=2, size="320x180", color="blue"):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"color=c={color}:s={size}:d={secs}", "-f", "lavfi",
                    "-i", f"sine=frequency=440:duration={secs}", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
                    "-shortest", str(path)], check=True)
    return path


class PhotoCommands(unittest.TestCase):
    def test_layers_are_placed_at_their_rect(self):
        new, cmds = craft.photo_commands({"w": 800, "h": 600, "bg": "#112233"}, [
            {"path": "/a.png", "size": (400, 300), "rect": {"x": 100, "y": 50, "w": 200, "h": 150}, "name": "A"},
            {"path": "/b.png", "size": (100, 100), "rect": {"x": 0, "y": 0, "w": 300, "h": 300}, "hidden": True}])
        self.assertEqual((new["width"], new["height"], new["background"]), (800, 600, "#112233"))
        place = [p for c, p in cmds if c == "file.placeEmbedded"]
        self.assertEqual(place[0]["scale"], 50)
        self.assertEqual(place[0]["center"], [200, 125])
        self.assertEqual(place[1]["scale"], 300)
        props = [p for c, p in cmds if c == "layer.setProps"]
        self.assertEqual([p["visible"] for p in props], [True, False])

    def test_no_colour_is_transparent(self):
        self.assertEqual(craft.photo_commands({"w": 10, "h": 10, "bg": None}, [])[0]["background"], "transparent")


class VideoScript(unittest.TestCase):
    def item(self, **kw):
        it = {"path": "/c.mp4", "kind": "video", "z": 0, "at": 1.0, "in": 0.5, "len": 2.0, "xin": 0, "xout": 0,
              "info": {"width": 640, "height": 360, "audio": True, "video": True}}
        return {**it, **kw}

    def test_timing_transform_and_fades(self):
        js = craft.video_jsx(1280, 720, 24, 4, [self.item(x=0.1, scale=0.5, rotation=10, fade_in=0.5, volume=0.5)],
                             Path("/p.ecproj"))
        self.assertIn("l0.startTime = 0.5000; l0.inPoint = 1.0000; l0.outPoint = 3.0000;", js)
        self.assertIn('property("Position").setValue([768.00, 360.00])', js)
        self.assertIn('property("Scale").setValue([100.000, 100.000])', js)   # fit (2x) times 0.5
        self.assertIn('setValue(10.000)', js)
        self.assertIn("o0.setValueAtTime(1.0000, 0.00);", js)
        self.assertIn("o0.setValueAtTime(1.5000, 100.00);", js)
        self.assertIn("setValueAtTime(1.0000, [-96, -96])", js)
        self.assertIn("[-6.02, -6.02]", js)

    def test_stacking_hidden_and_muted(self):
        js = craft.video_jsx(640, 360, 24, 4, [
            self.item(path="/top.mp4", z=1, at=0), self.item(path="/bottom.mp4", z=0, at=2, hidden=True),
            {**self.item(path="/s.mp3", kind="audio", muted=True), "info": {"audio": True, "video": False}}], Path("/p"))
        order = [js.index(f'get("{p}")') for p in ("/s.mp3", "/bottom.mp4", "/top.mp4")]
        self.assertEqual(order, sorted(order))   # added bottom first: sound, then the lower track
        self.assertIn("l1.enabled = false;", js)
        self.assertIn("l0.audioEnabled = false;", js)

    def test_a_still_starts_where_it_sits(self):
        js = craft.video_jsx(640, 360, 24, 4, [self.item(kind="image", **{"in": 0}, info={"width": 640, "height": 360})],
                             Path("/p"))
        self.assertIn("l0.startTime = 1.0000; l0.inPoint = 1.0000;", js)


@unittest.skipUnless(HAVE_FFMPEG and Path(os.environ.get("DECK_EFFECTCRAFT_CLI", "/usr/bin/effectcraft-cli")).is_file(),
                     "EffectCraft not installed")
class RealEffectCraft(unittest.TestCase):
    def test_project_has_the_layers(self):
        td = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, td)
        a, b = clip(td / "a.mp4"), clip(td / "b.mp4", color="red")
        doc = craft.build_video(td, [
            {"path": str(a), "kind": "video", "track": "v1", "z": 0, "at": 0, "in": 0.5, "out": 2, "name": "A"},
            {"path": str(b), "kind": "video", "track": "v2", "z": 1, "at": 1, "in": 0, "out": 1, "scale": 0.5, "name": "B"}], 640, 360, 24)
        info = subprocess.run([craft.EFFECTCRAFT_CLI, "--project", str(doc), "info"], capture_output=True, text=True).stdout
        self.assertIn('"ComfyDeck" 640x360 @ 24.0 fps', info)
        self.assertIn(" B", info)
        self.assertIn(" A", info)


@unittest.skipUnless(Path(os.environ.get("DECK_PHOTOCRAFT_CLI", "/usr/bin/photocraft-cli")).is_file(), "PhotoCraft not installed")
class RealPhotoCraft(unittest.TestCase):
    def test_document_has_named_layers(self):
        from PIL import Image
        td = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, td)
        Image.new("RGB", (200, 100), "red").save(td / "a.png")
        size = craft._crop(td / "a.png", {"x": 0.5, "y": 0, "w": 0.5, "h": 1}, td / "c.png")
        self.assertEqual(size, (100, 100))
        doc = craft.build_photo(td, {"w": 400, "h": 300, "bg": "#000000"}, [
            {"path": td / "c.png", "size": size, "rect": {"x": 10, "y": 20, "w": 200, "h": 200}, "name": "Red half"}])
        info = json.loads(subprocess.run([craft.PHOTOCRAFT_CLI, "info", str(doc)], capture_output=True, text=True).stdout)
        names = [l.get("name") for l in info["layers"]]
        self.assertIn("Red half", names)
        lay = next(l for l in info["layers"] if l.get("name") == "Red half")
        self.assertEqual(lay["bounds"], [10, 20, 200, 200])


if __name__ == "__main__":
    unittest.main()
