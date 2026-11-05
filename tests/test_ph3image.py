"""P-H3-Image and Pika H3 Flex templates: the upsampler is wired for the run's pictures, and the fixed schedules.
Run with: DECK_DATA=$(mktemp -d) .venv/bin/python -m pytest -q tests/test_ph3image.py"""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = ROOT / "templates"
tpl = ph3 = editsize = h3upscale = None


def setUpModule():
    global tpl, ph3, editsize, h3upscale
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))  # never the real data/
    from app import editsize as e, h3upscale as h, ph3image, templates
    tpl, ph3, editsize, h3upscale = templates, ph3image, e, h


def load(name):
    return json.loads((TEMPLATES / f"{name}.json").read_text())


def generator(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "dev" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def links_ok(test, wf):
    for nid, node in wf.items():
        for name, v in node["inputs"].items():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                test.assertIn(v[0], wf, f"{nid}.{name} points at a node that is gone")


class TextToImage(unittest.TestCase):
    def run_with(self, **values):
        return ph3.inject(tpl.apply(load("deck-ph3-t2i"), values), values)

    def test_upsampler_writes_the_prompt(self):
        wf = self.run_with(**{"6.prompt": "a red kite", "6.width": 2720, "6.height": 1536})
        self.assertEqual(wf["6"]["inputs"]["prompt"], ["31", 0])
        self.assertEqual(wf["31"]["inputs"]["prompt"], "Aspect ratio: 16:9\nRequest: a red kite")
        self.assertTrue(wf["31"]["inputs"]["thinking"])
        self.assertNotIn("image", wf["31"]["inputs"])
        self.assertNotIn("32", wf)   # the on/off setting is not a node the run needs
        links_ok(self, wf)

    def test_off_leaves_the_prompt_and_takes_the_upsampler_out(self):
        wf = self.run_with(**{"6.prompt": "a red kite", "32.value": False})
        self.assertEqual(wf["6"]["inputs"]["prompt"], "a red kite")
        for gone in ("30", "31", "32"):   # its 7 GB loader too: nothing else reads it
            self.assertNotIn(gone, wf)
        links_ok(self, wf)

    def test_shapes(self):
        self.assertEqual(ph3.ratio(2048, 2048), "1:1")
        self.assertEqual(ph3.ratio(2176, 3872), "9:16")
        self.assertEqual(ph3.ratio(1664, 2496), "2:3")
        self.assertEqual(ph3.ratio(0, 0), "1:1")

    def test_schedule(self):
        wf = load("deck-ph3-t2i")
        self.assertEqual(len(wf["9"]["inputs"]["sigmas"].split(",")), 9)   # 8 steps
        self.assertEqual(wf["5"]["inputs"]["shift_video"], 1.0)
        self.assertEqual(wf["10"]["class_type"], "BasicGuider")   # no CFG, no negative


class Edit(unittest.TestCase):
    def run_with(self, values):
        return ph3.inject(tpl.apply(load("deck-ph3-edit"), values), values)

    def pictures(self, *names):
        values = {f"{20 + i}.image": "" for i in range(8)}
        values.update({f"{20 + i}.image": n for i, n in enumerate(names)})
        return values

    def test_one_picture(self):
        wf = self.run_with({**self.pictures("a.png"), "6.prompt": "make it night"})
        g = wf["31"]["inputs"]
        self.assertEqual(g["prompt"].count("<|image_pad|>"), 1)
        self.assertIn("Edit <Picture 1>. make it night<|im_end|>", g["prompt"])
        self.assertTrue(g["prompt"].endswith("<think>\n"))
        self.assertFalse(g["thinking"])
        self.assertEqual(wf[g["image"][0]]["class_type"], "ImageScaleToTotalPixels")   # no batch for one picture
        self.assertEqual([k for k in wf["6"]["inputs"] if k.startswith("images.")], ["images.image_1"])
        links_ok(self, wf)

    def test_references_are_named_and_padded(self):
        wf = self.run_with({**self.pictures("a.png", "b.png", "", "d.png"), "6.prompt": "the hat from <Picture 2>"})
        g = wf["31"]["inputs"]
        self.assertEqual(g["prompt"].count("<|image_pad|>"), 3)   # the empty slot closed up
        self.assertIn("<Picture 3>: <|vision_start|>", g["prompt"])
        batch = wf[g["image"][0]]
        self.assertEqual(batch["class_type"], "BatchImagesNode")
        self.assertEqual(sorted(batch["inputs"]), ["images.image0", "images.image1", "images.image2"])
        self.assertEqual(wf[batch["inputs"]["images.image1"][0]]["class_type"], "ResizeAndPadImage")
        self.assertEqual(wf["6"]["inputs"]["images.image_3"], ["23", 0])
        links_ok(self, wf)

    def test_an_edit_brief_is_not_prefixed_twice(self):
        wf = self.run_with({**self.pictures("a.png"), "6.prompt": "Edit <Picture 1>. Remove the sign."})
        self.assertEqual(wf["31"]["inputs"]["prompt"].count("Edit <Picture 1>."), 1)

    def test_the_size_reaches_the_node(self):
        values = {**self.pictures("a.png", "b.png"), "6.prompt": "x", editsize.WIDTH: 1552, editsize.HEIGHT: 1024}
        wf = self.run_with(values)
        self.assertEqual((wf["6"]["inputs"]["width"], wf["6"]["inputs"]["height"]), (1536, 1024))

    def test_size_picker_steps_by_32(self):
        t = tpl.Template(id="deck-ph3-edit", name="x", path=TEMPLATES / "deck-ph3-edit.json", workflow=load("deck-ph3-edit"))
        fields = tpl.describe(t, None)["fields"]
        width = next(f for f in fields if f["key"] == editsize.WIDTH)
        self.assertEqual(width["step"], 32)

    def test_other_templates_are_left_alone(self):
        wf = load("deck-qwen21-edit")
        self.assertEqual(ph3.inject(json.loads(json.dumps(wf)), {}), wf)


class Pika(unittest.TestCase):
    NAMES = ("deck-h3-pika-ref2v", "deck-h3-pika-i2v", "deck-h3-pika-flf2v")

    def test_schedule_and_lora(self):
        for name in self.NAMES:
            wf = load(name)
            self.assertEqual(wf["9"]["inputs"]["sampler_name"], "lcm", name)
            self.assertEqual(wf["10"]["class_type"], "ManualSigmas", name)
            self.assertEqual(len(wf["10"]["inputs"]["sigmas"].split(",")), 7, name)   # six steps
            loras = [n for n in wf.values() if n["class_type"] == "LoraLoaderModelOnly"]
            fixed = [n for n in loras if not n["_meta"]["title"].startswith("@")]
            self.assertEqual(len(fixed), 1, name)
            self.assertIn("pika_h3_flex", fixed[0]["inputs"]["lora_name"], name)
            self.assertEqual(fixed[0]["inputs"]["strength_model"], 1.0, name)
            self.assertFalse(any("turbo" in n["_meta"]["title"].lower() for n in loras), name)   # nothing to stack on it
            links_ok(self, wf)

    def test_reference_slots(self):
        ins = load("deck-h3-pika-ref2v")["7"]["inputs"]
        self.assertEqual(len([k for k in ins if k.startswith("ref_images.")]), 9)
        self.assertEqual(len([k for k in ins if k.startswith("ref_audios.")]), 3)

    def test_empty_slots_drop(self):
        values = {f"{n}.image": "" for n in (20, 21, 22, 23, 31, 32, 33, 34, 35)}
        values.update({"20.image": "a.png", "32.image": "b.png", "24.audio_file": "", "25.audio_file": "", "36.audio_file": ""})
        wf = tpl.apply(load("deck-h3-pika-ref2v"), values)
        ins = wf["7"]["inputs"]
        self.assertEqual(sorted(k for k in ins if k.startswith("ref_")),
                         ["ref_image_size", "ref_images.ref_image_0", "ref_images.ref_image_1"])
        links_ok(self, wf)

    def test_comes_out_under_a_regenerate_lora_with_turbo_inside(self):
        wf = load("deck-h3-pika-i2v")
        h3upscale.drop_turbo(wf, wf["11"]["inputs"]["model"])
        self.assertNotIn("30", wf)
        self.assertEqual(wf["11"]["inputs"]["model"], ["6", 0])


class KleinPose(unittest.TestCase):
    """RefControl: picture 1 is the pose map, picture 2 the character, and the LoRA's trigger sentence."""

    def test_two_pictures_in_order(self):
        wf = load("deck-klein9b-pose")
        ins = wf["10"]["inputs"]
        self.assertEqual([k for k in ins if k.startswith("images.")], ["images.image0", "images.image1"])
        self.assertIn("Pose", wf[ins["images.image0"][0]]["_meta"]["title"])
        self.assertIn("Character", wf[ins["images.image1"][0]]["_meta"]["title"])
        self.assertEqual(wf["15"]["inputs"]["image"], ["14", 0])   # the output takes the pose picture's shape
        self.assertEqual(wf["14"]["inputs"]["image"], ["20", 0])
        links_ok(self, wf)

    def test_lora_and_trigger(self):
        wf = load("deck-klein9b-pose")
        self.assertEqual(wf["8"]["inputs"]["text"], "apply pose from image 1 with reference from image 2")
        self.assertIn("refcontrol", wf["30"]["inputs"]["lora_name"])
        self.assertEqual(wf["24"]["inputs"]["model"], ["30", 0])
        self.assertEqual(wf["30"]["inputs"]["model"], ["4", 0])   # after the user's own LoRAs
        wf = tpl.apply(wf, {"20.image": "pose.png", "21.image": "who.png", "4.__loras": []})
        self.assertEqual(wf["30"]["inputs"]["model"], ["1", 0])   # the empty stack is taken out, the pose LoRA stays
        links_ok(self, wf)


class Generators(unittest.TestCase):
    """The checked-in templates are what dev/make_*.py write."""

    def test_pika(self):
        g = generator("make_pika_templates")
        for base, name, lora, prefix in g.BASES:
            self.assertEqual(g.pika(base, lora, prefix), load(name), name)

    def test_ph3(self):
        g = generator("make_ph3_templates")
        self.assertEqual(g.t2i(), load("deck-ph3-t2i"))
        self.assertEqual(g.edit(), load("deck-ph3-edit"))

    def test_klein_pose(self):
        self.assertEqual(generator("make_control_templates").klein_pose(), load("deck-klein9b-pose"))


if __name__ == "__main__":
    unittest.main()
