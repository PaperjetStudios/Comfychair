"""Projects in Settings: order, rename, duplicate (rows + files), delete (rows + folder, refusals, staying
inside the projects folder). Run: .venv/bin/python -m unittest discover tests"""
import json
import os
import shutil
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

config = db = main = projects = TestClient = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global config, db, main, projects, TestClient
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from fastapi.testclient import TestClient as T
    from app import config as c, db as d, main as m, projects as p
    config, db, main, projects, TestClient = c, d, m, p, T
    # never the live data: every write below goes into this folder
    assert not str(config.DATA_DIR).startswith(str(config.BASE_DIR / "data")), config.DATA_DIR


def gen(pid, status="done", files=("a.png",), parent=None, params=None):
    """A generation in project pid with real output files."""
    gid = db.create_generation(pid, "t", params or {"prompt": "x"}, {"1": {}}, f"p-{time.time_ns()}", parent)
    folder = db.project_folder(pid)
    outs = []
    for f in files:
        rel = f"{folder}/{gid:05d}_{f}"
        (config.PROJECTS_DIR / rel).parent.mkdir(parents=True, exist_ok=True)
        (config.PROJECTS_DIR / rel).write_bytes(b"x" * 100)
        outs.append({"filename": f"{gid:05d}_{f}", "path": rel, "kind": "image", "node": "9"})
    db.update_generation(gid, status=status, outputs=outs)
    return gid


