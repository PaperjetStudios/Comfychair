"""Tests for the JSON document store (app/store.py). Run with: .venv/bin/python -m pytest -q tests"""
import os
import tempfile
import unittest

os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))  # before app.config makes its folders
os.environ.setdefault("DECK_COMFY_DIR", "")

from fastapi.testclient import TestClient  # noqa: E402

from app import config, db, main, store  # noqa: E402


class Store(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(main.app)
        cls.pid = db.create_project("Store Test")["id"]

    def setUp(self):
        self.events = []

        async def grab(msg):
            self.events.append(msg)
        self._old, store.notify = store.notify, grab
        self.k = "gen-tabs"
        self.q = f"?project_id={self.pid}"
        self.n = 0

    def tearDown(self):
        store.notify = self._old

    def url(self, did="", kind=None, q=None, tail=""):
        return f"/api/store/{kind or self.k}" + (f"/{did}" if did else "") + tail + (self.q if q is None else q)

    def put(self, did, q=None, **body):
        return self.c.put(self.url(did, q=q), json=body)

    def fresh(self):
        """A kind folder nobody else used: its own project."""
        pid = db.create_project(f"P{time_ns()}")["id"]
        self.q = f"?project_id={pid}"
        return pid

    def test_create_get_list_update(self):
        self.fresh()
        r = self.put("a", name="Alpha", payload={"x": 1}, rev=0)
        self.assertEqual(r.status_code, 200)
        d = r.json()
        self.assertEqual((d["id"], d["kind"], d["name"], d["rev"], d["payload"]), ("a", self.k, "Alpha", 1, {"x": 1}))
        self.assertEqual(self.c.get(self.url("a")).json(), d)
        self.put("b", name="Beta")  # rev absent on create is fine
        lst = self.c.get(self.url()).json()
        self.assertEqual([x["id"] for x in lst], ["a", "b"])
        self.assertNotIn("payload", lst[0])
        d2 = self.put("a", payload={"x": 2}, rev=1).json()
        self.assertEqual((d2["rev"], d2["name"], d2["payload"]), (2, "Alpha", {"x": 2}))  # name kept
        d3 = self.put("a", name="Alpha2", rev=2).json()
        self.assertEqual((d3["rev"], d3["payload"]), (3, {"x": 2}))  # payload kept
        self.assertEqual(self.c.get(self.url("nope")).status_code, 404)

    def test_stale_rev_conflict(self):
        self.fresh()
        self.put("a", payload={"v": 1}, rev=0)
        self.put("a", payload={"v": 2}, rev=1)
        r = self.put("a", payload={"v": 3}, rev=1)
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["doc"]["rev"], 2)
        self.assertEqual(r.json()["doc"]["payload"], {"v": 2})
        self.assertEqual(self.put("a", payload={}).status_code, 409)  # no rev on an existing doc
        self.assertEqual(self.put("a", payload={"v": 4}, rev=2).status_code, 200)
        # create over an existing doc with rev 0
        self.assertEqual(self.put("a", payload={}, rev=0).status_code, 409)
        # update of a deleted doc
        self.assertEqual(self.put("ghost", payload={}, rev=4).status_code, 409)

    def test_bad_kind_and_id(self):
        for kind in ("..", "nope", "gen-tabs%2F..", "%2e%2e", "/etc", "GEN-TABS"):
            r = self.c.get(f"/api/store/{kind}{self.q}")
            self.assertIn(r.status_code, (400, 404), kind)
        self.assertEqual(self.c.get("/api/store/nope" + self.q).status_code, 400)
        self.assertEqual(self.c.get("/api/store/..%2f" + self.q).status_code, 404)
        for did in ("a.b", "a%2Fb", "%2e%2e", "%2Fetc%2Fpasswd", "a%0A", "‥", "．．",
                    "café", "a b", "x" * 65, "a%00b", "..%5Cx"):
            for method in ("get", "put", "delete"):
                r = getattr(self.c, method)(self.url(did), **({"json": {"rev": 0}} if method == "put" else {}))
                self.assertIn(r.status_code, (400, 404, 405), f"{method} {did!r}")
        for did in ("..", ".", "", "a/b", "../x", "/etc/passwd", "\u2025", "a\n", "a\nb", "\uff0e\uff0e"):  # HTTP clients fold dots away, so call direct
            with self.assertRaises(store.HTTPException, msg=did):
                store._check_id(did)
        self.assertEqual(self.put("x" * 65, rev=0).status_code, 400)
        self.assertEqual(self.put("a b", rev=0).status_code, 400)
        self.assertEqual(self.put("café", rev=0).status_code, 400)
        self.assertEqual(self.put("x" * 64, rev=0).status_code, 200)
        self.assertEqual(self.c.put(self.url("bad", kind="nope"), json={}).status_code, 400)
        self.assertEqual(self.c.post(self.url(kind="nope", tail="/reorder"), json={"ids": []}).status_code, 400)
        self.assertEqual(self.c.get("/api/store/gen-tabs?project_id=999999").status_code, 404)
        self.assertEqual(self.c.get("/api/store/gen-tabs?scope=bogus").status_code, 400)
        self.assertEqual(self.c.get(f"/api/store/gen-tabs?scope=global&project_id={self.pid}").status_code, 400)

    def test_bad_body(self):
        self.fresh()
        for body in ({"name": 5}, {"order": "x"}, {"payload": []}, {"rev": "1"}, {"rev": True}):
            self.assertEqual(self.put("a", **body).status_code, 400, body)

    def test_delete_trash_restore(self):
        self.fresh()
        self.put("a", name="A", payload={"k": 1}, rev=0)
        r = self.c.delete(self.url("a"))
        self.assertEqual((r.status_code, r.json()["id"]), (200, "a"))
        self.assertEqual(self.c.get(self.url("a")).status_code, 404)
        self.assertEqual(self.c.get(self.url()).json(), [])
        self.assertEqual(self.c.delete(self.url("a")).status_code, 404)
        self.assertEqual(len(os.listdir(self._dir() / ".trash")), 1)
        r = self.c.post(self.url("a", tail="/restore"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["payload"], r.json()["rev"]), ({"k": 1}, 2))
        self.assertEqual(self.c.get(self.url("a")).json()["name"], "A")
        self.assertEqual(self.c.post(self.url("a", tail="/restore")).status_code, 409)  # live doc exists
        self.assertEqual(os.listdir(self._dir() / ".trash"), [])
        self.assertEqual(self.c.post(self.url("zzz", tail="/restore")).status_code, 404)
        # most recent trashed copy wins
        self.c.delete(self.url("a"))
        self.put("a", payload={"k": 9}, rev=0)
        self.c.delete(self.url("a"))
        r = self.c.post(self.url("a", tail="/restore"))
        self.assertEqual(r.json()["payload"], {"k": 9})

    def _dir(self):
        from pathlib import Path
        pid = int(self.q.split("=")[1])
        return Path(config.PROJECTS_DIR) / db.project_folder(pid) / ".deck" / self.k

    def test_reorder(self):
        self.fresh()
        for i in "abc":
            self.put(i, name=i, rev=0)
        self.assertEqual([x["id"] for x in self.c.get(self.url()).json()], ["a", "b", "c"])
        r = self.c.post(self.url(tail="/reorder"), json={"ids": ["c", "a", "b"]})
        self.assertEqual(r.status_code, 200)
        lst = self.c.get(self.url()).json()
        self.assertEqual([(x["id"], x["order"], x["rev"]) for x in lst], [("c", 0, 1), ("a", 1, 1), ("b", 2, 1)])  # rev untouched
        self.assertEqual(self.c.post(self.url(tail="/reorder"), json={"ids": ["a", "zz"]}).status_code, 404)
        self.assertEqual(self.c.post(self.url(tail="/reorder"), json={"ids": ["a", "a"]}).status_code, 400)
        self.assertEqual(self.c.post(self.url(tail="/reorder"), json={"ids": ["../x"]}).status_code, 400)
        self.assertEqual(self.c.post(self.url(tail="/reorder"), json={}).status_code, 400)
        r = self.put("a", order=-1)  # order-only PUT: no rev needed, rev not bumped
        self.assertEqual((r.status_code, r.json()["order"], r.json()["rev"]), (200, -1, 1))
        self.assertEqual(self.put("a", order=-1, rev=99).status_code, 200)
        self.assertEqual(self.put("a", name="x", order=5, rev=99).status_code, 409)  # name still needs rev
        self.assertEqual(self.put("a", name="x", order=5, rev=1).json()["rev"], 2)
        self.assertEqual(self.c.get(self.url()).json()[-1]["id"], "a")  # order 5

    def test_scopes_are_separate(self):
        self.fresh()
        g = "?scope=global"
        self.put("o", q=g, name="Global", payload={"g": 1}, rev=0)
        self.assertEqual(self.c.get(self.url(kind="gen-tabs")).json(), [])  # not in the project
        self.put("o", name="Proj", payload={"p": 1}, rev=0)  # same id, own rev counter
        self.assertEqual(self.c.get(self.url("o", q=g)).json()["payload"], {"g": 1})
        self.assertEqual(self.c.get(self.url("o")).json()["payload"], {"p": 1})
        self.assertTrue((config.LIBRARY_DIR / self.k / "o.json").is_file())
        self.assertTrue((self._dir() / "o.json").is_file())
        self.c.delete(self.url("o", q=g))
        self.assertEqual(self.c.get(self.url("o")).status_code, 200)
        # Unsorted (no project_id) is its own folder too
        self.put("u", q="", name="Un", rev=0)
        self.assertTrue((config.PROJECTS_DIR / "Unsorted" / ".deck" / self.k / "u.json").is_file())
        self.assertEqual(self.c.get(self.url("u")).status_code, 404)
        self.c.delete(self.url("u", q=""))

    def test_payload_cap(self):
        self.fresh()
        big = {"blob": "x" * (store.MAX_PAYLOAD + 1)}
        self.assertEqual(self.put("a", payload=big, rev=0).status_code, 413)
        self.assertEqual(self.c.get(self.url("a")).status_code, 404)
        ok = {"blob": "x" * (store.MAX_PAYLOAD - 100)}
        self.assertEqual(self.put("a", payload=ok, rev=0).status_code, 200)

    def test_atomic_write_leaves_no_temp_files(self):
        self.fresh()
        for n in range(5):
            self.put("a", payload={"n": n}, rev=n)
        self.c.post(self.url(tail="/reorder"), json={"ids": ["a"]})
        self.assertEqual(sorted(os.listdir(self._dir())), ["a.json"])
        # a failing write cleans up its temp file and keeps the old document
        real = store.os.replace

        def boom(*a):
            raise OSError("disk")
        store.os.replace = boom
        try:
            with self.assertRaises(OSError):
                store._write(self._dir() / "a.json", {"id": "a", "rev": 99})
        finally:
            store.os.replace = real
        self.assertEqual(sorted(os.listdir(self._dir())), ["a.json"])
        self.assertEqual(self.c.get(self.url("a")).json()["rev"], 5)

    def test_broadcast_events(self):
        self.fresh()
        self.put("a", rev=0)
        self.put("a", rev=1)
        self.c.delete(self.url("a"))
        self.assertEqual([(e["type"], e["kind"], e["id"], e["rev"], e.get("deleted")) for e in self.events],
                         [("store", self.k, "a", 1, None), ("store", self.k, "a", 2, None), ("store", self.k, "a", 2, True)])
        self.assertEqual(self.events[0]["scope"], "project")
        self.put("g", q="?scope=global", rev=0)
        self.assertEqual((self.events[-1]["scope"], self.events[-1]["project_id"]), ("global", None))

    def test_trash_pruning(self):
        import time
        self.fresh()
        for i in "ab":
            self.put(i, rev=0)
        self.c.delete(self.url("a"))
        tr = self._dir() / ".trash"
        old = tr / f"zz.{time.time_ns() - 31 * 86400 * 10**9}.json"
        recent = tr / f"zz.{time.time_ns() - 29 * 86400 * 10**9}.json"
        old.write_text("{}")
        recent.write_text("{}")
        self.c.delete(self.url("b"))
        names = os.listdir(tr)
        self.assertNotIn(old.name, names)
        self.assertIn(recent.name, names)
        self.assertEqual(len(names), 3)  # recent + a + b


