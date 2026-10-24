"""Tests for the pure workflow functions. Run with: .venv/bin/python -m unittest discover tests"""
import os
import random
import tempfile
import unittest

os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))  # before app.config makes its folders
COMFY = tempfile.mkdtemp(prefix="deck-test-comfy-")  # a stand-in ComfyUI folder
for d in ("output/comfydeck/Sandbox", "input/comfydeck"):
    os.makedirs(os.path.join(COMFY, d))
os.environ["DECK_COMFY_DIR"] = COMFY

import time  # noqa: E402
from pathlib import Path  # noqa: E402

from app import accel, editsize, main, wildcards  # noqa: E402
from app import templates as tpl  # noqa: E402


def wf_basic():
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "m.safetensors"}},
        "2": {"class_type": "LoraLoader", "_meta": {"title": "@LoRAs"},
              "inputs": {"model": ["1", 0], "clip": ["1", 1], "lora_name": "a.safetensors",
                         "strength_model": 1.0, "strength_clip": 1.0}},
        "3": {"class_type": "CLIPTextEncode", "_meta": {"title": "@1 Prompt"}, "inputs": {"text": "hi", "clip": ["2", 1]}},
        "4": {"class_type": "KSampler", "_meta": {"title": "@Sampler [seed,steps]"},
              "inputs": {"model": ["2", 0], "seed": 1, "steps": 20, "cfg": 7.0, "positive": ["3", 0]}},
        "5": {"class_type": "LoadImage", "_meta": {"title": "@Ref"}, "inputs": {"image": "x.png"}},
        "6": {"class_type": "RefNode", "inputs": {"ref_images.ref_image_0": ["5", 0], "ref_images.ref_image_1": ["7", 0]}},
        "7": {"class_type": "LoadImage", "inputs": {"image": "y.png"}},
    }


class Wildcards(unittest.TestCase):
    def test_has(self):
        self.assertTrue(wildcards.has("a {b|c} d"))
        self.assertFalse(wildcards.has("json {\"a\": 1}"))
        self.assertFalse(wildcards.has("unclosed {a|b"))
        self.assertFalse(wildcards.has(None))

    def test_expand_picks_an_option(self):
        rng = random.Random(1)
        for _ in range(20):
            self.assertIn(wildcards.expand("{red|green|blue} car", rng), ("red car", "green car", "blue car"))

    def test_nested_and_empty(self):
        rng = random.Random(3)
        seen = {wildcards.expand("{a {big|small} dog|a cat}", rng) for _ in range(60)}
        self.assertEqual(seen, {"a big dog", "a small dog", "a cat"})
        self.assertEqual({wildcards.expand("{wet |}road", rng) for _ in range(40)}, {"wet road", "road"})

    def test_literal_braces_survive(self):
        self.assertEqual(wildcards.expand("keep {this} and {a|a}"), "keep {this} and a")
        self.assertEqual(wildcards.expand("odd } and { x"), "odd } and { x")


class Templates(unittest.TestCase):
    def test_describe_fields(self):
        t = tpl.Template(id="t", name="t", path=None, workflow=wf_basic())
        d = tpl.describe(t, None)
        keys = {f["key"] for f in d["fields"]}
        self.assertIn("3.text", keys)
        self.assertIn("4.seed", keys)
        self.assertIn("4.steps", keys)
        self.assertNotIn("4.cfg", keys)  # not in the [seed,steps] list
        self.assertEqual(next(f for f in d["fields"] if f["key"] == "4.seed")["kind"], "seed")
        self.assertEqual(d["groups"][0]["label"], "Prompt")  # @1 orders it first

    def test_lora_stack_expands_to_a_chain(self):
        wf = tpl.apply(wf_basic(), {"2.__loras": [{"name": "a", "strength": 0.5}, {"name": "b", "strength": 1}]})
        chain = [n for n in wf.values() if n["class_type"] == "LoraLoader"]
        self.assertEqual(len(chain), 2)
        last = next(k for k, n in wf.items() if n["class_type"] == "LoraLoader" and n["inputs"]["lora_name"] == "b")
        self.assertEqual(wf["4"]["inputs"]["model"], [last, 0])
        self.assertEqual(wf["3"]["inputs"]["clip"], [last, 1])

    def test_empty_lora_stack_is_bypassed(self):
        wf = tpl.apply(wf_basic(), {"2.__loras": []})
        self.assertNotIn("2", wf)
        self.assertEqual(wf["4"]["inputs"]["model"], ["1", 0])
        self.assertEqual(wf["3"]["inputs"]["clip"], ["1", 1])

    def test_disabled_loras_are_skipped(self):
        wf = tpl.apply(wf_basic(), {"2.__loras": [{"name": "a", "enabled": False}]})
        self.assertNotIn("2", wf)

    def test_empty_image_drops_node_and_closes_autogrow_gap(self):
        wf = tpl.apply(wf_basic(), {"5.image": ""})
        self.assertNotIn("5", wf)
        self.assertEqual(wf["6"]["inputs"], {"ref_images.ref_image_0": ["7", 0]})

    def test_values_are_set(self):
        wf = tpl.apply(wf_basic(), {"4.steps": 8, "3.text": "yo"})
        self.assertEqual(wf["4"]["inputs"]["steps"], 8)
        self.assertEqual(wf["3"]["inputs"]["text"], "yo")


