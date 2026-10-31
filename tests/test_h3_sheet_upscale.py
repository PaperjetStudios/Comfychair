"""A sheet run with Upscale on (app/h3upscale.py sheet_fields): when it finishes, the server queues its H3 upscale as a
follow-up made from it (routes/effects.sheet_follow_up), and that follow-up queues nothing more.
Run: .venv/bin/python -m unittest discover tests"""
import dataclasses
import os
import tempfile
import time
import unittest
from unittest import mock

config = db = main = effects = TestClient = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global config, db, main, effects, TestClient
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from fastapi.testclient import TestClient as T
    from app import config as c, db as d, main as m
    from app.routes import effects as e
    config, db, main, effects, TestClient = c, d, m, e, T
    assert not str(config.DATA_DIR).startswith(str(config.BASE_DIR / "data")), config.DATA_DIR


class SheetUpscale(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        async def idle():
            return None
        cls.queued = []

        async def queue(wf, preview=None):
            pid = f"sheet-{len(cls.queued)}-{time.time_ns()}"
            cls.queued.append((pid, wf))
            return {"prompt_id": pid}

        async def history(pid):   # every run made a clip and a sheet picture
            return {pid: {"status": {"status_str": "success"}, "outputs": {
                "15": {"gifs": [{"filename": "clip.mp4", "subfolder": "comfydeck/x", "type": "output"}]},
                "42": {"images": [{"filename": "sheet.png", "subfolder": "comfydeck/x", "type": "output"}]}}}}

        async def download(filename, subfolder, kind, path):
            path.write_bytes(b"x")

        probe = {"width": 448, "height": 768, "fps": 24, "duration": 12.25, "frames": 294}
        services = dataclasses.replace(effects.services, object_info_or_none=mock.AsyncMock(return_value=None))
        cls.patches = [mock.patch.object(main.comfy, "start", mock.AsyncMock()), mock.patch.object(main.comfy, "stop", mock.AsyncMock()),
                       mock.patch.object(main, "reconcile_loop", idle), mock.patch.object(main.clipimport, "sweeper", idle),
                       mock.patch.object(main.comfy, "queue", queue), mock.patch.object(main.comfy, "history", history),
                       mock.patch.object(main.comfy, "download", download), mock.patch.object(main.comfy, "forget", mock.AsyncMock()),
                       mock.patch.object(main.storage, "drop_comfy_outputs", mock.Mock()),
                       mock.patch.object(main.previews, "warm", mock.AsyncMock()),
                       mock.patch.object(main.videoedit, "probe", mock.Mock(return_value=probe)),
                       mock.patch.object(main, "object_info_or_none", mock.AsyncMock(return_value=None)),
                       mock.patch.object(effects, "services", services)]
        for p in cls.patches:
            p.start()
        cls.c = TestClient(main.app)
        cls.c.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.c.__exit__(None, None, None)
        for p in cls.patches:
            p.stop()

    def sheet(self, upscale):
        r = self.c.post("/api/generate", json={"template": "deck-h3-charsheet", "project_id": 1, "values": {
            "7.prompt": "a knight", "__deck.upscale": upscale, "__deck.upscale_strength": "Light"}})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()[0]

    def finish(self, g):
        self.c.portal.call(main.finalize, g["prompt_id"])
        return db.get_generation(g["id"])

    def children(self, gid):
        return [x for x in db.all_generations() if (x.get("parent") or {}).get("generation") == gid]

    def test_upscale_on_queues_one_follow_up_and_it_queues_none(self):
        g = self.sheet("1.5×")
        n = len(self.queued)
        self.assertEqual(self.finish(g)["status"], "done")
        kids = self.children(g["id"])
        self.assertEqual(len(kids), 1, kids)
        self.assertEqual(len(self.queued), n + 1)
        up = kids[0]
        self.assertEqual(up["template"], "h3 sheet upscale")
        self.assertEqual(up["status"], "queued")
        self.assertEqual(up["parent"]["index"], 0)   # the clip (output 0), not the sheet picture
        self.assertEqual((up["params"]["scale"], up["params"]["strength"], up["params"]["sheet"]), (1.5, "light", True))
        self.assertEqual(up["params"]["frame"], "672×1152")
        wf = self.queued[-1][1]
        self.assertEqual(wf["40"]["inputs"]["image"], ["up_dec", 0])
        self.assertEqual(wf["42"]["inputs"]["images"], ["41", 0])
        self.assertEqual(self.finish(up)["status"], "done")   # the upscale finishes: nothing more
        self.assertEqual(self.children(up["id"]), [])
        self.assertEqual(len(self.queued), n + 1)
        self.c.portal.call(main.finalize, g["prompt_id"])     # a second finish of the sheet doesn't queue again
        self.assertEqual(len(self.children(g["id"])), 1)

    def test_upscale_off_queues_nothing(self):
        g = self.sheet("Off")
        n = len(self.queued)
        self.finish(g)
        self.assertEqual(self.children(g["id"]), [])
        self.assertEqual(len(self.queued), n)


if __name__ == "__main__":
    unittest.main()
