"""Clip importer: preview stream choice, the cut's filters, the span check, the folder guard and one real cut.
Run: .venv/bin/python -m unittest discover tests"""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import HTTPException

ci = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global ci
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    from app import clipimport
    ci = clipimport


def fmt(fid, h=None, v="avc1.4D401E", a="none", proto="https", ext="mp4", **kw):
    return {"format_id": fid, "height": h, "vcodec": v if h else "none", "acodec": a, "protocol": proto, "ext": ext,
            "url": f"https://x/{fid}", **kw}


class Preview(unittest.TestCase):
    def test_muxed_h264_wins(self):
        fs = [fmt("v480", 480), fmt("m360", 360, a="mp4a.40.2"), fmt("a", None, a="mp4a.40.2", ext="m4a")]
        v, a = ci.pick_preview(fs)
        self.assertEqual((v["format_id"], a), ("m360", None))

    def test_video_only_gets_the_original_language_sound(self):
        fs = [fmt("vp9", 480, v="vp9", ext="webm"), fmt("h480", 480), fmt("h1080", 1080),
              fmt("dub", None, a="mp4a.40.2", ext="m4a", language_preference=-1),
              fmt("orig", None, a="mp4a.40.2", ext="m4a", language_preference=10, abr=128),
              fmt("orig_lo", None, a="mp4a.40.5", ext="m4a", language_preference=10, abr=48)]
        v, a = ci.pick_preview(fs)
        self.assertEqual((v["format_id"], a["format_id"]), ("h480", "orig_lo"))

    def test_formats_without_codecs_still_count_as_video(self):
        # some sites only give the size: no vcodec / acodec at all
        fs = [dict(fmt("sd", 480), vcodec=None, acodec=None), dict(fmt("hd", 1920), vcodec=None, acodec=None)]
        v, a = ci.pick_preview(fs)
        self.assertEqual((v["format_id"], a), ("sd", None))
        self.assertTrue(ci._has_v(fs[1]))
        self.assertFalse(ci._has_v(fmt("a", None, a="mp4a.40.2")))

    def test_streaming_only_has_no_preview(self):
        self.assertEqual(ci.pick_preview([fmt("hls", 480, proto="m3u8_native")]), (None, None))


class Filters(unittest.TestCase):
    def test_crop_then_size_even(self):
        vf = ci._vf({"x": 0.25, "y": 0, "w": 0.5, "h": 1}, 720)[1]
        self.assertTrue(vf.startswith("crop=trunc(iw*0.50000/2)*2:trunc(ih*1.00000/2)*2:trunc(iw*0.25000)"))
        self.assertIn("scale=-2:'min(720,trunc(ih/2)*2)'", vf)

    def test_plain(self):
        self.assertEqual(ci._vf(None, None), ["-vf", "format=yuv420p"])

    def test_span(self):
        self.assertEqual(ci._span({"start": 2, "end": 9}, 5.0), (2.0, 3.0))
        with self.assertRaises(HTTPException):
            ci._span({"start": 4, "end": 4.01}, None)
        with self.assertRaises(HTTPException):
            ci._span({"start": 1}, None)


class Roots(unittest.TestCase):
    def test_outside_is_refused(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.dict(os.environ, {"DECK_CLIP_ROOTS": d}):
            (Path(d) / "a.mp4").write_bytes(b"")
            self.assertEqual(ci._inside_roots(str(Path(d) / "a.mp4")), (Path(d) / "a.mp4").resolve())
            for bad in ("/etc/passwd", f"{d}/../x.mp4"):
                with self.assertRaises(HTTPException) as e:
                    ci._inside_roots(bad)
                self.assertEqual(e.exception.status_code, 403)
            with self.assertRaises(HTTPException):
                ci._video_file(str(Path(d)))   # a folder, not a video


class Sweep(unittest.TestCase):
    def test_ages_cap_and_busy(self):
        import time
        with tempfile.TemporaryDirectory() as d, mock.patch.object(ci, "TMP", Path(d)), \
                mock.patch.object(ci, "TMP_CAP", 200), mock.patch.dict(ci.JOBS, clear=True):
            now = time.time()
            def put(name, age, size=10):
                p = Path(d) / name
                p.write_bytes(b"x" * size)
                os.utime(p, (now - age, now - age))
                return p
            old_link, new_link = put("link_a.mp4", 4 * 3600), put("link_b.mp4", 60)
            proxy = put("proxy_c.mp4", 2 * 86400)
            stray, busy = put("up_d.mov", 2 * 3600), put("up_e.mov", 2 * 3600)
            big_old, big_new = put("link_f.mp4", 600, 200), put("link_g.mp4", 30, 20)
            ci.JOBS["j"] = {"state": "running", "writing": "up_e.mov"}
            ci.sweep()
            gone = [p.name for p in (old_link, new_link, proxy, stray, busy, big_old, big_new) if not p.exists()]
            self.assertEqual(sorted(gone), ["link_a.mp4", "link_f.mp4", "proxy_c.mp4", "up_d.mov"])   # over the cap: least recently used first


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class Cut(unittest.TestCase):
    def test_exact_piece(self):
        with tempfile.TemporaryDirectory() as d:
            src, out = Path(d) / "src.mp4", Path(d) / "out.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x240:r=25:d=6", "-f", "lavfi",
                            "-i", "sine=d=6", "-c:v", "libx264", "-g", "50", "-shortest", str(src)], check=True)
            job = {"cancel": False, "progress": 0}
            ci._encode(job, [(str(src), [])], 2.0, 1.5, {"x": 0, "y": 0, "w": 0.5, "h": 0.5}, None, out)
            info = ci.videoedit.probe(out)
            self.assertAlmostEqual(info["duration"], 1.5, delta=0.05)
            self.assertEqual((info["width"], info["height"]), (160, 120))
            self.assertTrue(info["audio"])
            self.assertFalse(out.with_suffix(".part.mp4").exists())


if __name__ == "__main__":
    unittest.main()