class Accel(unittest.TestCase):
    def test_attention_patch_goes_before_the_sampler(self):
        wf = accel.inject(tpl.apply(wf_basic(), {}), {accel.ATTENTION: "pytorch"})
        patch = wf[wf["4"]["inputs"]["model"][0]]
        self.assertEqual(patch["class_type"], "ModelAttentionBackend")
        self.assertEqual(patch["inputs"]["model"], ["2", 0])

    def test_default_adds_nothing(self):
        wf = tpl.apply(wf_basic(), {})
        self.assertEqual(accel.inject(dict(wf), {}), wf)


class EditSize(unittest.TestCase):
    def test_scale_node_is_inserted_after_image_1(self):
        wf = {
            "1": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
            "2": {"class_type": "ImageScaleToTotalPixels", "inputs": {"image": ["1", 0]}},
            "3": {"class_type": "VAEEncode", "inputs": {"pixels": ["2", 0]}},
        }
        fields = [{"key": "1.image", "kind": "image", "node": "1", "group": "Image"}]
        sf = editsize.fields(wf, fields)
        self.assertEqual([f["key"] for f in sf], [editsize.WIDTH, editsize.HEIGHT])
        out = editsize.inject(wf, {editsize.WIDTH: 768, editsize.HEIGHT: 512}, fields + sf)
        scale = next(k for k, n in out.items() if n["class_type"] == "ImageScale")
        self.assertEqual(out["3"]["inputs"]["pixels"], [scale, 0])  # the ~1 MP rescale is skipped
        self.assertEqual((out[scale]["inputs"]["width"], out[scale]["inputs"]["height"]), (768, 512))


def wf_upscale():
    return {
        "1": {"class_type": "LoadImage", "_meta": {"title": "@1 Image"}, "inputs": {"image": ""}},
        "2": {"class_type": "SeedVR2Preprocess", "inputs": {"resized_images": ["1", 0]}},
        "3": {"class_type": "VHS_LoadVideoPath", "_meta": {"title": "@2 Video [video]"},
              "inputs": {"video": "", "frame_load_cap": 0}},
        "4": {"class_type": "Sink", "inputs": {"images": ["3", 0]}},
    }


class VideoAndUpscale(unittest.TestCase):
    def test_video_field_and_full_size_images(self):
        d = tpl.describe(tpl.Template(id="u", name="u", path=None, workflow=wf_upscale()), None)
        kinds = {f["key"]: f for f in d["fields"]}
        self.assertEqual(kinds["3.video"]["kind"], "video")
        self.assertNotIn("3.frame_load_cap", kinds)  # [video] limits the group to that input
        self.assertEqual(kinds["1.image"]["mp"], 0)
        self.assertNotIn(editsize.WIDTH, kinds)  # upscalers get no crop-to-size picker

    def test_empty_video_drops_the_loader(self):
        wf = tpl.apply(wf_upscale(), {"3.video": None})
        self.assertNotIn("3", wf)
        self.assertNotIn("images", wf["4"]["inputs"])

    def test_picked_video_is_kept(self):
        wf = tpl.apply(wf_upscale(), {"3.video": "/x/clip.mp4"})
        self.assertEqual(wf["3"]["inputs"]["video"], "/x/clip.mp4")


class Housekeeping(unittest.TestCase):
    def setUp(self):
        self.ours = Path(os.environ["DECK_DATA"]) / "ours.png"
        self.ours.write_bytes(b"x" * 100)
        self.g = {"id": 1, "project_id": 1}  # project 1 is the default "Sandbox"

    def test_recorded_copy_found_when_same_size(self):
        theirs = Path(COMFY) / "output/comfydeck/Sandbox/a_00001_.png"
        theirs.write_bytes(b"y" * 100)
        o = {"filename": "a_00001_.png", "comfy": {"filename": "a_00001_.png", "subfolder": "comfydeck/Sandbox", "type": "output"}}
        self.assertEqual(main.comfy_copy(self.g, o, self.ours), theirs.resolve())

    def test_different_size_is_left_alone(self):
        (Path(COMFY) / "output/comfydeck/Sandbox/b.png").write_bytes(b"y" * 99)
        o = {"filename": "b.png", "comfy": {"filename": "b.png", "subfolder": "comfydeck/Sandbox", "type": "output"}}
        self.assertIsNone(main.comfy_copy(self.g, o, self.ours))

    def test_old_outputs_found_by_name(self):
        theirs = Path(COMFY) / "output/comfydeck/c.mp4"  # the old flat layout
        theirs.write_bytes(b"z" * 100)
        self.assertEqual(main.comfy_copy(self.g, {"filename": "c.mp4"}, self.ours), theirs.resolve())

    def test_never_outside_the_output_folder(self):
        o = {"filename": "x", "comfy": {"filename": "../../etc/passwd", "subfolder": "", "type": "output"}}
        self.assertIsNone(main.comfy_copy(self.g, o, self.ours))
        self.assertIsNone(main.comfy_copy(self.g, {**o, "comfy": {**o["comfy"], "type": "temp"}}, self.ours))

    def test_old_crops_pruned(self):
        old, new = Path(COMFY) / "input/comfydeck/crop_old.png", Path(COMFY) / "input/comfydeck/crop_new.png"
        keep = Path(COMFY) / "input/comfydeck/upload.png"
        for p in (old, new, keep):
            p.write_bytes(b"1")
        past = time.time() - 40 * 86400
        os.utime(old, (past, past)); os.utime(keep, (past, past))
        main.prune_crops()
        self.assertFalse(old.exists())
        self.assertTrue(new.exists())
        self.assertTrue(keep.exists())  # only crop_ files


if __name__ == "__main__":
    unittest.main()
