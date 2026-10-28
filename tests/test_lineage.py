"""What a run is made from (app/main.py lineage): worked out from the run's inputs when the caller doesn't
say, the same for every tab. Run: .venv/bin/python -m unittest discover tests"""
import io
import os
import tempfile
import time
import unittest
from unittest import mock

config = db = main = TestClient = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global config, db, main, TestClient
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from fastapi.testclient import TestClient as T
    from app import config as c, db as d, main as m
    config, db, main, TestClient = c, d, m, T
    assert not str(config.DATA_DIR).startswith(str(config.BASE_DIR / "data")), config.DATA_DIR


def png():
    from PIL import Image
    b = io.BytesIO()
    Image.new("RGB", (64, 48), (200, 40, 40)).save(b, "PNG")
    return b.getvalue()


def picture_gen(pid):
    """A finished generation with one real picture."""
    gid = db.create_generation(pid, "t", {}, {}, f"p-{time.time_ns()}", None)
    rel = f"{db.project_folder(pid)}/{gid:05d}_a.png"
    (config.PROJECTS_DIR / rel).parent.mkdir(parents=True, exist_ok=True)
    (config.PROJECTS_DIR / rel).write_bytes(png())
    db.update_generation(gid, status="done", outputs=[{"filename": f"{gid:05d}_a.png", "path": rel, "kind": "image", "node": "9"}])
    return gid


class Rule(unittest.TestCase):
    F = [{"key": "img", "kind": "image"}, {"key": "snd", "kind": "audio"}, {"key": "vid", "kind": "video"}, {"key": "vid2", "kind": "video"}]

    def test_video_before_picture_before_sound(self):
        v = {"img": "comfydeck/x.png", "snd": {"generation": 3, "index": 0}, "vid": {"media": "a.mp4"}, "vid2": {"generation": 7, "index": 1}}
        db.set_input_origin("comfydeck/x.png", {"generation": 5, "index": 0, "frame": "last"})
        self.assertEqual(main.lineage(self.F, v), {"generation": 7, "index": 1, "frame": None})
        del v["vid2"]
        self.assertEqual(main.lineage(self.F, v), {"generation": 5, "index": 0, "frame": "last"})
        v["img"] = "comfydeck/uploaded.png"   # a picture from the device: no origin
        self.assertEqual(main.lineage(self.F, v), {"generation": 3, "index": 0, "frame": None})

    def test_nothing_from_an_output(self):
        self.assertIsNone(main.lineage(self.F, {"img": "", "vid": {"media": "a.mp4"}, "snd": None}))


class Runs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        async def idle():
            return None
        n = iter(range(10**6))

        async def queue(wf, preview=None):
            return {"prompt_id": f"run-{next(n)}-{time.time_ns()}"}

        async def upload(data, name, sub):
            (config.INPUT_DIR / name).write_bytes(data)   # (the local copy, as upload_prepared keeps)
            return f"{sub}/{name}"
        cls.patches = [mock.patch.object(main.comfy, "start", mock.AsyncMock()), mock.patch.object(main.comfy, "stop", mock.AsyncMock()),
                       mock.patch.object(main, "reconcile_loop", idle), mock.patch.object(main.clipimport, "sweeper", idle),
                       mock.patch.object(main.comfy, "queue", queue), mock.patch.object(main.comfy, "upload_image", upload),
                       mock.patch.object(main, "object_info_or_none", mock.AsyncMock(return_value=None))]
        for p in cls.patches:
            p.start()
        cls.c = TestClient(main.app)
        cls.c.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.c.__exit__(None, None, None)
        for p in cls.patches:
            p.stop()

    def run_with(self, values, **body):
        r = self.c.post("/api/generate", json={"template": "deck-krea2-i2i", "values": values, "batch": 2, "project_id": 1, **body})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def test_a_picture_sent_in_is_the_parent_cropped_or_not_and_on_every_run(self):
        gid = picture_gen(1)
        r = self.c.post(f"/api/generations/{gid}/to-input", json={"index": 0, "mp": 0})
        self.assertEqual(r.status_code, 200, r.text)
        name = r.json()["name"]
        for g in self.run_with({"20.image": name}):   # both runs of the batch, and again after a reload: no state on the tablet
            self.assertEqual(g["parent"], {"generation": gid, "index": 0, "frame": None})
        crop = self.c.post("/api/inputs/crop", json={"name": name, "crop": {"x": 0, "y": 0, "w": 0.5, "h": 1}, "mp": 0}).json()["name"]
        self.assertEqual(self.run_with({"20.image": crop})[0]["parent"]["generation"], gid)

    def test_a_named_parent_wins_and_none_without_an_output(self):
        gid = picture_gen(1)
        name = self.c.post(f"/api/generations/{gid}/to-input", json={"index": 0}).json()["name"]
        self.assertEqual(self.run_with({"20.image": name}, parent={"generation": 1, "index": 0, "frame": None})[0]["parent"]["generation"], 1)
        self.assertIsNone(self.run_with({"20.image": ""})[0]["parent"])

    def test_the_tab_that_made_it_is_kept(self):
        face = {"kind": "vfx", "state": {"op": "ripple", "prompt": "rain"}}
        g = self.run_with({}, face=face)[0]
        self.assertEqual(db.get_generation(g["id"])["params"]["__face"], face)


if __name__ == "__main__":
    unittest.main()
