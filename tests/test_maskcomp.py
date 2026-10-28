"""Masked edits (app/maskcomp.py): the Mask setting, and the composite put in front of every saved image.
Run with: .venv/bin/python -m unittest tests.test_maskcomp"""
import json
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
tpl = editsize = maskcomp = None


def setUpModule():
    global tpl, editsize, maskcomp
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))   # before app.config makes its folders
    os.environ["DECK_COMFY_DIR"] = ""
    from app import editsize as e, maskcomp as m, templates as t
    tpl, editsize, maskcomp = t, e, m


MASK = "comfydeck/mask/0123456789abcdef0123.png"
CORE = {"LoadImage", "GetImageSize", "ImageScale", "ImageScaleBy", "ImageToMask", "MaskToImage", "GrowMask", "ImageBlur",
        "ImageCompositeMasked", "RepeatImageBatch", "ImageCrop", "CropMask"}


def load(tid):
    t = tpl.get(ROOT / "templates", tid)
    assert t and not t.error, tid
    return t


def run(t, values, dims=None):
    """What main.generate does with a template and its values (no ComfyUI)."""
    fields = tpl.describe(t, None)["fields"]
    v = {f["key"]: f["value"] for f in fields}
    v.update(values)
    v = maskcomp.prefill(v, fields, t.workflow)
    wf = editsize.inject(tpl.apply(t.workflow, v), v, fields)
    return maskcomp.inject(wf, v, fields, dims), fields


def by_class(wf, cls):
    return {k: n for k, n in wf.items() if n["class_type"] == cls}


def node(wf, link):
    return wf[link[0]]


def check_links(test, wf):
    for k, n in wf.items():
        for name, v in n["inputs"].items():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                test.assertIn(v[0], wf, f"{k}.{name} points at a missing node")


class MaskField(unittest.TestCase):
    def test_edit_templates_get_one_on_the_first_picture(self):
        for tid in ("deck-qwen21-edit", "deck-klein9b-edit", "deck-klein3-edit"):
            fields = tpl.describe(load(tid), None)["fields"]
            masks = [f for f in fields if f["kind"] == "mask"]
            self.assertEqual(len(masks), 1, tid)
            m = masks[0]
            self.assertEqual(m["node"], "20")
            self.assertEqual(m["image_key"], "20.image")
            self.assertEqual(m["group"], next(f for f in fields if f["key"] == "20.image")["group"])
            self.assertTrue(m["composite"] and m["fit"])

    def test_video_templates_get_none(self):
        for tid in ("deck-ltx-i2v", "deck-h3-i2v", "deck-ltx-inpaint"):
            fields = tpl.describe(load(tid), None)["fields"]
            self.assertFalse([f for f in fields if f["kind"] == "mask"], tid)

    def test_without_a_mask_nothing_changes(self):
        t = load("deck-qwen21-edit")
        plain, _ = run(t, {"20.image": "a.png"})
        self.assertEqual(by_class(plain, "ImageCompositeMasked"), {})
        self.assertEqual(plain["13"]["inputs"]["images"], ["12", 0])
        self.assertNotIn(maskcomp.MASK, json.dumps(plain))   # the setting never reaches a node


