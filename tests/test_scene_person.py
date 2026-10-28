"""Tests for "Calibrate from a person" on the server (app/sceneasset.py POST /api/scene/person, look/person_worker.py)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
os.environ.setdefault("DECK_COMFY_DIR", "")

from fastapi.testclient import TestClient  # noqa: E402

from app import looks, main, sceneasset  # noqa: E402


class ScenePerson(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(main.app)

    def test_needs_a_picture(self):
        self.assertEqual(self.c.post("/api/scene/person", json={}).status_code, 400)

    def test_no_detector_here(self):
        with mock.patch.object(looks.ClipScorer, "__init__", lambda s: setattr(s, "py", None) or setattr(s, "det", None)):
            r = self.c.post("/api/scene/person", json={"image": "a.png"})
        self.assertEqual(r.status_code, 503)

    def test_waits_for_comfyui(self):
        def init(s):
            s.py, s.det = Path(sys.executable), Path(__file__)
        with mock.patch.object(looks.ClipScorer, "__init__", init), mock.patch.object(sceneasset, "_comfy_busy", lambda: True):
            r = self.c.post("/api/scene/person", json={"image": "a.png"})
        self.assertEqual(r.status_code, 409)
        self.assertIn("busy", r.json()["detail"])

    def test_worker_error_comes_back(self):
        # a picture that isn't one: the worker answers with an error line, which becomes an exception
        bad = Path(tempfile.mkdtemp()) / "x.png"
        bad.write_bytes(b"not a picture")
        with self.assertRaises(RuntimeError):
            sceneasset.find_people(bad, Path(sys.executable), bad)


if __name__ == "__main__":
    unittest.main()
