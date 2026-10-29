"""Upscaling a finished H3 clip with its own run's workflow (app/h3upscale.py).
Run: .venv/bin/python -m unittest discover tests"""
import json
import os
import tempfile
import unittest
from pathlib import Path

up = None
TPL = Path(__file__).resolve().parent.parent / "templates"


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global up
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from app import h3upscale
    up = h3upscale


class Build(unittest.TestCase):
    def wf(self, name):
        return json.loads((TPL / f"{name}.json").read_text())

    def test_ref2v_reuses_its_conditioning(self):
        src = self.wf("deck-h3-ref2v")
        wf, size = up.build(src, "/out/clip.mp4", 768, 448, 1.5)
        self.assertEqual(size, (1152, 672))
        h3 = up.h3_node(src)
        self.assertEqual(wf["up_guide"]["inputs"]["conditioning"], [h3, 0])
        self.assertEqual(wf["up_guide"]["inputs"]["model"], src["11"]["inputs"]["model"])   # the LoRA chain
        self.assertEqual(wf["up_run"]["inputs"]["noise"], src["12"]["inputs"]["noise"])     # the seed
        self.assertEqual((wf["up_scale"]["inputs"]["mode.width"], wf["up_scale"]["inputs"]["mode.height"]), (1152, 672))
        self.assertEqual(wf["up_save"]["inputs"]["audio"], ["up_src", 2])                   # the clip's own sound
        outs = [n for n in wf.values() if n["class_type"] in ("VHS_VideoCombine", "VAEDecodeAudio")]
        self.assertEqual(len(outs), 1)                                                     # only the new save
        self.assertNotIn("up_cond", wf)

    def test_i2v_runs_its_node_again_at_the_new_size(self):
        src = self.wf("deck-h3-i2v")
        wf, (w, h) = up.build(src, "/out/clip.mp4", 768, 448, 1.25)
        self.assertEqual((w, h), (960, 576))
        self.assertEqual(wf["up_cond"]["inputs"]["width"], 960)
        self.assertEqual(wf["up_guide"]["inputs"]["conditioning"], ["up_cond", 0])
        self.assertEqual(wf["up_split"]["inputs"]["av_latent"], ["up_cond", 1])

    def test_strength_sets_where_the_second_pass_starts(self):
        self.assertEqual(up.sigmas(up.STRENGTHS["light"]), "0.6316, 0.3158, 0.0000")
        self.assertEqual(up.sigmas(up.STRENGTHS["strong"]), "0.9035, 0.6316, 0.3158, 0.0000")   # as tested on the GPU
        wf, _ = up.build(self.wf("deck-h3-ref2v"), "/c.mp4", 768, 448, 1.5, strength=0.8)
        self.assertEqual(wf["up_sigmas"]["inputs"]["sigmas"], "0.8000, 0.6316, 0.3158, 0.0000")

    def test_regen_uses_its_own_schedule(self):
        self.assertEqual(up.regen_sigmas("standard"), "0.7000, 0.4941, 0.0000")
        self.assertEqual(up.regen_sigmas("enhanced"), "0.8000, 0.6667, 0.0000")
        self.assertEqual(up.regen_sigmas("whatever"), "0.7000, 0.4941, 0.0000")
        wf, _ = up.build(self.wf("deck-h3-ref2v"), "/c.mp4", 768, 448,
                         regen={"lora": "reg.safetensors", "has_turbo": False, "quality": "standard"})
        self.assertEqual(wf["up_sigmas"]["inputs"]["sigmas"], "0.7000, 0.4941, 0.0000")
        self.assertEqual(wf["up_sigmas"]["_meta"]["title"], "Regenerate from 0.70")

    def test_regen_loads_the_refiner_after_the_run_chain(self):
        wf, _ = up.build(self.wf("deck-h3-ref2v"), "/c.mp4", 768, 448,
                         regen={"lora": "reg.safetensors", "has_turbo": False, "quality": "standard"})
        self.assertIn("up_lora", wf)
        lora = wf["up_lora"]["inputs"]
        self.assertEqual(lora["lora_name"], "reg.safetensors")
        self.assertEqual(lora["strength_model"], 1.0)
        self.assertEqual(wf["up_guide"]["inputs"]["model"], ["up_lora", 0])
        self.assertIn("30", wf, "a refiner-only file keeps the run's turbo LoRA")

    def test_regen_merge_drops_the_run_turbo(self):
        src = self.wf("deck-h3-ref2v")
        wf, _ = up.build(src, "/c.mp4", 768, 448,
                         regen={"lora": "merge.safetensors", "has_turbo": True, "quality": "enhanced"})
        self.assertNotIn("30", wf, "the merged refiner has Turbo inside")
        self.assertIn("6", wf, "the run's own character/style LoRAs stay")
        self.assertEqual(wf["up_guide"]["inputs"]["model"], ["up_lora", 0])
        # its users took the turbo's own model input, so the graph has no dangling link
        for node in wf.values():
            for k, v in node.get("inputs", {}).items():
                if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                    self.assertIn(v[0], wf, f"{k} points at a dropped node {v[0]}")
        self.assertEqual(wf["up_sigmas"]["inputs"]["sigmas"], "0.8000, 0.6667, 0.0000")

    def test_regen_target_size(self):
        wf, (w, h) = up.build(self.wf("deck-h3-ref2v"), "/c.mp4", 768, 448, size=(1856, 1088),
                              regen={"lora": "reg.safetensors", "has_turbo": False, "quality": "standard"})
        self.assertEqual((w, h), (1856, 1088))
        self.assertEqual((wf["up_scale"]["inputs"]["mode.width"], wf["up_scale"]["inputs"]["mode.height"]), (1856, 1088))

    def test_regen_needs_a_lora(self):
        with self.assertRaises(ValueError):
            up.build(self.wf("deck-h3-ref2v"), "/c.mp4", 768, 448, regen={"quality": "standard"})

    def test_1080p_preset(self):
        self.assertEqual(up.fit_1080p(768, 448), (1856, 1088))
        w, h = up.fit_1080p(1280, 720)
        self.assertEqual((w, h), (1920, 1088))
        self.assertLessEqual(w, 1920)

    def test_which_regen_loras_have_turbo(self):
        oi = {"LoraLoaderModelOnly": {"input": {"required": {"lora_name": [[
            "minimax_h3_open_regenerate_2k_r128_comfyui_bf16.safetensors",
            "minimax_h3_open_regenerate_2k_refiner_rank_384_bf16.safetensors",
            "other.safetensors"], {}]}}}}
        got = {x["name"]: x["has_turbo"] for x in up.regen_loras(oi)}
        self.assertTrue(got["minimax_h3_open_regenerate_2k_r128_comfyui_bf16.safetensors"])
        self.assertFalse(got["minimax_h3_open_regenerate_2k_refiner_rank_384_bf16.safetensors"])
        self.assertNotIn("other.safetensors", got)
        self.assertEqual(up.regen_loras(None), [])

    def test_not_h3(self):
        with self.assertRaises(ValueError):
            up.build(self.wf("deck-ltx-t2v"), "/x.mp4", 768, 448)


if __name__ == "__main__":
    unittest.main()
