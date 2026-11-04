"""Tables: owned docs go to the trash and come back with their table; the version 1 to 2 project upgrade.
Run: .venv/bin/python -m unittest discover tests"""
import json
import os
import tempfile
import time
import unittest
from unittest import mock

config = db = main = projects = store = TestClient = None


def setUpModule():
    global config, db, main, projects, store, TestClient
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from fastapi.testclient import TestClient as T
    from app import config as c, db as d, main as m, projects as p, store as s
    config, db, main, projects, store, TestClient = c, d, m, p, s, T
    assert not str(config.DATA_DIR).startswith(str(config.BASE_DIR / "data")), config.DATA_DIR


class Tables(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        async def idle():
            return None
        cls.patches = [mock.patch.object(main.comfy, "start", mock.AsyncMock()), mock.patch.object(main.comfy, "stop", mock.AsyncMock()),
                       mock.patch.object(main, "reconcile_loop", idle), mock.patch.object(main.clipimport, "sweeper", idle)]
        for p in cls.patches:
            p.start()
        cls.c = TestClient(main.app)
        cls.c.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.c.__exit__(None, None, None)
        for p in cls.patches:
            p.stop()

    def setUp(self):
        self.pid = db.create_project(f"T{time.time_ns()}")["id"]

    def put(self, kind, did, payload, name=None):
        r = self.c.put(f"/api/store/{kind}/{did}", params={"project_id": self.pid}, json={"name": name or did, "payload": payload})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def ids(self, kind):
        return {x["id"] for x in self.c.get(f"/api/store/{kind}", params={"project_id": self.pid}).json()}

    def test_new_project_is_version_2(self):
        self.assertEqual(db.get_project(self.pid)["version"], 2)
        self.assertEqual(self.c.get("/api/projects").json()[-1]["version"], 2)

    def test_deleting_a_table_trashes_its_docs_and_restore_brings_them_back(self):
        self.put("edit-tabs", "e1", {"a": 1})
        self.put("video-tabs", "v1", {"a": 1})
        self.put("edit-tabs", "keep", {"a": 1})
        frames = [{"id": "f1", "kind": "image", "doc": "e1"}, {"id": "f2", "kind": "video", "doc": "v1"},
                  {"id": "f3", "kind": "scene", "doc": "gone"}, {"id": "f4", "kind": "note", "text": "x"}]
        self.put("tables", "t1", {"v": 1, "frames": frames})
        q = {"project_id": self.pid}
        self.assertEqual(self.c.delete("/api/store/tables/t1", params=q).status_code, 200)
        self.assertEqual(self.ids("tables"), set())
        self.assertEqual(self.ids("edit-tabs"), {"keep"})
        self.assertEqual(self.ids("video-tabs"), set())
        folder = config.PROJECTS_DIR / db.project_folder(self.pid) / ".deck"
        self.assertTrue(list((folder / "edit-tabs" / ".trash").glob("e1.*.json")))
        self.assertTrue(list((folder / "video-tabs" / ".trash").glob("v1.*.json")))
        self.assertEqual(self.c.post("/api/store/tables/t1/restore", params=q).status_code, 200)
        self.assertEqual(self.ids("tables"), {"t1"})
        self.assertEqual(self.ids("edit-tabs"), {"e1", "keep"})
        self.assertEqual(self.ids("video-tabs"), {"v1"})

    def test_upgrade(self):
        db.set_project_version(self.pid, 1)
        self.put("edit-tabs", "e1", {"size": {"w": 640, "h": 480}}, name="Pic")
        self.put("video-tabs", "v1", {}, name="Clip")
        self.put("story-tabs", "st1", {"scenes": []}, name="My story")
        r = self.c.post(f"/api/projects/{self.pid}/upgrade")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(len(r.json()["tables"]), 2)
        self.assertEqual(db.get_project(self.pid)["version"], 2)
        tabs = {x["name"]: self.c.get(f"/api/store/tables/{x['id']}", params={"project_id": self.pid}).json() for x in
                self.c.get("/api/store/tables", params={"project_id": self.pid}).json()}
        imp = tabs["Imported"]["payload"]
        self.assertEqual(imp["v"], 1)
        fr = {f["kind"]: f for f in imp["frames"]}
        self.assertEqual(len(imp["frames"]), 2)
        self.assertEqual((fr["image"]["w"], fr["image"]["h"], fr["image"]["doc"]), (640, 480, "e1"))
        self.assertEqual((fr["video"]["w"], fr["video"]["h"], fr["video"]["doc"]), (1024, 1024, "v1"))
        self.assertGreaterEqual(fr["video"]["y"], fr["image"]["y"] + 480 + 64)
        st = tabs["My story"]["payload"]
        self.assertEqual((st["story"], st["frames"]), ("st1", []))
        self.assertEqual(self.c.post(f"/api/projects/{self.pid}/upgrade").json(), {"already": True})

    def test_patch_version_only_to_2_and_duplicate_copies_it(self):
        db.set_project_version(self.pid, 1)
        self.assertEqual(self.c.patch(f"/api/projects/{self.pid}", json={"version": 1}).status_code, 400)
        r = self.c.patch(f"/api/projects/{self.pid}", json={"version": 2})
        self.assertEqual(r.json()["version"], 2)
        self.assertEqual(self.c.patch(f"/api/projects/{self.pid}", json={"version": 1}).status_code, 400)
        db.set_project_version(self.pid, 1)
        dup = self.c.post(f"/api/projects/{self.pid}/duplicate", json={}).json()
        self.assertEqual(dup["project"]["version"], 1)
        for _ in range(200):
            if not any(j["state"] == "copying" for j in self.c.get("/api/projects/jobs").json()):
                break
            time.sleep(0.05)