class Composite(unittest.TestCase):
    def test_qwen_edit(self):
        t = load("deck-qwen21-edit")
        wf, _ = run(t, {"20.image": "comfydeck/a.png", "20.__mask": {"name": MASK, "grow": 8, "feather": 16}})
        check_links(self, wf)
        comp = node(wf, wf["13"]["inputs"]["images"])
        self.assertEqual(comp["class_type"], "ImageCompositeMasked")
        ins = comp["inputs"]
        self.assertEqual(ins["source"], ["12", 0])           # the generated image
        self.assertEqual((ins["x"], ins["y"], ins["resize_source"]), (0, 0, False))
        rep = node(wf, ins["destination"])
        self.assertEqual(rep["class_type"], "RepeatImageBatch")   # one copy of the picture per result
        size = node(wf, rep["inputs"]["amount"])
        self.assertEqual(size["class_type"], "GetImageSize")
        self.assertEqual(size["inputs"]["image"], ["12", 0])
        self.assertEqual(rep["inputs"]["amount"][1], 2)
        orig = node(wf, rep["inputs"]["image"])
        self.assertEqual(orig["class_type"], "ImageScale")
        self.assertEqual(orig["inputs"]["image"], ["20", 0])   # the same picture the template loads
        self.assertEqual(orig["inputs"]["crop"], "center")
        sid = rep["inputs"]["amount"][0]
        self.assertEqual((orig["inputs"]["width"], orig["inputs"]["height"]), ([sid, 0], [sid, 1]))
        # the mask: loaded, scaled to the output, grown, blurred
        m = node(wf, ins["mask"])
        self.assertEqual(m["class_type"], "ImageToMask")
        blur = node(wf, m["inputs"]["image"])
        self.assertEqual(blur["class_type"], "ImageBlur")
        self.assertEqual(blur["inputs"]["blur_radius"], 16)
        grow = node(wf, node(wf, blur["inputs"]["image"])["inputs"]["mask"])
        self.assertEqual((grow["class_type"], grow["inputs"]["expand"]), ("GrowMask", 8))
        first = node(wf, grow["inputs"]["mask"])
        self.assertEqual((first["class_type"], first["inputs"]["channel"]), ("ImageToMask", "red"))
        mscale = node(wf, first["inputs"]["image"])
        self.assertEqual(mscale["class_type"], "ImageScale")
        self.assertEqual((mscale["inputs"]["width"], mscale["inputs"]["height"], mscale["inputs"]["crop"]), ([sid, 0], [sid, 1], "center"))
        self.assertEqual(node(wf, mscale["inputs"]["image"])["inputs"]["image"], MASK)
        # editsize still sizes the template's own input, and only core nodes were added
        self.assertTrue(by_class(wf, "ImageScale"))
        added = {n["class_type"] for n in wf.values() if n.get("_meta", {}).get("title", "").startswith("Mask:")}
        self.assertTrue(added)
        self.assertLessEqual(added, CORE)

    def test_soft_edges_past_the_blur_radius(self):
        wf, _ = run(load("deck-klein9b-edit"), {"20.image": "a.png", "20.__mask": {"name": MASK, "feather": 64}})
        check_links(self, wf)
        self.assertEqual(by_class(wf, "GrowMask"), {})   # grow 0: no node
        (blur,) = by_class(wf, "ImageBlur").values()
        self.assertLessEqual(blur["inputs"]["blur_radius"], maskcomp.BLUR_MAX)
        self.assertEqual(blur["inputs"]["blur_radius"], round(64 / 3))
        (small,) = by_class(wf, "ImageScaleBy").values()
        self.assertAlmostEqual(small["inputs"]["scale_by"], 1 / 3, places=3)

    def test_hard_edge_has_no_blur(self):
        wf, _ = run(load("deck-klein9b-edit"), {"20.image": "a.png", "20.__mask": {"name": MASK, "feather": 0, "grow": 0}})
        self.assertEqual(by_class(wf, "ImageBlur"), {})
        comp = node(wf, wf["13"]["inputs"]["images"])
        self.assertEqual(node(wf, comp["inputs"]["mask"])["class_type"], "ImageToMask")

    def test_no_picture_no_composite(self):
        t = load("deck-qwen21-edit")
        wf, _ = run(t, {"20.image": "", "20.__mask": {"name": MASK}})
        self.assertEqual(by_class(wf, "ImageCompositeMasked"), {})

    def test_settings_without_a_mask_do_nothing(self):
        wf, _ = run(load("deck-qwen21-edit"), {"20.image": "a.png", "20.__mask": {"name": None, "feather": 8}})
        self.assertEqual(by_class(wf, "ImageCompositeMasked"), {})

    def test_two_saves_of_one_image_share_the_composite(self):
        t = load("deck-qwen21-edit")
        t.workflow["99"] = {"class_type": "PreviewImage", "inputs": {"images": ["12", 0]}}
        try:
            wf, _ = run(t, {"20.image": "a.png", "20.__mask": {"name": MASK}})
        finally:
            del t.workflow["99"]
        self.assertEqual(len(by_class(wf, "ImageCompositeMasked")), 1)
        self.assertEqual(wf["13"]["inputs"]["images"], wf["99"]["inputs"]["images"])


