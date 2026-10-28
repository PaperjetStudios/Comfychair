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
