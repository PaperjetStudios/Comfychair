"""The Krea 2 and MOSS edit templates: optional reference slots drop cleanly, and the tag style. Run with:
.venv/bin/python -m unittest discover tests"""
import json
import os
import tempfile
import unittest
from pathlib import Path

TEMPLATES = Path(__file__).resolve().parent.parent / "templates"
tpl = None


def setUpModule():
    global tpl
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))  # never the real data/
    from app import templates
    tpl = templates


def load(name):
    return json.loads((TEMPLATES / f"{name}.json").read_text())


class KreaEdit(unittest.TestCase):
    def run_with(self, a, b):
        return tpl.apply(load("deck-krea2-edit"), {"20.image": "pic.png", "21.image": a, "22.image": b})

    def test_two_references_side_by_side(self):
        wf = self.run_with("a.png", "b.png")
        self.assertEqual(wf["23"]["inputs"]["image1"], ["21", 0])
        self.assertEqual(wf["23"]["inputs"]["image2"], ["22", 0])
        self.assertEqual(wf["41"]["inputs"]["source_image_b"], ["23", 0])
        self.assertTrue(wf["41"]["inputs"]["ref_position"].startswith("beside"))

    def test_one_reference_passes_as_it_is(self):
        wf = self.run_with("a.png", "")
        self.assertNotIn("22", wf)
        self.assertNotIn("image2", wf["23"]["inputs"])   # the stitch hands back image1
        self.assertEqual(wf["30"]["inputs"]["image_b"], ["23", 0])
        self.assertTrue(wf["41"]["inputs"]["ref_position"].startswith("beside"))

    def test_second_slot_only(self):
        wf = self.run_with("", "b.png")
        self.assertNotIn("23", wf)
        self.assertEqual(wf["30"]["inputs"]["image_b"], ["22", 0])
        self.assertEqual(wf["41"]["inputs"]["source_image_b"], ["22", 0])
        self.assertTrue(wf["41"]["inputs"]["ref_position"].startswith("beside"))

    def test_no_reference_keeps_picture_aligned(self):
        wf = self.run_with("", "")
        for nid in ("21", "22", "23"):
            self.assertNotIn(nid, wf)
        self.assertNotIn("image_b", wf["30"]["inputs"])
        self.assertNotIn("source_image_b", wf["41"]["inputs"])
        self.assertEqual(wf["41"]["inputs"]["ref_position"], "aligned (trained)")
        self.assertEqual(wf["41"]["inputs"]["source_image"], ["20", 0])

    def test_tag_style(self):
        self.assertEqual(tpl.tag_style(load("deck-krea2-edit")), "krea")
        self.assertEqual(tpl.tag_style(load("deck-krea2-identity")), "krea")
        self.assertIsNone(tpl.tag_style(load("deck-krea2-t2i")))

    def test_family(self):
        wf = load("deck-krea2-edit")
        self.assertEqual(tpl.family("deck-krea2-edit", wf), "Krea")

    def test_family_no_accidental_match(self):
        self.assertNotEqual(tpl.family("deck-face-restore", load("deck-face-restore")), "ACE-Step")
        self.assertEqual(tpl.family("deck-ace-music", load("deck-ace-music")), "ACE-Step")
        # a user template with an unrelated id falls back to node class names, on word starts only
        self.assertEqual(tpl.family("mine", {"1": {"class_type": "TextEncodeAceStepAudio1.5", "inputs": {}}}), "ACE-Step")
        self.assertEqual(tpl.family("mine", {"1": {"class_type": "DeckFaceRestore", "inputs": {}}}), "Other")

    def test_family_matches_id_prefix(self):
        want = {"ltx": "LTX-2.5", "h3": "MiniMax H3", "qwen": "Qwen Image", "klein": "Flux Klein", "krea": "Krea",
                "moss": "MOSS", "ace": "ACE-Step", "depth": "Depth", "sam3": "SAM3", "pose": "Pose"}
        root = Path(tpl.__file__).resolve().parent.parent / "templates"
        for f in sorted(root.glob("deck-*.json")):
            tid = f.stem
            first = tid.split("-")[1]
            label = tpl.family(tid, json.loads(f.read_text()))
            for key, fam in want.items():
                if first.startswith(key) and "inpaint" not in tid:
                    self.assertEqual(label, fam, tid)
            self.assertNotEqual(label, "ACE-Step" if first != "ace" else "", tid)