class CropToMask(unittest.TestCase):
    def test_fit_box(self):
        r = maskcomp.fit_box({"x": 0.45, "y": 0.45, "w": 0.05, "h": 0.05}, 4000, 3000, 1.0)
        self.assertEqual(r["w"], r["h"])                       # the output's shape
        self.assertGreaterEqual(r["x"], 0)
        self.assertLessEqual(r["x"] + r["w"], 4000)
        self.assertLess(r["x"], 0.45 * 4000)                   # the mask is inside, with room around it
        self.assertGreater(r["x"] + r["w"], 0.5 * 4000)
        corner = maskcomp.fit_box({"x": 0.97, "y": 0.0, "w": 0.03, "h": 0.03}, 4000, 3000, 16 / 9)
        self.assertEqual(corner["x"] + corner["w"], 4000)      # pushed back inside the picture
        self.assertEqual(corner["y"], 0)
        self.assertAlmostEqual(corner["w"] / corner["h"], 16 / 9, places=2)
        self.assertIsNone(maskcomp.fit_box({"x": 0.1, "y": 0.1, "w": 0.8, "h": 0.8}, 1000, 1000, 1.0))   # most of it anyway
        self.assertIsNone(maskcomp.fit_box({}, 1000, 1000, 1.0))

    def test_runs_on_the_box_and_stitches_back(self):
        t = load("deck-klein9b-edit")
        m = {"name": MASK, "grow": 4, "feather": 8, "fit": True, "box": {"x": 0.6, "y": 0.3, "w": 0.1, "h": 0.1}}
        wf, _ = run(t, {"20.image": "a.png", "20.__mask": m, editsize.WIDTH: 1024, editsize.HEIGHT: 1024}, dims=(3000, 2000))
        check_links(self, wf)
        (crop,) = [n for n in by_class(wf, "ImageCrop").values() if n["inputs"]["image"] == ["20", 0]]
        r = maskcomp.fit_box(m["box"], 3000, 2000, 1.0, 12)
        self.assertEqual((crop["inputs"]["x"], crop["inputs"]["y"], crop["inputs"]["width"], crop["inputs"]["height"]),
                         (r["x"], r["y"], r["w"], r["h"]))
        # the model's picture comes from the box: editsize's scale reads the crop, nothing else reads the picture raw
        size = next(n for n in by_class(wf, "ImageScale").values() if n["_meta"]["title"] == "Size (crop to fit)")
        self.assertEqual(node(wf, size["inputs"]["image"]), crop)
        comp = node(wf, wf["13"]["inputs"]["images"])
        ins = comp["inputs"]
        self.assertEqual((ins["x"], ins["y"]), (r["x"], r["y"]))
        piece = node(wf, ins["source"])
        self.assertEqual((piece["class_type"], piece["inputs"]["image"], piece["inputs"]["width"], piece["inputs"]["height"]),
                         ("ImageScale", ["12", 0], r["w"], r["h"]))
        dest = node(wf, ins["destination"])
        self.assertEqual(dest["inputs"]["image"], ["20", 0])   # the whole picture, at its own size
        added = {n["class_type"] for n in wf.values() if n.get("_meta", {}).get("title", "").startswith("Mask:")}
        self.assertTrue(added)
        self.assertLessEqual(added, CORE)

    def test_without_its_size_it_runs_on_the_whole_picture(self):
        m = {"name": MASK, "fit": True, "box": {"x": 0.6, "y": 0.3, "w": 0.1, "h": 0.1}}
        wf, _ = run(load("deck-klein9b-edit"), {"20.image": "a.png", "20.__mask": m}, dims=None)
        self.assertFalse([n for n in by_class(wf, "ImageCrop").values() if n["inputs"]["image"] == ["20", 0]])
        self.assertEqual(len(by_class(wf, "ImageCompositeMasked")), 1)


class MaskInputs(unittest.TestCase):
    def wf(self):
        return {
            "1": {"class_type": "LoadImage", "_meta": {"title": "@1 Picture"}, "inputs": {"image": "p.png"}},
            "2": {"class_type": "LoadImage", "_meta": {"title": "@2 Inpaint mask"}, "inputs": {"image": "m.png"}},
            "3": {"class_type": "LoadImageMask", "inputs": {"image": "old.png", "channel": "alpha"}},
            "4": {"class_type": "InpaintThing", "inputs": {"image": ["1", 0], "mask": ["2", 0], "mask2": ["3", 0]}},
            "5": {"class_type": "SaveImage", "inputs": {"images": ["4", 0], "filename_prefix": "x"}},
        }

    def test_the_template_gets_the_mask(self):
        t = tpl.Template(id="t", name="t", path=Path("t.json"), workflow=self.wf())
        fields = tpl.describe(t, None)["fields"]
        (mf,) = [f for f in fields if f["kind"] == "mask"]
        self.assertEqual(mf["image_key"], "1.image")   # the picture, not the mask slot
        self.assertTrue(mf["takes"])
        wf, _ = run(t, {"1.image": "p.png", "2.image": "", "1.__mask": {"name": MASK}})
        self.assertEqual(wf["2"]["inputs"]["image"], MASK)    # the empty mask slot was filled, not dropped
        self.assertEqual(wf["3"]["inputs"], {"image": MASK, "channel": "red"})
        self.assertEqual(node(wf, wf["5"]["inputs"]["images"])["class_type"], "ImageCompositeMasked")

    def test_a_picked_mask_is_kept(self):
        t = tpl.Template(id="t", name="t", path=Path("t.json"), workflow=self.wf())
        wf, _ = run(t, {"1.image": "p.png", "2.image": "mine.png", "1.__mask": {"name": MASK}})
        self.assertEqual(wf["2"]["inputs"]["image"], "mine.png")


INPAINT = ("deck-krea2-inpaint", "deck-qwen21-inpaint")


