"""Keyframed clips in the Video export (app/keyexpr.py, videoedit.render): the keys' curve as ffmpeg expressions
lands the picture where the preview draws it. Run: .venv/bin/python -m unittest discover tests"""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from app import keyexpr, videoedit

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


class Sampling(unittest.TestCase):
    def test_like_keys_js(self):
        ks = [{"f": 0, "v": 0}, {"f": 2, "v": 10, "ease": "linear"}, {"f": 4, "v": 0}]
        self.assertEqual(keyexpr.sample(ks, -1, 5), 0)            # held before the first key
        self.assertEqual(keyexpr.sample(ks, 9, 5), 0)             # and after the last
        self.assertAlmostEqual(keyexpr.sample(ks, 1, 5), 5)       # smooth: half way at the middle
        self.assertAlmostEqual(keyexpr.sample(ks, 0.5, 5), 10 * 0.15625)
        self.assertAlmostEqual(keyexpr.sample(ks, 3, 5), 5)       # this segment's own ease: linear
        self.assertEqual(keyexpr.sample([], 1, 5), 5)              # no keys: the plain value
        self.assertIn("\\,", keyexpr.expr(ks, "t"))                # (commas escaped for a filter option)


def frame_at(path: Path, t: float, d: Path) -> np.ndarray:
    png = d / f"f{t:.2f}.png"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1", str(png)], check=True)
    return np.asarray(Image.open(png).convert("L"), dtype=float)


def white_box(a: np.ndarray):
    """(centre x, width) of the white picture on the black frame."""
    cols = np.where((a > 128).any(axis=0))[0]
    return (cols[0] + cols[-1]) / 2, cols[-1] - cols[0] + 1


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg")
class Render(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix="deck-keys-"))
        self.clip = self.d / "white.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=white:s=64x64:r=24:d=2.5",
                        "-f", "lavfi", "-i", "sine=f=440:d=2.5", "-shortest", "-pix_fmt", "yuv420p", str(self.clip)], check=True)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def render(self, **clip):
        out = self.d / "out.mp4"
        item = {"path": str(self.clip), "kind": "video", "track": "v1", "z": 0, "at": 0, "in": 0, "out": 2.5,
                "x": 0, "y": 0, "scale": 1, "fit": "fit", "opacity": 1, "volume": 1, **clip}
        videoedit.render([item], out, 320, 240, 24)
        return out

    def test_keyed_position_and_scale(self):
        out = self.render(chans={"x": [{"f": 0, "v": -0.25, "ease": "linear"}, {"f": 2, "v": 0.25}],
                                 "scale": [{"f": 0, "v": 0.25, "ease": "linear"}, {"f": 2, "v": 0.5}]})
        # fit: 64×64 into 320×240 is ×3.75, so 60 px at scale 0.25 and 120 px at 0.5; the centre at 160 + x·320
        # (kept inside the frame, so the measured box is the whole picture)
        for t, cx, w in [(0, 80, 60), (1, 160, 90), (2, 240, 120)]:
            x, width = white_box(frame_at(out, t, self.d))
            self.assertAlmostEqual(x, cx, delta=4, msg=f"centre at {t}s")
            self.assertAlmostEqual(width, w, delta=4, msg=f"width at {t}s")

    def test_keyed_rotation_opacity_and_level_render(self):
        out = self.render(chans={"rotation": [{"f": 0, "v": 0}, {"f": 2, "v": 90}],
                                 "opacity": [{"f": 0, "v": 0}, {"f": 1, "v": 1}],
                                 "volume": [{"f": 0, "v": 0}, {"f": 2, "v": 1}]})
        self.assertLess(frame_at(out, 0, self.d).max(), 40)          # see-through at first
        self.assertGreater(frame_at(out, 1.5, self.d).max(), 200)    # there by a second in
        self.assertTrue(videoedit.probe(out)["audio"])

    def test_no_keys_is_unchanged(self):
        x, width = white_box(frame_at(self.render(x=0.25, scale=0.5), 1, self.d))
        self.assertAlmostEqual(x, 240, delta=3)
        self.assertAlmostEqual(width, 120, delta=3)


def levels(path: Path, t: float, d: Path):
    """(left, right) loudness (RMS) of the 0.2 s from t."""
    raw = d / "pcm.raw"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.3f}", "-t", "0.2", "-i", str(path),
                    "-f", "s16le", "-ac", "2", "-ar", "48000", str(raw)], check=True)
    a = np.frombuffer(raw.read_bytes(), dtype=np.int16).reshape(-1, 2).astype(float) / 32768
    return tuple(float(np.sqrt((a[:, c] ** 2).mean())) for c in (0, 1))


@unittest.skipUnless(HAVE_FFMPEG, "needs ffmpeg")
class SoundKeys(unittest.TestCase):
    """The Sound tab's keyed level and pan (with its track's level and pan on them) in the mix."""
    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix="deck-sndkeys-"))
        self.tone = self.d / "tone.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:d=3", "-ac", "2", str(self.tone)], check=True)

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def mix(self, chans, level=1.0, pan=0.0):
        from app import audioedit
        out = self.d / "mix.wav"
        audioedit.render([{"path": str(self.tone), "kind": "audio", "track": "a1", "at": 0, "in": 0, "out": 3,
                           "volume": level, "pan": pan, "chans": keyexpr.with_track(chans, level, pan)}], out)
        return out

    def test_keyed_level(self):
        full = levels(self.mix(None), 1, self.d)[0]   # the tone unkeyed
        out = self.mix({"volume": [{"f": 0, "v": 0, "ease": "linear"}, {"f": 2, "v": 1}]})
        quiet, half, loud = (levels(out, t, self.d)[0] for t in (0.0, 0.9, 2.2))
        self.assertLess(quiet, 0.1 * full)
        self.assertAlmostEqual(loud / full, 1, delta=0.05)
        self.assertAlmostEqual(half / loud, 0.5, delta=0.1)   # linear: half way by 1 s

    def test_keyed_pan_and_track_level(self):
        full = levels(self.mix(None), 1, self.d)[0]
        out = self.mix({"pan": [{"f": 0, "v": -1, "ease": "linear"}, {"f": 2, "v": 1}]}, level=0.5)
        l0, r0 = levels(out, 0.0, self.d)
        l2, r2 = levels(out, 2.2, self.d)
        self.assertLess(r0, 0.15 * l0)   # left at first…
        self.assertLess(l2, 0.05 * r2)   # …right at the end
        self.assertAlmostEqual(r2 / full, 0.5, delta=0.05)   # the track's level (half) is on the keys too

    def test_with_track(self):
        c = keyexpr.with_track({"volume": [{"f": 0, "v": 1}], "pan": [{"f": 0, "v": 0.8}], "x": [{"f": 0, "v": 2}]}, 0.5, 0.5)
        self.assertEqual(c, {"volume": [{"f": 0.0, "v": 0.5}], "pan": [{"f": 0.0, "v": 1.0}]})
        self.assertIsNone(keyexpr.with_track(None))


if __name__ == "__main__":
    unittest.main()
