"""Tests for the 3D tab's file import (app/sceneasset.py)."""
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
os.environ.setdefault("DECK_COMFY_DIR", "")

from fastapi.testclient import TestClient  # noqa: E402

from app import config, db, main, sceneasset  # noqa: E402

assert not str(config.DATA_DIR).startswith(str(config.BASE_DIR / "data")), config.DATA_DIR   # never the live data/


class SceneAsset(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(main.app)
        cls.pid = db.create_project("Asset Test")["id"]

    def up(self, name, data=b"x", **form):
        return self.c.post("/api/scene/asset", files={"file": (name, data)}, data={"project_id": str(self.pid), **form})

    def test_stores_in_project_folder_and_serves(self):
        r = self.up("My Model.glb", b"glTFdata")
        self.assertEqual(r.status_code, 200, r.text)
        j = r.json()
        self.assertEqual((j["kind"], j["name"], j["size"]), ("model", "My_Model.glb", 8))
        disk = Path(config.PROJECTS_DIR) / db.project_folder(self.pid) / ".deck" / "assets" / j["group"] / "My_Model.glb"
        self.assertEqual(disk.read_bytes(), b"glTFdata")
        self.assertTrue(j["url"].startswith("/files/projects/") and "/.deck/assets/" in j["url"])
        self.assertEqual(self.c.get(j["url"]).content, b"glTFdata")

    def test_splat_finds_a_picture_wherever_it_lives(self):
        """A painted layer sits in a subfolder of the local copies: the picture check must not use the bare file name."""
        paint = config.INPUT_DIR / main.PAINT_SUB
        paint.mkdir(exist_ok=True)
        (paint / "layer1.png").write_bytes(b"png")
        sub = config.COMFY_INPUT_SUBFOLDER
        old = (sceneasset.SHARP, sceneasset.SHARP_CKPT)
        sceneasset.SHARP = sceneasset.SHARP_CKPT = Path("/nonexistent/sharp")   # (past the picture check, then stops: no GPU in a test)
        try:
            self.assertEqual(self.c.post("/api/scene/splat", json={"image": ""}).json()["detail"], "Pick a picture")
            gone = self.c.post("/api/scene/splat", json={"image": f"{sub}/nothing-here.png"})
            self.assertEqual(gone.status_code, 400)
            self.assertIn("pick it again", gone.json()["detail"])
            found = self.c.post("/api/scene/splat", json={"image": f"{sub}/{main.PAINT_SUB}/layer1.png"})
            self.assertIn("SHARP isn't installed", found.json()["detail"])
        finally:
            sceneasset.SHARP, sceneasset.SHARP_CKPT = old
            (paint / "layer1.png").unlink()

    def test_cleanup_refuses_what_it_cannot_clean(self):
        j = self.up("m.glb", b"glTFdata").json()
        ok = {"url": j["url"], "mode": "decimate", "amount": 0.3}
        self.assertEqual(self.c.post("/api/scene/cleanup", json={**ok, "mode": "nope"}).status_code, 400)
        self.assertEqual(self.c.post("/api/scene/cleanup", json={**ok, "url": "/files/projects/../x.glb"}).status_code, 404)
        self.assertEqual(self.c.post("/api/scene/cleanup", json={**ok, "url": "/files/projects/nowhere/a.glb"}).status_code, 404)
        self.assertEqual(self.c.post("/api/scene/cleanup", json={**ok, "amount": "lots"}).status_code, 400)
        fbx = self.up("m.fbx").json()
        self.assertEqual(self.c.post("/api/scene/cleanup", json={**ok, "url": fbx["url"]}).status_code, 404)

    def test_group_keeps_related_files_together(self):
        a = self.up("box.obj").json()
        b = self.up("box.mtl", group=a["group"]).json()
        self.assertEqual(a["group"], b["group"])
        self.assertEqual(b["kind"], "extra")

    def test_allowlist(self):
        for bad in ("evil.py", "a.exe", "noext", "x.html", "x.svg"):
            self.assertEqual(self.up(bad).status_code, 400, bad)
        for ok, kind in (("a.fbx", "model"), ("a.gltf", "model"), ("a.PLY", "splat"), ("a.splat", "splat"),
                         ("a.ksplat", "splat"), ("a.spz", "splat"), ("a.png", "extra")):
            r = self.up(ok)
            self.assertEqual((r.status_code, r.json().get("kind")), (200, kind), ok)

    def test_size_cap(self):
        old, sceneasset.MAX_ASSET = sceneasset.MAX_ASSET, 1000
        try:
            r = self.up("big.glb", b"x" * 1001)
            self.assertEqual(r.status_code, 413)
            self.assertEqual(self.up("ok.glb", b"x" * 1000).status_code, 200)
            # a refused file leaves nothing behind
            root = Path(config.PROJECTS_DIR) / db.project_folder(self.pid) / ".deck" / "assets"
            self.assertFalse(list(root.glob("*/big.glb")))
        finally:
            sceneasset.MAX_ASSET = old

    def test_path_safety(self):
        for name in ("../../evil.glb", "..\\..\\evil.glb", "/etc/x.glb", "a/b/c.glb"):
            j = self.up(name).json()
            self.assertNotIn("..", j["url"])
            self.assertEqual(j["name"], Path(name.replace("\\", "/")).name)
        self.assertEqual(self.up(".hidden.glb").json()["name"], "hidden.glb")
        for g in ("../x", "abcdefgh1", "ABCDEFGH", "../../..", "12345"):
            self.assertEqual(self.up("a.glb", group=g).status_code, 400, g)

    def test_unknown_project(self):
        r = self.c.post("/api/scene/asset", files={"file": ("a.glb", b"x")}, data={"project_id": "99999"})
        self.assertEqual(r.status_code, 404)

    def test_unsorted(self):
        r = self.c.post("/api/scene/asset", files={"file": ("a.glb", b"x")})
        self.assertEqual(r.status_code, 200)
        self.assertIn("/files/projects/Unsorted/", r.json()["url"])


if __name__ == "__main__":
    unittest.main()