class MossEdit(unittest.TestCase):
    def test_empty_references_close_up(self):
        wf = tpl.apply(load("deck-moss-edit"), {"20.image": "pic.png", "21.image": "", "22.image": "b.png", "23.image": ""})
        for nid in ("21", "23", "24", "26"):
            self.assertNotIn(nid, wf)
        for enc in ("30", "31"):
            imgs = {k: v for k, v in wf[enc]["inputs"].items() if k.startswith("images.")}
            self.assertEqual(imgs, {"images.image_0": ["20", 0], "images.image_1": ["25", 0]})

    def test_tag_style(self):
        self.assertEqual(tpl.tag_style(load("deck-moss-edit")), "moss")


class FollowOn(unittest.TestCase):
    def test_follow_only_on_named_input(self):
        wf = {
            "a": {"class_type": "LoadImage", "inputs": {"image": ""}},
            "b": {"class_type": "LoadImage", "inputs": {"image": ""}},
            "s": {"class_type": "ImageStitch", "inputs": {"image1": ["a", 0], "image2": ["b", 0]},
                  "_meta": {"deck_passthrough": "image2", "deck_follow_on": ["image1"]}},
            "u": {"class_type": "User", "inputs": {"img": ["s", 0], "pos": "x"}, "_meta": {"deck_unplugged": {"pos": "y"}}},
        }
        one = json.loads(json.dumps(wf))
        tpl.drop_node(one, "b")
        self.assertIn("s", one)
        self.assertEqual(one["u"]["inputs"]["pos"], "x")
        both = json.loads(json.dumps(wf))
        tpl.drop_node(both, "a")
        tpl.drop_node(both, "b")
        self.assertNotIn("s", both)
        self.assertNotIn("img", both["u"]["inputs"])
        self.assertEqual(both["u"]["inputs"]["pos"], "y")


if __name__ == "__main__":
    unittest.main()


class ControlTemplates(unittest.TestCase):
    def test_control_picture_slot_and_reference_drop(self):
        for m in ("klein3", "klein9b", "qwen21"):
            wf = load(f"deck-{m}-control")
            self.assertTrue(wf["20"]["_meta"]["title"].startswith("@2 Control picture"), m)
            out = tpl.apply(wf, {"20.image": "map.png", "21.image": "", "22.image": "", "23.image": ""})
            self.assertIn("20", out)
            self.assertNotIn("21", out)

    def test_krea_control_follows_the_map_and_keeps_loras(self):
        for kind, mode, norm in (("depth", "grayscale", "per_image_minmax"), ("anything", "rgb", "none")):
            wf = load(f"deck-krea2-{kind}-control")
            self.assertEqual(tpl.family(f"deck-krea2-{kind}-control", wf), "Krea")
            self.assertEqual((wf["30"]["inputs"]["channel_mode"], wf["30"]["inputs"]["normalize"]), (mode, norm))
            self.assertEqual(wf["7"]["inputs"]["width"], ["15", 0])   # the output takes the map's size
            out = tpl.apply(wf, {"20.image": "map.png", "31.strength": 0.7, "31.end_percent": 0.6,
                                 "4.__loras": [{"name": "krea/style.safetensors", "strength": 0.5}]})
            self.assertEqual(out["31"]["inputs"]["strength"], 0.7)
            self.assertEqual(out["31"]["inputs"]["end_percent"], 0.6)
            self.assertEqual(out["8"]["inputs"]["model"], ["32", 0])
            self.assertEqual(out[out["31"]["inputs"]["model"][0]]["inputs"]["lora_name"], "krea/style.safetensors")
            out = tpl.apply(wf, {"20.image": "map.png", "4.__loras": []})   # no style LoRA: the Control LoRA still loads
            self.assertEqual(out["31"]["inputs"]["model"], ["1", 0])
            self.assertEqual(out["32"]["inputs"]["control_latent"], ["30", 0])


