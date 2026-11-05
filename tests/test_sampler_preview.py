"""The sampler preview switch: off asks ComfyUI for no previews on any run; on keeps what each kind of run asks for."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock


def setUpModule():
    global comfy, config
    from app import comfy, config


IMAGE = {"1": {"class_type": "KSampler", "inputs": {}}}


class Switch(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        patch = mock.patch.object(config, "DATA_DIR", Path(tmp.name))
        patch.start()
        self.addCleanup(patch.stop)
        self.video = mock.patch.object(comfy, "is_video", return_value=True)

    def test_on_by_default_and_asks_per_kind(self):
        self.assertTrue(comfy.previews_on())
        self.assertEqual(comfy.preview_extra(IMAGE), {"preview_method": config.PREVIEW_METHOD})
        with self.video:
            self.assertTrue(comfy.preview_extra(IMAGE)["extra_pnginfo"]["workflow"]["extra"]["VHS_latentpreview"])
            self.assertEqual(comfy.preview_extra(IMAGE, "off"), {"preview_method": "none"})
            self.assertEqual(comfy.preview_extra(IMAGE, "sharp still (TAE)"), {"preview_method": "taesd"})

    def test_off_beats_every_choice_and_survives_a_second_set(self):
        self.assertFalse(comfy.set_previews(False))
        self.assertFalse(comfy.set_previews(False))
        self.assertEqual(comfy.preview_extra(IMAGE), {"preview_method": "none"})
        with self.video:
            self.assertEqual(comfy.preview_extra(IMAGE), {"preview_method": "none"})
            self.assertEqual(comfy.preview_extra(IMAGE, "sharp still (TAE)"), {"preview_method": "none"})
        self.assertTrue(comfy.set_previews(True))
        self.assertTrue(comfy.set_previews(True))