class ProjectFolders(unittest.TestCase):
    def test_folder_frozen(self):
        a = db.create_project(f"Twin{time_ns()}")
        fa = db.project_folder(a["id"])
        self.assertEqual(fa, a["name"])
        b = db.create_project(a["name"])
        self.assertEqual(db.project_folder(a["id"]), fa)  # unchanged by the same-named sibling
        fb = db.project_folder(b["id"])
        self.assertNotEqual(fb, fa)
        self.assertEqual(fb, f"{a['name']} ({b['id']})")

    def test_legacy_row_freezes_on_first_call(self):
        cur = db._q("INSERT INTO projects(name, created) VALUES (?, 0)", (f"Old/{time_ns()}",))
        pid = cur.lastrowid
        f = db.project_folder(pid)
        self.assertIn("Old_", f)
        self.assertEqual(db._q("SELECT folder FROM projects WHERE id=?", (pid,)).fetchone()[0], f)
        db._q("UPDATE projects SET name='Renamed' WHERE id=?", (pid,))
        self.assertEqual(db.project_folder(pid), f)
        self.assertEqual(db.project_folder(None), "Unsorted")


class GenerationsFilter(unittest.TestCase):
    def test_edit_tab_and_status(self):
        c = TestClient(main.app)
        pid = db.create_project(f"Gens {time_ns()}")["id"]
        ids = {}
        for name, tab, st in (("a1", "A", "done"), ("a2", "A", "error"), ("b1", "B", "done"), ("a3", "A", "done")):
            g = db.create_generation(pid, "video edit", {"edit_tab": {"id": tab, "name": tab}}, {}, f"p-{name}-{time_ns()}")
            db.update_generation(g, status=st)
            ids[name] = g
        db.create_generation(pid, "video edit", {}, {}, f"p-none-{time_ns()}")  # no edit_tab at all
        got = c.get(f"/api/generations?project_id={pid}&edit_tab=A&status=done&limit=1").json()
        self.assertEqual([g["id"] for g in got], [ids["a3"]])  # newest done render of tab A
        got = c.get(f"/api/generations?project_id={pid}&edit_tab=A").json()
        self.assertEqual({g["id"] for g in got}, {ids["a1"], ids["a2"], ids["a3"]})
        self.assertEqual(c.get(f"/api/generations?project_id={pid}&edit_tab=nope").json(), [])
        self.assertEqual(len(c.get(f"/api/generations?project_id={pid}").json()), 5)