class ControlVideoSound(unittest.TestCase):
    def test_ltx_moves_to_the_sound_and_keeps_it(self):
        out = tpl.apply(load("deck-ltx-ctrl2v"), {"src.video": "c.mp4", "snd.audio_file": "line.wav", "img.image": ""})
        self.assertEqual(out["av"]["inputs"]["audio_latent"], ["afrz", 0])
        self.assertEqual(out["vid"]["inputs"]["audio"], ["scut", 0])
        self.assertEqual(out["nf"]["inputs"]["values.c"], ["snd", 1])

    def test_ltx_without_a_sound_makes_its_own_as_before(self):
        out = tpl.apply(load("deck-ltx-ctrl2v"), {"src.video": "c.mp4", "snd.audio_file": "", "img.image": ""})
        for gone in ("snd", "scut", "aenc", "afrz"):
            self.assertNotIn(gone, out)
        self.assertEqual(out["av"]["inputs"]["audio_latent"], ["alat", 0])
        self.assertEqual(out["vid"]["inputs"]["audio"], ["adec", 0])
        self.assertEqual(out["nf"]["inputs"]["expression"], "floor((min(a, b*24+1)-1)/8)*8+1")
        self.assertNotIn("values.c", out["nf"]["inputs"])

    def test_h3_hold_templates_change_only_shift_and_reference_size(self):
        for base, chain_end in (("deck-h3-ref2v", "60"), ("deck-h3-ctrl2v", "51")):
            a, b = load(base), load(f"{base}-hold")
            self.assertEqual(b["60"]["inputs"], {"model": ["30", 0], "shift_video": 6.0, "shift_audio": 3.0})
            self.assertEqual(b["7"]["inputs"]["ref_image_size"], "max")
            self.assertEqual(b["11"]["inputs"]["model"], [chain_end, 0])
            self.assertEqual(b["10"]["inputs"]["model"], [chain_end, 0])
            # Everything else follows the base, so a comparison run changes only these settings
            for wf in (a, b):
                wf.pop("60", None)
                wf["7"]["inputs"].pop("ref_image_size")
                wf["15"]["inputs"].pop("filename_prefix")
                for n in ("10", "11", "51"):
                    if n in wf:
                        wf[n]["inputs"].pop("model")
            self.assertEqual(a, b)

    def test_h3_hold_shift_is_a_setting_that_reaches_the_run(self):
        for name in ("deck-h3-ref2v-hold", "deck-h3-ctrl2v-hold"):
            keys = [f["key"] for f in tpl.describe(tpl.get(TEMPLATES, name), None)["fields"]]
            self.assertIn("60.shift_video", keys)
            self.assertIn("60.shift_audio", keys)
        out = tpl.apply(load("deck-h3-ctrl2v-hold"), {"52.video": "c.mp4", "60.shift_video": 12.0})
        self.assertEqual(out["60"]["inputs"]["shift_video"], 12.0)
        self.assertEqual(out["51"]["inputs"]["model"], ["60", 0])
        self.assertEqual(out["11"]["inputs"]["model"], ["51", 0])

    def test_h3_sound_references_close_up_when_empty(self):
        out = tpl.apply(load("deck-h3-ctrl2v"), {"52.video": "c.mp4", "24.audio_file": "", "25.audio_file": "v.wav"})
        self.assertNotIn("24", out)
        self.assertEqual(out["7"]["inputs"]["ref_audios.ref_audio_0"], ["25", 0])
        self.assertNotIn("ref_audios.ref_audio_1", out["7"]["inputs"])

