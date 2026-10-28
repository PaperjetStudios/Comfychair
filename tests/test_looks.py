"""Characters' look packs (app/looks.py): the sheet, the look check's judgement, and its routes with a fake scorer.
Run: .venv/bin/python -m unittest discover tests"""
import io
import os
import tempfile
import unittest
from pathlib import Path

from PIL import Image

looks = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global looks
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from app import looks as m
    looks = m


def png(w, h, colour):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), colour).save(buf, "PNG")
    return buf.getvalue()


def unit(*xs):
    import numpy as np
    v = np.array(xs, float)
    return list(v / np.linalg.norm(v))


def hist(red=0.0, green=0.0, grey=1.0):
    h = [0.0] * 13
    h[0], h[4], h[12] = red, green, grey
    return h


class Sheet(unittest.TestCase):
    def test_views_side_by_side_at_one_height(self):
        ims = [Image.new("RGB", (400, 800), "red"), Image.new("RGB", (800, 1600), "blue"), Image.new("RGB", (500, 500), "green")]
        s = looks.compose_sheet(ims, height=256, gap=16)
        self.assertEqual(s.height, (256 + 32) // 16 * 16)
        self.assertEqual(s.width % 16, 0)
        self.assertEqual(s.getpixel((16 + 10, 16 + 10)), (255, 0, 0))
        self.assertEqual(s.getpixel((16 + 128 + 16 + 10, 100)), (0, 0, 255))
        self.assertEqual(s.getpixel((4, 4)), looks.SHEET_BG)

    def test_wide_sheets_are_scaled_down(self):
        s = looks.compose_sheet([Image.new("RGB", (1000, 1000))] * 6, height=1024, max_w=2048)
        self.assertLessEqual(s.width, 2048)

    def test_needs_a_picture(self):
        with self.assertRaises(ValueError):
            looks.compose_sheet([])


class Judge(unittest.TestCase):
    def test_same_look_passes(self):
        pack = [[{"box": None, "vec": unit(1, 0, 0), "hist": hist(green=0.5, grey=0.5)}]]
        r = looks.judge([{"box": None, "vec": unit(0.3, 1, 0), "hist": hist(green=0.2, grey=0.8)},
                         {"box": [0.1, 0.1, 0.5, 0.9], "vec": unit(1, 0.1, 0), "hist": hist(green=0.4, grey=0.6)}], pack)
        self.assertFalse(r["drift"])
        self.assertEqual(r["box"], [0.1, 0.1, 0.5, 0.9])   # the person crop matched best
        self.assertGreater(r["look"], 0.99)
        self.assertEqual(r["colour"], 1.0)

    def test_another_person_drifts(self):
        pack = [[{"box": None, "vec": unit(1, 0, 0), "hist": hist(grey=1)}]]
        r = looks.judge([{"box": None, "vec": unit(1, 1.2, 0), "hist": hist(grey=1)}], pack)
        self.assertTrue(r["drift"])
        self.assertIsNone(r["colour"])   # all grey: colours say nothing

    def test_a_changed_colour_drifts(self):
        pack = [[{"box": None, "vec": unit(1, 0, 0), "hist": hist(green=0.4, grey=0.6)}]]
        r = looks.judge([{"box": None, "vec": unit(1, 0.2, 0), "hist": hist(red=0.4, grey=0.6)}], pack)
        self.assertGreater(r["look"], looks.LOOK_MIN)
        self.assertEqual(r["colour"], 0.0)
        self.assertTrue(r["drift"])
        self.assertLess(r["score"], r["look"])

    def test_no_pack(self):
        self.assertEqual(looks.judge([{"box": None, "vec": unit(1), "hist": hist()}], []), {"score": None, "drift": False})


class FakeScorer:
    name = "fake"

    def why(self):
        return ""

    def embed(self, items):
        # red pictures look like each other, blue ones don't
        out = []
        for p, _ in items:
            r, g, b = Image.open(p).convert("RGB").getpixel((0, 0))
            out.append([{"box": None, "vec": unit(r + 1, b + 1, 0), "hist": hist(grey=1)}])
        return out


class Routes(unittest.TestCase):
    def setUp(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        self.dir = Path(tempfile.mkdtemp(prefix="looks-"))
        self.files = {"a.png": png(64, 128, "red"), "b.png": png(64, 64, "red"), "c.png": png(64, 64, "blue")}
        for k, v in self.files.items():
            (self.dir / k).write_bytes(v)
        self.saved = []

        async def input_bytes(name):
            return self.files[name]

        async def save_input(data, pid, source):
            self.saved.append((Image.open(io.BytesIO(data)).size, pid, source))
            return "comfydeck/sheet.png"
        looks.input_bytes, looks.save_input = input_bytes, save_input
        looks.local_input = lambda name: self.dir / name if name in self.files else None
        self.old = looks._scorer
        looks._scorer = FakeScorer()
        app = FastAPI()
        app.include_router(looks.router)
        self.c = TestClient(app)

    def tearDown(self):
        looks._scorer = self.old

    def test_sheet(self):
        r = self.c.post("/api/looks/sheet", json={"pictures": ["a.png", "b.png"], "project_id": 3})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["name"], "comfydeck/sheet.png")
        self.assertEqual(self.saved[0][1:], (3, "sheet"))
        self.assertEqual(self.c.post("/api/looks/sheet", json={"pictures": []}).status_code, 400)

    def test_check(self):
        self.assertTrue(self.c.get("/api/looks/status").json()["ready"])
        r = self.c.post("/api/looks/check", json={"image": {"input": "b.png"}, "characters": [
            {"id": "same", "pictures": ["a.png"]}, {"id": "other", "pictures": ["c.png"]}, {"id": "none", "pictures": []}]})
        self.assertEqual(r.status_code, 200, r.text)
        res = r.json()["results"]
        self.assertFalse(res["same"]["drift"])
        self.assertTrue(res["other"]["drift"])
        self.assertNotIn("none", res)

    def test_off(self):
        looks._scorer = looks.NoScorer()
        self.assertFalse(self.c.get("/api/looks/status").json()["ready"])
        self.assertEqual(self.c.post("/api/looks/check", json={"image": {"input": "b.png"}, "characters": []}).status_code, 503)


if __name__ == "__main__":
    unittest.main()
