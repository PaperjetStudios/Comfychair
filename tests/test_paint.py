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

    def test_local_input_stays_in_its_folders(self):
        self.assertIsNone(main.local_input("comfydeck/paint/../../etc/passwd"))
        self.assertIsNone(main.local_input("other/x.png"))
