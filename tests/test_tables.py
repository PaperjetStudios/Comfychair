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

    def tab_names(self):
        return [x["name"] for x in self.c.get("/api/store/tables", params={"project_id": self.pid}).json()]

    def test_restore_leaves_a_doc_deleted_separately_earlier(self):
        q = {"project_id": self.pid}
        for k, i in (("edit-tabs", "a"), ("edit-tabs", "b"), ("video-tabs", "c")):
            self.put(k, i, {"x": 1})
        self.put("tables", "t1", {"v": 1, "frames": [{"id": "1", "kind": "image", "doc": "a"}, {"id": "2", "kind": "image", "doc": "b"},
                                                    {"id": "3", "kind": "video", "doc": "c"}]})
        self.assertEqual(self.c.delete("/api/store/edit-tabs/a", params=q).status_code, 200)
        self.assertEqual(self.c.delete("/api/store/tables/t1", params=q).status_code, 200)
        self.assertEqual(self.c.post("/api/store/tables/t1/restore", params=q).status_code, 200)
        self.assertEqual(self.ids("edit-tabs"), {"b"})
        self.assertEqual(self.ids("video-tabs"), {"c"})

    def test_bad_frames_do_not_break_delete_and_global_scope_cascades_nothing(self):
        q = {"project_id": self.pid}
        self.put("tables", "bad", {"v": 1, "frames": 5})
        self.assertEqual(self.c.delete("/api/store/tables/bad", params=q).status_code, 200)
        self.assertEqual(self.ids("tables"), set())
        self.put("edit-tabs", "e1", {"x": 1})
        g = self.c.put("/api/store/tables/gt", params={"scope": "global"},
                       json={"name": "g", "payload": {"frames": [{"id": "1", "kind": "image", "doc": "e1"}]}})
        self.assertEqual(g.status_code, 200)
        self.assertEqual(self.c.delete("/api/store/tables/gt", params={"scope": "global"}).status_code, 200)
        self.assertEqual(self.ids("edit-tabs"), {"e1"})
        self.assertEqual(self.c.post("/api/store/tables/gt/restore", params={"scope": "global"}).status_code, 200)
        self.c.delete("/api/store/tables/gt", params={"scope": "global"})

    def test_upgrade_twice_makes_one_imported_table_and_busy_gives_409(self):
        db.set_project_version(self.pid, 1)
        self.put("edit-tabs", "e1", {})
        projects.UPGRADING.add(self.pid)
        try:
            self.assertEqual(self.c.post(f"/api/projects/{self.pid}/upgrade").status_code, 409)
        finally:
            projects.UPGRADING.discard(self.pid)
        self.assertEqual(self.c.post(f"/api/projects/{self.pid}/upgrade").status_code, 200)
        self.assertEqual(self.c.post(f"/api/projects/{self.pid}/upgrade").json(), {"already": True})
        self.assertEqual(self.tab_names().count("Imported"), 1)

    def test_upgrade_failure_leaves_no_tables_and_version_1(self):
        db.set_project_version(self.pid, 1)
        self.put("edit-tabs", "e1", {})
        self.put("story-tabs", "st1", {}, name="S")
        real, n = store._write, []

        def flaky(path, doc):
            if doc.get("kind") == "tables":
                n.append(1)
                if len(n) == 2:
                    raise OSError("disk")
            return real(path, doc)
        with mock.patch.object(store, "_write", flaky), self.assertRaises(OSError):
            projects.upgrade_project(self.pid)
        self.assertEqual(self.ids("tables"), set())
        self.assertEqual(db.get_project(self.pid)["version"], 1)
        self.assertNotIn(self.pid, projects.UPGRADING)

    def test_patch_version_runs_the_upgrade(self):
        db.set_project_version(self.pid, 1)
        self.put("edit-tabs", "e1", {})
        r = self.c.patch(f"/api/projects/{self.pid}", json={"version": 2})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["version"], 2)
        self.assertEqual(self.tab_names(), ["Imported"])

    def test_fresh_install_sandbox_is_version_2(self):
        import subprocess
        import sys
        d = tempfile.mkdtemp(prefix="deck-fresh-")
        out = subprocess.run([sys.executable, "-c", "from app import db; print([(p['name'], p['version']) for p in db.list_projects()])"],
                             env={**os.environ, "DECK_DATA": d}, cwd=str(config.BASE_DIR), capture_output=True, text=True)
        self.assertIn("[('Sandbox', 2)]", out.stdout, out.stderr)

    def test_a_video_frames_old_vfx_doc_is_not_owned_by_its_table(self):
        # (frame.vfx is read into the frame's own state and trashed by the page; the table neither copies nor trashes it)
        q = {"project_id": self.pid}
        self.put("video-tabs", "v1", {"a": 1})
        self.put("vfx-tabs", "x1", {"op": "mask"})
        self.put("tables", "t1", {"v": 1, "frames": [{"id": "f1", "kind": "video", "doc": "v1", "vfx": "x1"}]})
        t2 = self.c.post("/api/store/tables/t1/duplicate", params=q).json()
        self.assertEqual(t2["payload"]["frames"][0]["vfx"], "x1")
        self.assertEqual(self.c.delete("/api/store/tables/t1", params=q).status_code, 200)
        self.assertEqual(self.ids("vfx-tabs"), {"x1"})
        r = self.c.put("/api/store/tables/t3", params=q, json={"name": "x", "payload": {"frames": [{"id": "z", "kind": "video", "vfx": "x1"}]}})
        self.assertEqual(r.status_code, 200, r.text)

    def test_duplicate_table_copies_its_docs_and_put_refuses_shared_docs(self):
        q = {"project_id": self.pid}
        self.put("edit-tabs", "e1", {"x": 1}, name="Pic")
        self.put("video-tabs", "v1", {"y": 2})
        self.c.put("/api/store/edit-tabs/e1/still", params=q, content=b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x02\0\0\0\x02" + b"\0" * 20)
        self.put("tables", "t1", {"v": 1, "frames": [{"id": "f1", "kind": "image", "doc": "e1"}, {"id": "f2", "kind": "video", "doc": "v1"},
                                                    {"id": "f3", "kind": "note", "text": "n"}]}, name="Main")
        r = self.c.post("/api/store/tables/t1/duplicate", params=q)
        self.assertEqual(r.status_code, 200, r.text)
        t2 = r.json()
        self.assertEqual((t2["kind"], t2["name"], t2["rev"]), ("tables", "Main copy", 1))
        self.assertNotEqual(t2["id"], "t1")
        self.assertGreater(t2["order"], 0)
        f = t2["payload"]["frames"]
        self.assertTrue(all(x["id"] not in ("f1", "f2", "f3") for x in f))
        self.assertNotIn(f[0]["doc"], ("e1", "v1"))
        self.assertEqual(f[2]["text"], "n")
        self.assertEqual(len(self.ids("edit-tabs")), 2)
        cp = self.c.get(f"/api/store/edit-tabs/{f[0]['doc']}", params=q).json()
        self.assertEqual((cp["name"], cp["payload"], cp["still"]["w"]), ("Pic", {"x": 1}, 2))
        self.assertIn(f[0]["doc"], cp["still"]["url"])
        self.assertEqual(self.c.get(f"/api/store/video-tabs/{f[1]['doc']}", params=q).json()["payload"], {"y": 2})
        # deleting the original leaves the copy's docs alone
        self.c.delete("/api/store/tables/t1", params=q)
        self.assertEqual(self.ids("edit-tabs"), {f[0]["doc"]})
        # a plain PUT naming another table's docs is refused
        self.c.post("/api/store/tables/t1/restore", params=q)
        r = self.c.put("/api/store/tables/t3", params=q, json={"name": "x", "payload": {"frames": [{"id": "z", "kind": "image", "doc": "e1"}]}})
        self.assertEqual((r.status_code, r.json()), (409, {"detail": "Those documents belong to another table"}))
        self.assertEqual(self.c.post("/api/store/tables/nope/duplicate", params=q).status_code, 404)

    def test_upgrade_skips_docs_and_stories_tables_already_have(self):
        q = {"project_id": self.pid}
        db.set_project_version(self.pid, 1)
        self.put("edit-tabs", "e1", {}); self.put("edit-tabs", "e2", {}); self.put("video-tabs", "v1", {"a": 1})
        self.put("story-tabs", "s1", {}); self.put("story-tabs", "s2", {})
        self.put("tables", "t1", {"v": 1, "frames": [{"id": "f", "kind": "image", "doc": "e1"}, {"id": "g", "kind": "video", "doc": "v1"}], "story": "s1"})
        r = self.c.post(f"/api/projects/{self.pid}/upgrade")
        self.assertEqual(r.status_code, 200, r.text)
        tabs = [self.c.get(f"/api/store/tables/{i}", params=q).json() for i in self.ids("tables")]
        imp = next(t for t in tabs if t["name"] == "Imported")
        self.assertEqual([f["doc"] for f in imp["payload"]["frames"]], ["e2"])
        self.assertEqual(sorted(t["payload"].get("story") or "" for t in tabs), ["", "s1", "s2"])
        self.assertEqual(self.c.put("/api/store/tables/" + imp["id"], params=q, json={"rev": 1, "payload": imp["payload"]}).status_code, 200)

    def test_duplicate_drops_story_and_story_tabs_follow_their_table(self):
        q = {"project_id": self.pid}
        self.put("story-tabs", "s1", {"x": 1})
        self.put("tables", "t1", {"v": 1, "frames": [], "story": "s1"})
        t2 = self.c.post("/api/store/tables/t1/duplicate", params=q).json()
        self.assertNotIn("story", t2["payload"])
        self.assertEqual(self.c.delete("/api/store/tables/t1", params=q).status_code, 200)
        self.assertEqual(self.ids("story-tabs"), set())
        self.assertEqual(self.c.post("/api/store/tables/t1/restore", params=q).status_code, 200)
        self.assertEqual(self.ids("story-tabs"), {"s1"})
        # a story doc deleted on its own: tables unlink it, keep everything else
        self.assertEqual(self.c.delete("/api/store/story-tabs/s1", params=q).status_code, 200)
        t1 = self.c.get("/api/store/tables/t1", params=q).json()
        self.assertNotIn("story", t1["payload"])
        self.assertEqual(self.ids("tables"), {"t1", t2["id"]})

    def test_ownership_409_is_detail_without_doc_and_story_is_not_a_frame_doc(self):
        q = {"project_id": self.pid}
        self.put("tables", "t1", {"frames": [], "story": "s1"})
        self.put("tables", "t2", {"frames": [], "story": "s1"})   # same story is not an ownership clash
        self.put("edit-tabs", "e1", {}); self.put("tables", "t3", {"frames": [{"id": "a", "kind": "image", "doc": "e1"}]})
        r = self.c.put("/api/store/tables/t4", params=q, json={"payload": {"frames": [{"id": "a", "kind": "image", "doc": "e1"}]}})
        self.assertEqual((r.status_code, r.json()), (409, {"detail": "Those documents belong to another table"}))
        self.assertNotIn("doc", r.json())

    def test_patch_name_and_version_while_busy_does_not_rename(self):
        db.set_project_version(self.pid, 1)
        name = db.get_project(self.pid)["name"]
        with mock.patch.object(projects, "_busy_ids", lambda: {self.pid}):
            r = self.c.patch(f"/api/projects/{self.pid}", json={"name": "Renamed", "version": 2})
        self.assertEqual(r.status_code, 409)
        self.assertEqual(db.get_project(self.pid)["name"], name)
