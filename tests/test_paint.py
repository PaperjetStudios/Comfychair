"""Painted Editor layers (app/main.py /api/paint): kept locally under a name made from their pixels, and served
like any input image. Run: .venv/bin/python -m unittest discover tests"""
import io
import os
import tempfile
import unittest

config = main = TestClient = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global config, main, TestClient
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from fastapi.testclient import TestClient as T
    from app import config as c, main as m
    config, main, TestClient = c, m, T
    assert not str(config.DATA_DIR).startswith(str(config.BASE_DIR / "data")), config.DATA_DIR


def png(color=(0, 0, 0, 0), size=(40, 30)):
    from PIL import Image
    b = io.BytesIO()
    Image.new("RGBA", size, color).save(b, "PNG")
    return b.getvalue()


class Paint(unittest.TestCase):
    def test_saved_by_content_and_served(self):
        c = TestClient(main.app)
        data = png((255, 0, 0, 128))
        r = c.post("/api/paint", content=data, headers={"Content-Type": "image/png"})
        self.assertEqual(r.status_code, 200, r.text)
        j = r.json()
        self.assertEqual((j["width"], j["height"]), (40, 30))
        self.assertTrue(j["name"].startswith(f"{config.COMFY_INPUT_SUBFOLDER}/paint/"))
        # the same pixels again: the same file
        self.assertEqual(c.post("/api/paint", content=data).json()["name"], j["name"])
        self.assertNotEqual(c.post("/api/paint", content=png((0, 255, 0, 255))).json()["name"], j["name"])
        got = c.get("/api/input", params={"name": j["name"]})
        self.assertEqual(got.status_code, 200)
        self.assertEqual(got.content, data)   # see-through pixels kept as they were
        self.assertEqual(c.get("/api/input", params={"name": j["name"], "thumb": 64}).status_code, 200)
        # and it stays out of the input galleries (they list the files at the top of the inputs folder)
        fname = j["name"].rsplit("/", 1)[1]
        self.assertTrue((config.INPUT_DIR / "paint" / fname).is_file())
        self.assertFalse((config.INPUT_DIR / fname).exists())

    def test_not_a_png(self):
        c = TestClient(main.app)
        self.assertEqual(c.post("/api/paint", content=b"nope").status_code, 400)
        from PIL import Image
        b = io.BytesIO()
        Image.new("RGB", (8, 8)).save(b, "JPEG")
        self.assertEqual(c.post("/api/paint", content=b.getvalue()).status_code, 400)

    def test_prune_keeps_what_tabs_name(self):
        import json
        import time
        folder = config.INPUT_DIR / "paint"
        folder.mkdir(exist_ok=True)
        old = time.time() - 40 * 86400

        def paint(tag, age=old):
            name = f"{tag:0>20}.png"
            (folder / name).write_bytes(b"x")
            os.utime(folder / name, (age, age))
            return name
        kept_tab, kept_lib, kept_trash, gone_trash, orphan, kept_story = (paint(t) for t in ("a1", "b2", "c3", "d4", "e5", "9f"))
        fresh = paint("f6", time.time())

        def doc(d, fname, layer):
            d.mkdir(parents=True, exist_ok=True)
            (d / fname).write_text(json.dumps({"payload": {"layers": [{"name": f"comfydeck/paint/{layer}"}]}}))
        tabs = config.PROJECTS_DIR / "Some project" / ".deck" / "edit-tabs"
        doc(tabs, "t1.json", kept_tab)
        doc(config.LIBRARY_DIR / "edit-tabs", "t2.json", kept_lib)
        doc(config.PROJECTS_DIR / "Some project" / ".deck" / "story-tabs", "s1.json", kept_story)   # a shot's canvas
        now = time.time_ns()
        doc(tabs / ".trash", f"t3.{now - 5 * 86400 * 10**9}.json", kept_trash)     # trashed 5 days ago: can come back
        doc(tabs / ".trash", f"t4.{now - 40 * 86400 * 10**9}.json", gone_trash)    # trashed 40 days ago: gone for good
        main.prune_paint()
        left = {p.name for p in folder.glob("*.png")}
        for n in (kept_tab, kept_lib, kept_trash, fresh, kept_story):
            self.assertIn(n, left)
        for n in (gone_trash, orphan):
            self.assertNotIn(n, left)

    def test_local_input_stays_in_its_folders(self):
        self.assertIsNone(main.local_input("comfydeck/paint/../../etc/passwd"))
        self.assertIsNone(main.local_input("other/x.png"))
