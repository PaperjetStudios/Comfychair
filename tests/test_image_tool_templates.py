"""The Image tools' clean-up templates: what the panel (web/imagetools.js) relies on."""
import json
import unittest
from pathlib import Path

from app import maskcomp

TEMPLATES = Path(__file__).resolve().parent.parent / "templates"


def load(name):
    return json.loads((TEMPLATES / f"{name}.json").read_text())


class Remove(unittest.TestCase):
    def test_lama_takes_the_picture_and_its_own_mask(self):
        wf = load("deck-remove-lama")
        self.assertEqual(wf["fill"]["inputs"]["images"], ["img", 0])
        self.assertEqual(wf["fill"]["inputs"]["masks"], ["mask", 0])
        self.assertEqual(maskcomp._mask_nodes(wf), ["mask"])   # (so a run without a mask is refused)
        self.assertTrue(wf["img"]["_meta"]["deck_keep_size"])


class Clean(unittest.TestCase):
    def test_the_models_the_panel_names_keep_the_size(self):
        wf = load("deck-clean-image")
        self.assertEqual(wf["up"]["inputs"]["upscale_model"], ["um", 0])
        self.assertEqual(wf["save"]["inputs"]["images"], ["up", 0])
        self.assertIn("[model_name]", wf["um"]["_meta"]["title"])
        panel = (TEMPLATES.parent / "web" / "imagetools.js").read_text()
        for model in ("1x_ISO_denoise_v1.pth", "DeJpeg_Fatality_PlusULTRA_200000_G.pth", "1x_DeBLR.pth"):
            self.assertIn(model, panel)


if __name__ == "__main__":
    unittest.main()
