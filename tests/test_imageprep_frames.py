"""A clip's frame by index (the object sheet's views): app/imageprep.frame_from_video."""
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


if __name__ == "__main__":
    unittest.main()