class StoreStill(unittest.TestCase):
    PNG = (b"\x89PNG\r\n\x1a\n" + (13).to_bytes(4, "big") + b"IHDR" + (30).to_bytes(4, "big") + (20).to_bytes(4, "big")
           + b"\x08\x02\x00\x00\x00" + b"\0" * 20)

    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(main.app)
        cls.pid = db.create_project(f"Still {time_ns()}")["id"]
        cls.q = f"?project_id={cls.pid}"

    def url(self, did, tail="/still", kind="edit-tabs"):
        return f"/api/store/{kind}/{did}{tail}{self.q}"

    def doc(self, did="s1"):
        return self.c.put(self.url(did, ""), json={"name": "S", "payload": {"a": 1}, "rev": 0}).json()

    def test_put_stores_png_and_keeps_rev(self):
        d = self.doc()
        r = self.c.put(self.url("s1"), content=self.PNG)
        self.assertEqual(r.status_code, 200)
        st = r.json()
        self.assertEqual((st["w"], st["h"], st["rev"]), (30, 20, 1))
        got = self.c.get(self.url("s1", ""))
        self.assertEqual(got.json()["rev"], d["rev"])
        self.assertEqual(got.json()["still"], st)
        self.assertEqual(self.c.get(st["url"]).content, self.PNG)  # served by the /files/projects mount
        self.assertEqual(self.c.put(self.url("s1"), content=self.PNG).json()["rev"], 2)
        self.assertEqual(next(x for x in self.c.get(f"/api/store/edit-tabs{self.q}").json() if x["id"] == "s1")["still"]["rev"], 2)  # list carries it
        # a later content save keeps the still
        self.assertEqual(self.c.put(self.url("s1", ""), json={"payload": {"a": 2}, "rev": 1}).json()["still"]["rev"], 2)

    def test_errors(self):
        self.assertEqual(self.c.put(self.url("nope"), content=self.PNG).status_code, 404)
        self.doc("s2")
        self.assertEqual(self.c.put(self.url("s2"), content=b"not a png at all, sorry......").status_code, 400)
        self.assertEqual(self.c.put(self.url("s2"), content=self.PNG + b"\0" * store.MAX_STILL).status_code, 413)
        self.assertEqual(self.c.put(self.url("bad.id"), content=self.PNG).status_code, 400)
        self.assertEqual(self.c.put(self.url("s2", kind="nope"), content=self.PNG).status_code, 400)
        self.assertEqual(self.c.put(f"/api/store/edit-tabs/s2/still?scope=global", content=self.PNG).status_code, 400)

    def test_delete_still(self):
        self.doc("s3")
        self.c.put(self.url("s3"), content=self.PNG)
        self.assertEqual(self.c.delete(self.url("s3")).status_code, 200)
        self.assertIsNone(self.c.get(self.url("s3", "")).json().get("still"))
        self.assertEqual(self.c.delete(self.url("zzz")).status_code, 404)

    def test_delete_trashes_still_and_restore_brings_it_back(self):
        self.doc("s4")
        st = self.c.put(self.url("s4"), content=self.PNG).json()
        folder = config.PROJECTS_DIR / db.project_folder(self.pid) / ".deck" / "edit-tabs"
        self.assertEqual(self.c.delete(self.url("s4", "")).status_code, 200)
        self.assertFalse((folder / "s4.png").exists())
        trashed = sorted(p.name for p in (folder / ".trash").glob("s4.*"))
        self.assertEqual(len(trashed), 2)
        self.assertEqual(trashed[0].rpartition(".")[0], trashed[1].rpartition(".")[0])  # same timestamp
        r = self.c.post(self.url("s4", "/restore"))
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["still"]["rev"], st["rev"])
        self.assertEqual((folder / "s4.png").read_bytes(), self.PNG)
        self.assertFalse(list((folder / ".trash").glob("s4.*")))


def time_ns():
    import time
    return time.time_ns()


if __name__ == "__main__":
    unittest.main()
