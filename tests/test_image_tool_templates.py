"""The Image tools' clean-up templates: what the panel (web/imagetools.js) relies on."""
import json
import unittest
from pathlib import Path

from app import maskcomp, templates

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


class Faces(unittest.TestCase):
    def test_the_face_model_runs_through_its_own_node(self):
        wf = load("deck-face-restore")
        self.assertEqual(wf["up"]["class_type"], "DeckFaceRestore")   # (core's Upscale Image gives it a tensor it can't take)
        self.assertEqual(wf["um"]["class_type"], "UpscaleModelLoader")
        self.assertEqual(wf["um"]["inputs"]["model_name"], "GFPGANv1.4.safetensors")
        self.assertEqual(wf["save"]["inputs"]["images"], ["up", 0])
        self.assertTrue(wf["img"]["_meta"]["deck_keep_size"])


class FaceSkin(unittest.TestCase):
    def test_the_workflow_has_the_lora_the_panel_checks_for(self):
        wf = load("deck-klein9b-face-skin")
        lora = wf["4"]["inputs"]["lora_name"]
        self.assertEqual(lora, "klein/Flux2 Klein 9B Realistic Detail LoRA.safetensors")
        self.assertEqual(wf["4"]["inputs"]["strength_model"], 1.0)
        self.assertEqual(wf["8"]["inputs"]["denoise"], 0.3)
        panel = (TEMPLATES.parent / "web" / "imagetools.js").read_text()
        self.assertIn("deck-klein9b-face-skin", panel)
        self.assertIn(lora, panel)

    def test_only_the_face_changes_at_the_pictures_own_size(self):
        wf = load("deck-klein9b-face-skin")
        self.assertEqual(wf["31"]["inputs"]["text_prompt"], "face")
        self.assertEqual(wf["32"]["inputs"]["image"], ["20", 0])
        self.assertEqual(wf["34"]["inputs"]["destination"], ["20", 0])
        self.assertEqual(wf["34"]["inputs"]["source"], ["9", 0])
        self.assertEqual(wf["10"]["inputs"]["images"], ["34", 0])
        self.assertTrue(wf["20"]["_meta"]["deck_keep_size"])

    def test_a_big_part_on_a_large_picture_is_not_cut_to_a_patch(self):
        for name in ("deck-klein9b-face-skin", "deck-klein9b-detail", "deck-krea2-detail", "deck-qwen21-detail"):
            self.assertEqual(load(name)["32"]["inputs"]["max_crop_resolution"], 16384)


class SkinWhole(unittest.TestCase):
    def test_the_model_sees_the_whole_picture_with_the_lora_the_panel_checks_for(self):
        wf = load("deck-klein9b-skin-whole")
        classes = {n["class_type"] for n in wf.values()}
        self.assertFalse(classes & {"SAM3Grounding", "ImageCropByMaskAndResize", "ImageUncropByMask"})
        lora = next(n for n in wf.values() if n["class_type"] == "LoraLoaderModelOnly")["inputs"]["lora_name"]
        panel = (TEMPLATES.parent / "web" / "imagetools.js").read_text()
        self.assertIn("deck-klein9b-skin-whole", panel)
        self.assertIn(lora, panel)


class Edit(unittest.TestCase):
    def test_the_panels_knobs_are_fields_of_the_template(self):
        t = templates.get(TEMPLATES, "deck-qwen21-edit")
        inputs = {(f["key"]) for f in templates.describe(t, None)["fields"]}
        for key in ("9.sigmas", "10.cfg", "5.prompt", "5.negative_prompt", "4.__loras", "7.noise_seed", "20.image", "21.image"):
            self.assertIn(key, inputs)

    def test_the_default_is_the_turbo_models_own_settings(self):
        wf = load("deck-qwen21-edit")
        self.assertEqual(wf["10"]["inputs"]["cfg"], 1.0)
        self.assertEqual(len(wf["9"]["inputs"]["sigmas"].split(",")), 9)   # (8 steps)


class QwenDetail(unittest.TestCase):
    def test_its_decoded_alpha_is_dropped_before_the_face_goes_back(self):
        wf = load("deck-qwen21-detail")   # (the Qwen 2.1 VAE gives RGBA, which ImageUncropByMask refuses)
        self.assertEqual(wf["35"]["class_type"], "SplitImageWithAlpha")
        self.assertEqual(wf["35"]["inputs"]["image"], ["12", 0])
        self.assertEqual(wf["34"]["inputs"]["source"], ["35", 0])


if __name__ == "__main__":
    unittest.main()