class Inpaint(unittest.TestCase):
    """The inpaint templates (dev/make_inpaint_templates.py): the painted mask is the latent's noise mask."""
    M = {"name": MASK, "feather": 8, "grow": 0, "fit": False, "box": {"x": 0.4, "y": 0.1, "w": 0.2, "h": 0.15}}

    def test_the_mask_is_required_and_crop_to_mask_offered(self):
        for tid in INPAINT:
            d = tpl.describe(load(tid), None)
            self.assertEqual(d["family"], "Inpaint", tid)
            self.assertEqual(d["media"], "image", tid)
            (mf,) = [f for f in d["fields"] if f["kind"] == "mask"]
            self.assertEqual(mf["image_key"], "20.image", tid)
            self.assertTrue(mf["required"] and mf["composite"] and mf["fit"] and mf["takes"], tid)
            self.assertTrue(any(f["key"] == editsize.WIDTH for f in d["fields"]), tid)   # the edit models' Size
            self.assertTrue(any(f["input"] == "denoise" for f in d["fields"]), tid)
            self.assertEqual(maskcomp.missing({"20.image": "a.png"}, d["fields"]), maskcomp.NEEDS_MASK)
            self.assertEqual(maskcomp.missing({"20.image": "a.png", mf["key"]: {"name": None}}, d["fields"]),
                             maskcomp.NEEDS_MASK)
            self.assertIsNone(maskcomp.missing({"20.image": "a.png", mf["key"]: self.M}, d["fields"]))

    def test_other_templates_never_need_a_mask(self):
        for tid in ("deck-qwen21-edit", "deck-klein3-edit", "deck-krea2-i2i"):
            fields = tpl.describe(load(tid), None)["fields"]
            self.assertFalse(any(f.get("required") for f in fields if f["kind"] == "mask"), tid)
            self.assertIsNone(maskcomp.missing({"20.image": "a.png"}, fields), tid)
            self.assertNotEqual(tpl.describe(load(tid), None)["family"], "Inpaint")
        self.assertEqual(tpl.describe(load("deck-ltx-inpaint"), None)["family"], "LTX-2.5")   # a video: by its model

    def test_whole_picture(self):
        for tid in INPAINT:
            wf, _ = run(load(tid), {"20.image": "a.png", "20.__mask": self.M, editsize.WIDTH: 1024, editsize.HEIGHT: 768})
            check_links(self, wf)
            (lm,) = by_class(wf, "LoadImageMask").values()
            self.assertEqual(lm["inputs"], {"image": MASK, "channel": "red"})
            (noise,) = by_class(wf, "SetLatentNoiseMask").values()
            enc = node(wf, noise["inputs"]["samples"])
            sized = node(wf, enc["inputs"]["pixels"])   # the picture at the Size, encoded
            self.assertEqual((sized["class_type"], sized["inputs"]["width"], sized["inputs"]["height"]), ("ImageScale", 1024, 768))
            (dd,) = by_class(wf, "DifferentialDiffusion").values()
            (guider,) = by_class(wf, "CFGGuider").values()
            self.assertIs(node(wf, guider["inputs"]["model"]), dd)
            (save,) = by_class(wf, "SaveImage").values()
            self.assertEqual(node(wf, save["inputs"]["images"])["class_type"], "ImageCompositeMasked")
            self.assertFalse(by_class(wf, "ImageCrop"))

    def test_crop_to_mask_cuts_the_mask_as_the_picture(self):
        m = {**self.M, "fit": True}
        for tid in INPAINT:
            wf, _ = run(load(tid), {"20.image": "a.png", "20.__mask": m, editsize.WIDTH: 1024, editsize.HEIGHT: 1024},
                        dims=(896, 1536))
            check_links(self, wf)
            box = maskcomp.fit_box(m["box"], 896, 1536, 1.0, 8)
            crops = [n for n in by_class(wf, "ImageCrop").values()
                     if n["inputs"]["x"] == box["x"] and n["inputs"]["width"] == box["w"]]
            self.assertTrue(any(n["inputs"]["image"] == ["20", 0] for n in crops), tid)   # the picture
            # the template's mask (painted smaller than the picture, say): to the picture's size, then the same box
            (lm_id,) = by_class(wf, "LoadImageMask")
            users = [k for k, n in wf.items() if n["inputs"].get("mask") == [lm_id, 0]]
            self.assertEqual(len(users), 1, tid)
            scale = next(n for n in wf.values() if n["inputs"].get("image") == [users[0], 0])
            self.assertEqual((scale["class_type"], scale["inputs"]["width"], scale["inputs"]["height"]), ("ImageScale", 896, 1536))
            self.assertFalse(by_class(wf, "CropMask"))
            added = {n["class_type"] for n in wf.values() if n.get("_meta", {}).get("title", "").startswith("Mask:")}
            self.assertLessEqual(added, CORE)


if __name__ == "__main__":
    unittest.main()
