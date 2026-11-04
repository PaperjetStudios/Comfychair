"""A clip's frame by index (the object sheet's views): app/imageprep.frame_from_video. A finished PNG sent back as it is: ready_png."""
import io
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
os.environ.setdefault("DECK_COMFY_DIR", "")

from app import imageprep  # noqa: E402


def make_clip(path, frames=10, rate=10):
    colors = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "white", "black"]
    src = f"color=c={colors[frames % len(colors)]}:s=64x64:d={frames / rate}:r={rate}"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", src, "-frames:v", str(frames),
                    "-pix_fmt", "yuv420p", str(path)], check=True, capture_output=True)


def mean_rgb(png):
    from PIL import Image
    import io
    im = Image.open(io.BytesIO(png)).convert("RGB")
    px = list(im.getdata())
    return tuple(sum(c[i] for c in px) / len(px) for i in range(3))


@unittest.skipUnless(imageprep.ffmpeg_available(), "ffmpeg not installed")
class Frames(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.clip = Path(self.td.name) / "clip.mp4"
        # a clip that changes colour: a still tests nothing about picking a frame
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi",
                        "-i", "testsrc=s=64x64:d=1:r=10", "-pix_fmt", "yuv420p", str(self.clip)],
                       check=True, capture_output=True)

    def tearDown(self):
        self.td.cleanup()

    def test_a_frame_by_index(self):
        first = imageprep.frame_from_video(self.clip, "first")
        third = imageprep.frame_from_video(self.clip, 3)
        third_s = imageprep.frame_from_video(self.clip, "3")
        last = imageprep.frame_from_video(self.clip, "last")
        self.assertEqual(third, third_s, "a number and its string pick the same frame")
        self.assertNotEqual(third, first)
        self.assertNotEqual(third, last)
        # the frame after the one asked for is not what comes back
        self.assertNotEqual(third, imageprep.frame_from_video(self.clip, 6))

    def test_a_frame_past_the_end_is_an_error(self):
        with self.assertRaises(RuntimeError):
            imageprep.frame_from_video(self.clip, 999)

    def test_a_negative_frame_is_refused(self):
        with self.assertRaises(RuntimeError):
            imageprep.frame_from_video(self.clip, -1)


class ReadyPng(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.path = Path(self.dir.name) / "out.png"

    def save(self, size=(64, 32), mode="RGB", fmt="PNG", **kw):
        from PIL import Image
        Image.new(mode, size).save(self.path, fmt, **kw)
        return self.path

    def test_same_pixels_and_size_as_encoding_it_again_without_the_prompt(self):
        from PIL import Image
        from PIL.PngImagePlugin import PngInfo
        info = PngInfo()
        info.add_text("prompt", "a secret prompt")
        info.add_itxt("workflow", "a secret workflow")
        self.save((64, 32), "RGBA", pnginfo=info)
        png, w, h = imageprep.ready_png(self.path, 0, 1)
        self.assertEqual((w, h), (64, 32))
        self.assertNotIn(b"secret", png)
        got, want = Image.open(io.BytesIO(png)), Image.open(self.path)
        self.assertEqual(got.tobytes(), want.tobytes())
        self.assertEqual(got.mode, "RGBA")

    def test_anything_that_would_change_goes_the_long_way(self):
        self.save((64, 32))
        self.assertIsNone(imageprep.ready_png(self.path, 0, 1, {"x": 0, "y": 0, "w": 0.5, "h": 1}), "cropped")
        self.assertIsNone(imageprep.ready_png(self.path, 0.001, 1), "made smaller")
        self.assertIsNone(imageprep.ready_png(self.path, 0, 10), "not a multiple")
        self.assertIsNotNone(imageprep.ready_png(self.path, 0, 16))
        self.save((64, 32), "L")
        self.assertIsNone(imageprep.ready_png(self.path, 0, 1), "grey")
        self.save((64, 32), fmt="JPEG")
        self.assertIsNone(imageprep.ready_png(self.path, 0, 1), "not a PNG")
        from PIL import Image
        ex = Image.Exif()
        ex[0x0112] = 6
        Image.new("RGB", (64, 32)).save(self.path, "PNG", exif=ex)
        self.assertIsNone(imageprep.ready_png(self.path, 0, 1), "turned by its EXIF")


if __name__ == "__main__":
    unittest.main()
