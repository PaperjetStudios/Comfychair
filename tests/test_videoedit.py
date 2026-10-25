"""Video render: rotation and anchor land where the preview draws them. Run: .venv/bin/python -m unittest discover tests"""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app import videoedit

OLD_GRAPH = (  # what the renderer built before rotation and anchor existed (two clips, one faded and dimmed)
    '[0:v]format=yuv420p[b0];[1:v]fps=25,setpts=PTS-STARTPTS,scale=w=1024:h=576:force_original_aspect_ratio=decrease:'
    'force_divisible_by=2,setsar=1,format=yuva420p,fade=t=in:st=0:d=0.200:alpha=1,colorchannelmixer=aa=0.700,'
    'setpts=PTS+0.000/TB[o0];[b0][o0]overlay=x=(W-w)/2+128.0:y=(H-h)/2+-36.0:eof_action=pass:format=auto[b1];'
    '[2:v]fps=25,setpts=PTS-STARTPTS,scale=w=1280:h=720:force_original_aspect_ratio=increase:force_divisible_by=2,'
    'setsar=1,format=yuva420p,setpts=PTS+1.000/TB[o1];[b1][o1]overlay=x=(W-w)/2+0.0:y=(H-h)/2+0.0:eof_action=pass:'
    'format=auto[b2];[b2]format=yuv420p[v];anullsrc=r=48000:cl=stereo,atrim=0:4.000[sil];'
    '[sil]amix=inputs=1:duration=first:normalize=0[a]')


class Graph(unittest.TestCase):
    def graph(self, items):
        cap = {}
        info = {"width": 640, "height": 360, "duration": 4.0, "fps": 25.0, "video": True, "audio": False}

        def run(args, **kw):
            cap["a"] = args
            return mock.Mock(returncode=0)

        with mock.patch.object(videoedit, "probe", return_value=info), mock.patch("subprocess.run", run):
            videoedit.render(items, Path("/tmp/x.mp4"), 1280, 720, 25)
        return cap["a"][cap["a"].index("-filter_complex") + 1]

    def clips(self, **extra):
        return [{"path": "/a.mp4", "kind": "video", "track": "v1", "z": 0, "at": 0, "in": 0, "out": 2, "x": 0.1, "y": -0.05,
                 "scale": 0.8, "fit": "fit", "opacity": 0.7, "volume": 1, "fade_in": 0.2, "fade_out": 0, **extra},
                {"path": "/b.png", "kind": "image", "track": "v2", "z": 1, "at": 1, "in": 0, "out": 3, "x": 0, "y": 0,
                 "scale": 1, "fit": "fill", "opacity": 1}]

    def test_old_payload_graph_unchanged(self):
        self.assertEqual(self.graph(self.clips()), OLD_GRAPH)

    def test_defaults_spelled_out_change_nothing(self):
        self.assertEqual(self.graph(self.clips(rotation=0, anchor_x=0.5, anchor_y=0.5)), OLD_GRAPH)
        self.assertEqual(self.graph(self.clips(rotation=None, anchor_x=None, anchor_y=None)), OLD_GRAPH)

    def test_rotation_adds_filters(self):
        g = self.graph(self.clips(rotation=30))
        self.assertIn("rotate=a=30.0000*PI/180", g)
        self.assertIn("overlay=x=W/2+128.0-w/2", g)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg missing")
class Pixels(unittest.TestCase):
    """A red 80x40 picture on a 200x200 black frame, at scale 0.4 so it is drawn at 80x40."""
    W = H = 200

    @classmethod
    def setUpClass(cls):
        cls.td = tempfile.mkdtemp(prefix="deck-ve-")
        cls.png = str(Path(cls.td) / "red.png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0xff0000:s=80x40", "-frames:v", "1", cls.png], check=True)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.td, ignore_errors=True)

    def frame(self, **it):
        out = Path(self.td) / "o.mp4"
        item = {"path": self.png, "kind": "image", "track": "v1", "z": 0, "at": 0, "in": 0, "out": 0.5, "x": 0, "y": 0,
                "scale": 0.4, "fit": "fit", "opacity": 1, **it}
        info = videoedit.render([item], out, self.W, self.H, 10)
        self.assertEqual((info["width"], info["height"]), (self.W, self.H))
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(out), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                             check=True, capture_output=True).stdout
        return lambda x, y: tuple(raw[(y * self.W + x) * 3:(y * self.W + x) * 3 + 3])

    def red(self, px):
        return px[0] > 170 and px[1] < 80 and px[2] < 80

    def black(self, px):
        return max(px) < 60

    def test_plain_is_centred(self):
        f = self.frame()
        self.assertTrue(self.red(f(100, 100)) and self.red(f(65, 85)) and self.black(f(55, 100)) and self.black(f(100, 75)))

    def test_rotate_90_about_centre(self):
        f = self.frame(rotation=90)   # 80x40 becomes 40 wide, 80 tall
        self.assertTrue(self.red(f(100, 65)) and self.red(f(100, 135)))
        self.assertTrue(self.black(f(100 + 30, 100)) and self.black(f(100 - 30, 100)))

    def test_rotate_45_corner_is_transparent(self):
        f = self.frame(rotation=45)
        self.assertTrue(self.red(f(100, 100)))
        # clockwise: the long axis now runs down-right; the old top-left corner and the up-right diagonal are empty
        self.assertTrue(self.red(f(125, 125)) and self.black(f(60, 70)) and self.black(f(120, 80)))

    def test_anchor_without_rotation(self):
        f = self.frame(anchor_x=0, anchor_y=0)   # the top-left corner sits at the frame centre
        self.assertTrue(self.red(f(120, 110)) and self.black(f(90, 90)) and self.black(f(100, 100 + 50)))

    def test_anchor_and_rotation(self):
        f = self.frame(anchor_x=0, anchor_y=0.5, rotation=90)   # hinge at the left edge, swung to point down
        self.assertTrue(self.red(f(100, 140)) and self.red(f(100, 175)))
        self.assertTrue(self.black(f(100, 60)) and self.black(f(150, 100)) and self.black(f(60, 100)))

    def test_anchor_follows_position(self):
        f = self.frame(anchor_x=1, anchor_y=1, x=0.25, y=0.25, rotation=180)   # bottom-right corner at (150,150), turned over
        self.assertTrue(self.red(f(170, 170)) and self.black(f(130, 130)) and self.black(f(100, 100)))


if __name__ == "__main__":
    unittest.main()
