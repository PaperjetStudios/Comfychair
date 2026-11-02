import json
import unittest
from pathlib import Path

T = Path(__file__).resolve().parent.parent / "templates"


def load(name):
    return json.loads((T / f"{name}.json").read_text())


class ImageToolTemplates(unittest.TestCase):
    def test_every_link_points_at_a_node(self):
        for name in ("deck-cutout-image", "deck-mask-image"):
            wf = load(name)
            for node in wf.values():
                for v in node["inputs"].values():
                    if isinstance(v, list):
                        self.assertIn(v[0], wf, f"{name}: {v}")

    def test_one_picture_field_and_a_saved_matte(self):
        for name in ("deck-cutout-image", "deck-mask-image"):
            wf = load(name)
            loads = [n for n in wf.values() if n["class_type"] == "LoadImage"]
            self.assertEqual(len(loads), 1)
            self.assertTrue(loads[0]["_meta"]["title"].startswith("@1 Picture"))
            saves = [n for n in wf.values() if n["class_type"] == "SaveImage"]
            self.assertEqual(len(saves), 1)

    def test_words_template_takes_a_prompt(self):
        wf = load("deck-mask-image")
        self.assertIn("[text_prompt,confidence_threshold,max_detections]", wf["find"]["_meta"]["title"])

    def test_sam3_clip_follows_from_the_frame_it_was_told(self):
        wf = load("deck-sam3-video-mask")
        self.assertEqual(wf["prop"]["inputs"]["start_frame"], wf["seg"]["inputs"]["frame_idx"])
        self.assertIn("score_threshold", wf["seg"]["_meta"]["title"])

    def test_sheet_cell_templates(self):
        for name in ("deck-sheet-cell", "deck-sheet-cell-fast"):
            wf = load(name)
            for node in wf.values():
                for v in node["inputs"].values():
                    if isinstance(v, list):
                        self.assertIn(v[0], wf, f"{name}: {v}")
            self.assertEqual(len([n for n in wf.values() if n["class_type"] == "LoadImage"]), 1)
            self.assertEqual(len([n for n in wf.values() if n["class_type"] == "SaveImage"]), 1)
            titles = " ".join(n.get("_meta", {}).get("title", "") for n in wf.values())
            for key in ("[text_prompt,confidence_threshold]", "[scale_by]"):
                self.assertIn(key, titles)


if __name__ == "__main__":
    unittest.main()
