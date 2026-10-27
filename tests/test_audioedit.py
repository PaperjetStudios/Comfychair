"""Sound: extract, mix and lay with real ffmpeg on generated tones; audio fields in templates.
Run: .venv/bin/python -m unittest discover tests"""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from app import audioedit, templates as tpl, videoedit

HAVE_FFMPEG = bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def tone(path: Path, secs: float, freq=440, video=False):
    src = ["-f", "lavfi", "-i", f"sine=frequency={freq}:duration={secs}"]
    if video:
        src = ["-f", "lavfi", "-i", f"color=c=gray:s=64x64:d={secs}"] + src
    subprocess.run(["ffmpeg", "-v", "error", "-y", *src, *(["-c:v", "libx264", "-pix_fmt", "yuv420p"] if video else []),
                    "-c:a", "aac" if path.suffix in (".mp4", ".m4a") else "pcm_s16le", "-shortest", str(path)], check=True)
    return path


@unittest.skipUnless(HAVE_FFMPEG, "ffmpeg not installed")
class Ffmpeg(unittest.TestCase):
    def setUp(self):
        self.td = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.td)

    def test_extract_cuts_the_sound_of_a_clip(self):
        clip = tone(self.td / "c.mp4", 3, video=True)
        info = audioedit.extract(clip, self.td / "s.m4a", {"start": 0.5, "len": 1.5})
        self.assertFalse(info["video"])
        self.assertTrue(info["audio"])
        self.assertAlmostEqual(info["duration"], 1.5, delta=0.1)

    def test_extract_refuses_a_silent_clip(self):
        silent = self.td / "v.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=1", "-pix_fmt", "yuv420p", str(silent)], check=True)
        with self.assertRaises(ValueError):
            audioedit.extract(silent, self.td / "s.wav")

    def test_render_mixes_tracks_to_the_last_end(self):
        a, b = tone(self.td / "a.wav", 2), tone(self.td / "b.wav", 2, 660)
        info = audioedit.render([
            {"path": str(a), "kind": "audio", "track": "a1", "at": 0, "in": 0, "out": 2, "volume": 1.5, "fade_in": 0.3},
            {"path": str(b), "kind": "audio", "track": "a2", "at": 1.5, "in": 0.5, "out": 2, "pan": -0.5},
        ], self.td / "mix.wav", gain=0.8)
        self.assertAlmostEqual(info["duration"], 3.0, delta=0.05)

    def test_lay_replaces_the_sound_and_keeps_the_clip_length(self):
        clip = tone(self.td / "c.mp4", 2, video=True)
        snd = tone(self.td / "s.wav", 5, 880)
        info = audioedit.lay(clip, snd, self.td / "out.mp4", "replace", at=0.5)
        self.assertTrue(info["video"] and info["audio"])
        self.assertAlmostEqual(info["duration"], 2.0, delta=0.1)

    def test_prep_keeps_a_loadable_file_and_converts_a_clip(self):
        wav = tone(self.td / "a.wav", 1)
        self.assertEqual(audioedit.prep(wav), wav)
        clip = tone(self.td / "c.mp4", 1, video=True)
        with mock.patch.object(audioedit.config, "VIDEOPREP_DIR", self.td):
            out = audioedit.prep(clip)
            self.assertEqual(out.suffix, ".flac")
            self.assertEqual(audioedit.prep(clip), out)   # cached


class MixGraph(unittest.TestCase):
    def test_pan_and_fades_in_the_filter(self):
        it = {"kind": "audio", "info": {"audio": True}, "at": 1.0, "len": 2.0, "xin": 0.0, "xout": 0.5,
              "volume": 0.5, "pan": 0.5, "fade_in": 0.2}
        mix = ";".join(videoedit.mix_filters([it], {id(it): 0}, 3.0))
        self.assertIn("pan=stereo|c0=0.500*c0|c1=1.000*c1", mix)
        self.assertIn("afade=t=in:st=0:d=0.200", mix)
        self.assertIn("afade=t=out:st=1.500:d=0.500", mix)
        self.assertIn("adelay=1000|1000", mix)


class Templates(unittest.TestCase):
    WF = {
        "snd": {"class_type": "VHS_LoadAudio", "inputs": {"audio_file": ""}, "_meta": {"title": "@1 Voice [audio_file]"}},
        "m": {"class_type": "UNETLoader", "inputs": {"unet_name": "x"}},
        "c": {"class_type": "CLIPTextEncode", "inputs": {"text": "hi"}},
        "ref": {"class_type": "LTXVReferenceAudio", "inputs": {"model": ["m", 0], "positive": ["c", 0], "negative": ["c", 0],
                "reference_audio": ["snd", 0]}, "_meta": {"title": "voice", "deck_passthrough": ["model", "positive", "negative"]}},
        "g": {"class_type": "CFGGuider", "inputs": {"model": ["ref", 0], "positive": ["ref", 1], "negative": ["ref", 2]}},
    }

    def test_audio_field(self):
        f = tpl._field("snd", "VHS_LoadAudio", "audio_file", "", None)
        self.assertEqual((f["kind"], f["label"], f["value"]), ("audio", "Sound", None))

    def test_empty_sound_passes_model_and_conditioning_through(self):
        wf = tpl.apply(self.WF, {"snd.audio_file": None})
        self.assertNotIn("ref", wf)
        self.assertEqual(wf["g"]["inputs"], {"model": ["m", 0], "positive": ["c", 0], "negative": ["c", 0]})

    def test_picked_sound_keeps_the_node(self):
        wf = tpl.apply(self.WF, {"snd.audio_file": "/v.flac"})
        self.assertEqual(wf["snd"]["inputs"]["audio_file"], "/v.flac")
        self.assertEqual(wf["g"]["inputs"]["model"], ["ref", 0])


if __name__ == "__main__":
    unittest.main()