class Projects(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        async def idle():
            return None
        # the app's startup runs (the copy jobs need its event loop), but without ComfyUI or its loops
        cls.patches = [mock.patch.object(main.comfy, "start", mock.AsyncMock()), mock.patch.object(main.comfy, "stop", mock.AsyncMock()),
                       mock.patch.object(main, "reconcile_loop", idle), mock.patch.object(main.clipimport, "sweeper", idle)]
        for p in cls.patches:
            p.start()
        cls.c = TestClient(main.app)
        cls.c.__enter__()
        cls.events = []

        async def grab(msg):
            cls.events.append(msg)
        cls._old = projects.notify
        projects.notify = grab

    @classmethod
    def tearDownClass(cls):
        projects.notify = cls._old
        cls.c.__exit__(None, None, None)
        for p in cls.patches:
            p.stop()

    def new(self, name=None):
        return db.create_project(name or f"P{time.time_ns()}")

    def wait_jobs(self):
        for _ in range(200):
            if not any(j["state"] == "copying" for j in self.c.get("/api/projects/jobs").json()):
                return
            time.sleep(0.05)
        self.fail("copy didn't finish")

    # ---- order ----
    def test_order_is_kept_and_new_projects_go_last(self):
        a, b, c = self.new(), self.new(), self.new()
        ids = [p["id"] for p in self.c.get("/api/projects").json()]
        self.assertEqual(ids[-3:], [a["id"], b["id"], c["id"]])
        want = [c["id"], *[i for i in ids if i not in (a["id"], b["id"], c["id"])], a["id"], b["id"]]
        r = self.c.post("/api/projects/order", json={"ids": want})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([p["id"] for p in self.c.get("/api/projects").json()], want)
        self.assertTrue(any(e["type"] == "deck_projects" and e["data"]["reason"] == "order" for e in self.events))

    def test_order_must_name_every_project_once(self):
        ids = [p["id"] for p in db.list_projects()]
        self.assertEqual(self.c.post("/api/projects/order", json={"ids": ids[:-1]}).status_code, 409)
        self.assertEqual(self.c.post("/api/projects/order", json={"ids": ids + ids[:1]}).status_code, 409)
        self.assertEqual(self.c.post("/api/projects/order", json={"ids": ["x"]}).status_code, 400)

    def test_migration_adds_sort_once_on_an_old_database(self):
        td = Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, td)
        old = sqlite3.connect(td / "old.sqlite3")
        old.executescript("CREATE TABLE projects(id INTEGER PRIMARY KEY, name TEXT NOT NULL, created REAL NOT NULL, folder TEXT);"
                          "INSERT INTO projects(id, name, created) VALUES (3, 'C', 0), (1, 'A', 0), (2, 'B', 0);")
        old.commit()
        backup = sqlite3.connect(td / "backup.sqlite3")   # (the rule for schema changes: back up first)
        old.backup(backup)
        old.row_factory = sqlite3.Row
        db.migrate(old)
        db.migrate(old)   # again: nothing changes, nothing fails
        self.assertEqual([(r["id"], r["sort"]) for r in old.execute("SELECT * FROM projects ORDER BY sort")], [(1, 1), (2, 2), (3, 3)])
        self.assertEqual(backup.execute("SELECT COUNT(*) FROM projects").fetchone()[0], 3)
        self.assertNotIn("sort", [r[1] for r in backup.execute("PRAGMA table_info(projects)")])

    def test_rename_keeps_the_folder(self):
        p = self.new()
        r = self.c.patch(f"/api/projects/{p['id']}", json={"name": "Renamed thing"})
        self.assertEqual(r.json()["name"], "Renamed thing")
        self.assertEqual(r.json()["folder"], p["folder"])
        self.assertEqual(self.c.patch(f"/api/projects/{p['id']}", json={"name": " "}).status_code, 400)

    # ---- duplicate ----
    def test_duplicate_copies_files_docs_and_rows(self):
        p = self.new("Dup source")
        g1 = gen(p["id"])
        g2 = gen(p["id"], parent={"generation": g1, "frame": "last"}, files=("b.mp4",))
        gen(p["id"], status="running")
        doc_dir = config.PROJECTS_DIR / p["folder"] / ".deck" / "video-tabs"
        doc_dir.mkdir(parents=True)
        url = f"/files/projects/{p['folder'].replace(' ', '%20')}/{g2:05d}_b.mp4"
        (doc_dir / "t1.json").write_text(json.dumps({"id": "t1", "payload": {"clips": [{"src": {"generation": g2, "index": 0}, "url": url}]}}))
        r = self.c.post(f"/api/projects/{p['id']}/duplicate", json={})
        self.assertEqual(r.status_code, 200, r.text)
        cp = r.json()["project"]
        self.assertEqual(cp["name"], "Dup source copy")
        ids = [x["id"] for x in db.list_projects()]
        self.assertEqual(ids.index(cp["id"]), ids.index(p["id"]) + 1)   # right after the original
        self.wait_jobs()
        new_dir = config.PROJECTS_DIR / cp["folder"]
        self.assertNotEqual(new_dir, config.PROJECTS_DIR / p["folder"])
        self.assertTrue((new_dir / f"{g1:05d}_a.png").is_file())
        self.assertTrue((config.PROJECTS_DIR / p["folder"] / f"{g1:05d}_a.png").is_file())   # the original is untouched
        rows = db.list_generations(cp["id"])
        self.assertEqual(len(rows), 2)   # the running one isn't copied
        by_tpl = sorted(rows, key=lambda g: g["id"])
        c1, c2 = by_tpl
        self.assertNotIn(c1["id"], (g1, g2))
        self.assertEqual(c2["parent"], {"generation": c1["id"], "frame": "last"})
        self.assertTrue(all(o["path"].startswith(cp["folder"] + "/") for g in rows for o in g["outputs"]))
        self.assertTrue((config.PROJECTS_DIR / c2["outputs"][0]["path"]).is_file())
        doc = json.loads((new_dir / ".deck" / "video-tabs" / "t1.json").read_text())
        clip = doc["payload"]["clips"][0]
        self.assertEqual(clip["src"]["generation"], c2["id"])
        self.assertTrue(clip["url"].startswith(f"/files/projects/{cp['folder'].replace(' ', '%20')}/"), clip["url"])
        self.assertEqual(self.c.get(clip["url"]).status_code, 200)
        orig = json.loads((doc_dir / "t1.json").read_text())
        self.assertEqual(orig["payload"]["clips"][0]["src"]["generation"], g2)
        # a second copy gets its own name
        r2 = self.c.post(f"/api/projects/{p['id']}/duplicate", json={})
        self.wait_jobs()
        self.assertEqual(r2.json()["project"]["name"], "Dup source copy 2")
        self.assertFalse(list(config.PROJECTS_DIR.glob(".tmp-copy-*")))

    def test_deleting_a_copy_leaves_the_original(self):
        p = self.new("Orig keep")
        g = gen(p["id"])
        cp = self.c.post(f"/api/projects/{p['id']}/duplicate", json={}).json()["project"]
        self.wait_jobs()
        self.assertEqual(self.c.delete(f"/api/projects/{cp['id']}", params={"confirm": cp["name"]}).status_code, 200)
        self.assertTrue((config.PROJECTS_DIR / p["folder"] / f"{g:05d}_a.png").is_file())
        self.assertEqual(len(db.list_generations(p["id"])), 1)

    # ---- delete ----
    def test_delete_removes_rows_and_folder(self):
        p = self.new("Doomed")
        gen(p["id"]); gen(p["id"], status="error")
        folder = config.PROJECTS_DIR / p["folder"]
        (folder / ".deck" / "gen-tabs").mkdir(parents=True)
        (folder / ".deck" / "gen-tabs" / "x.json").write_text("{}")
        self.assertEqual(self.c.delete(f"/api/projects/{p['id']}").status_code, 400)   # the name wasn't typed
        self.assertEqual(self.c.delete(f"/api/projects/{p['id']}", params={"confirm": "nope"}).status_code, 400)
        self.assertTrue(folder.is_dir())
        r = self.c.delete(f"/api/projects/{p['id']}", params={"confirm": "Doomed"})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["generations"], 2)
        self.assertFalse(folder.exists())
        self.assertIsNone(db.get_project(p["id"]))
        self.assertEqual(db.list_generations(p["id"]), [])
        self.assertEqual(self.c.delete(f"/api/projects/{p['id']}", params={"confirm": "Doomed"}).status_code, 404)
        self.assertTrue(any(e["type"] == "deck_projects" and e["data"] == {"reason": "deleted", "id": p["id"], "name": "Doomed"}
                            for e in self.events))

    def test_delete_refuses_a_busy_project(self):
        p = self.new("Busy one")
        gid = gen(p["id"], status="queued")
        r = self.c.delete(f"/api/projects/{p['id']}", params={"confirm": "Busy one"})
        self.assertEqual(r.status_code, 409)
        self.assertTrue((config.PROJECTS_DIR / p["folder"]).is_dir())
        self.assertIsNotNone(db.get_generation(gid))
        db.update_generation(gid, status="running")
        self.assertEqual(self.c.delete(f"/api/projects/{p['id']}", params={"confirm": "Busy one"}).status_code, 409)

    def test_delete_refuses_the_last_project(self):
        # on a copy of the test database (made with backup), so the other tests' projects stay
        scratch = sqlite3.connect(":memory:", check_same_thread=False)
        db._conn.backup(scratch)
        scratch.row_factory = sqlite3.Row
        with mock.patch.object(db, "_conn", scratch):
            keep, *rest = db.list_projects()
            for p in rest:
                scratch.execute("DELETE FROM projects WHERE id=?", (p["id"],))
            scratch.commit()
            r = self.c.delete(f"/api/projects/{keep['id']}", params={"confirm": keep["name"]})
            self.assertEqual(r.status_code, 409)
            self.assertIn("only project", r.json()["detail"])
            self.assertIsNotNone(db.get_project(keep["id"]))
        self.assertGreater(len(db.list_projects()), 1)

    def test_delete_does_not_follow_links_out_of_the_projects_folder(self):
        outside = Path(tempfile.mkdtemp(prefix="deck-outside-")); self.addCleanup(shutil.rmtree, outside, True)
        (outside / "precious.txt").write_text("keep me")
        # 1. a link inside the project's folder pointing outside: the link goes, the target stays
        p = self.new("Has a link")
        folder = config.PROJECTS_DIR / p["folder"]
        folder.mkdir(parents=True)
        (folder / "elsewhere").symlink_to(outside, target_is_directory=True)
        (folder / "file-link").symlink_to(outside / "precious.txt")
        self.assertEqual(self.c.delete(f"/api/projects/{p['id']}", params={"confirm": "Has a link"}).status_code, 200)
        self.assertFalse(folder.exists())
        self.assertEqual((outside / "precious.txt").read_text(), "keep me")
        # 2. the project's folder itself is a link to outside: only the link is removed
        q = self.new("Is a link")
        link = config.PROJECTS_DIR / q["folder"]
        link.symlink_to(outside, target_is_directory=True)
        self.assertEqual(self.c.delete(f"/api/projects/{q['id']}", params={"confirm": "Is a link"}).status_code, 200)
        self.assertFalse(link.is_symlink() or link.exists())
        self.assertEqual((outside / "precious.txt").read_text(), "keep me")
        # 3. a folder name that would leave the projects folder is never used
        for bad in ("..", "../x", "/tmp", ".", "", "Unsorted", ".tmp-copy-1"):
            self.assertIsNone(projects.project_dir(bad), bad)
        r = self.new("Bad folder")
        db._q("UPDATE projects SET folder=? WHERE id=?", ("..", r["id"]))
        self.assertEqual(self.c.delete(f"/api/projects/{r['id']}", params={"confirm": "Bad folder"}).status_code, 200)
        self.assertTrue(config.PROJECTS_DIR.is_dir() and config.DATA_DIR.is_dir())

    def test_remove_folder_refuses_anything_not_directly_in_the_projects_folder(self):
        td = Path(tempfile.mkdtemp()); self.addCleanup(shutil.rmtree, td, True)
        with self.assertRaises(RuntimeError):
            projects.remove_folder(td)
        self.assertTrue(td.is_dir())

    def test_stats(self):
        p = self.new()
        gen(p["id"], files=("a.png", "b.png"))
        s = self.c.get("/api/projects/stats").json()[str(p["id"])]
        self.assertEqual(s, {"bytes": 200, "generations": 1})


if __name__ == "__main__":
    unittest.main()
