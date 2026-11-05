"""Size limits (app/sizelimits.py): a run bigger than the largest of its kind that finished on this card is asked about
(409 tooBig, sent again with force), and one HARD times bigger is refused even with force.
Run: DECK_DATA=$(mktemp -d) .venv/bin/python -m pytest -q tests/test_sizelimits.py"""
import os
import tempfile
import time
import unittest
from unittest import mock

config = db = main = sizelimits = tpl = TestClient = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global config, db, main, sizelimits, tpl, TestClient
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from fastapi.testclient import TestClient as T
    from app import config as c, db as d, main as m, sizelimits as s
    from app import templates as t
    config, db, main, sizelimits, tpl, TestClient = c, d, m, s, t, T
    assert not str(config.DATA_DIR).startswith(str(config.BASE_DIR / "data")), config.DATA_DIR


def fields_of(tid):
    t = tpl.get(config.TEMPLATES_DIR, tid)
    return t, tpl.describe(t, None)["fields"]


def done_run(tid, params):
    gid = db.create_generation(None, tid, params, {}, f"p-{time.time_ns()}")
    db.update_generation(gid, status="done")
    return gid


class Measure(unittest.TestCase):
    def test_width_and_height_set_the_size(self):
        t, fields = fields_of("deck-klein9b-t2i")
        m = sizelimits.measure({"7.width": 1024, "7.height": 512}, fields, t.workflow)
        self.assertEqual((m["w"], m["h"], m["frames"], m["size"]), (1024, 512, 1, 1024 * 512))

    def test_a_template_without_a_size_has_none(self):
        self.assertIsNone(sizelimits.measure({"1.text": "x"}, [{"key": "1.text", "input": "text", "kind": "text", "node": "1"}], {}))

    def test_seconds_count_as_frames(self):
        fields = [{"key": "a.width", "input": "width", "kind": "int", "node": "a"},
                  {"key": "a.height", "input": "height", "kind": "int", "node": "a"},
                  {"key": "s.value", "input": "value", "kind": "float", "node": "s", "group": "Length (seconds)"}]
        m = sizelimits.measure({"a.width": 100, "a.height": 100, "s.value": 2}, fields, {"a": {"class_type": "EmptyLatentImage"}})
        self.assertEqual(m["frames"], 48)


class Check(unittest.TestCase):
    def test_nothing_known_passes(self):
        t, fields = fields_of("deck-klein9b-t2i")
        self.assertIsNone(sizelimits.check("deck-zznone-t2i", "x", {"7.width": 9000, "7.height": 9000}, fields, t.workflow))

    def test_learned_from_the_template_then_its_family(self):
        t, fields = fields_of("deck-klein9b-t2i")
        done_run("deck-zzfam-a", {"7.width": 1000, "7.height": 1000})
        self.assertIsNone(sizelimits.check("deck-zzfam-a", "A", {"7.width": 1000, "7.height": 1000}, fields, t.workflow))
        over = sizelimits.check("deck-zzfam-a", "A", {"7.width": 2000, "7.height": 1000}, fields, t.workflow)
        self.assertEqual((over["ratio"], over["hard"]), (2.0, False))
        self.assertIn("largest A run", over["message"])
        # a sibling with no finished run of its own goes by the family's
        sib = sizelimits.check("deck-zzfam-b", "B", {"7.width": 2000, "7.height": 2000}, fields, t.workflow)
        self.assertTrue(sib["hard"])
        self.assertIn("zzfam model", sib["message"])

    def test_failed_runs_teach_nothing(self):
        t, fields = fields_of("deck-klein9b-t2i")
        gid = db.create_generation(None, "deck-zzfail-a", {"7.width": 4000, "7.height": 4000}, {}, f"p-{time.time_ns()}")
        db.update_generation(gid, status="error")
        self.assertIsNone(sizelimits.check("deck-zzfail-a", "A", {"7.width": 4000, "7.height": 4000}, fields, t.workflow))


class Route(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        async def idle():
            return None
        cls.queued = []

        async def queue(wf, preview=None):
            cls.queued.append(wf)
            return {"prompt_id": f"size-{len(cls.queued)}-{time.time_ns()}"}
        cls.patches = [mock.patch.object(main.comfy, "queue", queue), mock.patch.object(main.comfy, "start", mock.AsyncMock()),
                       mock.patch.object(main.comfy, "stop", mock.AsyncMock()), mock.patch.object(main, "reconcile_loop", idle),
                       mock.patch.object(main.clipimport, "sweeper", idle),
                       mock.patch.object(main, "object_info_or_none", mock.AsyncMock(return_value=None))]
        for p in cls.patches:
            p.start()
        cls.client = TestClient(main.app).__enter__()
        done_run("deck-klein9b-t2i", {"7.width": 1024, "7.height": 1024})

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)
        for p in cls.patches:
            p.stop()

    def post(self, w, h, **extra):
        return self.client.post("/api/generate", json={"template": "deck-klein9b-t2i", "values": {"7.width": w, "7.height": h}, **extra})

    def test_inside_runs(self):
        self.assertEqual(self.post(1024, 1024).status_code, 200)

    def test_over_asks_and_force_runs(self):
        n = len(self.queued)
        r = self.post(1536, 1536)
        self.assertEqual(r.status_code, 409)
        self.assertTrue(r.json()["detail"]["tooBig"])
        self.assertEqual(len(self.queued), n)
        self.assertEqual(self.post(1536, 1536, force=True).status_code, 200)
        self.assertEqual(len(self.queued), n + 1)

    def test_far_over_is_refused_even_with_force(self):
        r = self.post(2048, 2048, force=True)
        self.assertEqual(r.status_code, 400)
        self.assertIn("can't fit", r.json()["detail"]["message"])


if __name__ == "__main__":
    unittest.main()
