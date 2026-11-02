"""Tests for the 3D tab's file import (app/sceneasset.py)."""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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


class OpenInBlender(unittest.TestCase):
    def setUp(self):
        self.dir = config.PROJECTS_DIR / "blender-test" / ".deck" / "assets" / "a1"
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "m.glb").write_bytes(b"glTF")
        (self.dir / "m.txt").write_text("no")
        self.url = "/files/projects/blender-test/.deck/assets/a1/m.glb"
        self.addCleanup(shutil.rmtree, config.PROJECTS_DIR / "blender-test", True)
        for p in (mock.patch.object(sceneasset, "BLENDER", self.dir / "m.glb"),
                  mock.patch.object(sceneasset, "_desktop_env", lambda: {"DISPLAY": ":0"})):
            p.start()
            self.addCleanup(p.stop)

    def _client(self, client):   # (no startup: that's the whole app's, and it would run once per client)
        return TestClient(main.app, client=(client, 5000))

    def _post(self, client, url):
        proc = mock.Mock()
        proc.wait.side_effect = subprocess.TimeoutExpired("blender", 2)
        with mock.patch.object(sceneasset.subprocess, "Popen", return_value=proc) as popen:
            return self._client(client).post("/api/scene/blender", json={"url": url}), popen, None

    def test_opens_on_this_pc(self):
        r, popen, _ = self._post("127.0.0.1", self.url)
        self.assertEqual(r.status_code, 200)
        cmd, env = popen.call_args.args[0], popen.call_args.kwargs["env"]
        self.assertEqual(cmd[-1], str(self.dir / "m.glb"))
        self.assertIn("rm -rf", " ".join(cmd))   # (its temporary folder goes when it closes)
        self.assertTrue(env["TMPDIR"].startswith(tempfile.gettempdir()))
        shutil.rmtree(env["TMPDIR"], ignore_errors=True)

    def test_another_device_cant_open_a_window_here(self):
        r, popen, _ = self._post("192.168.3.50", self.url)
        self.assertEqual(r.status_code, 403)
        popen.assert_not_called()
        self.assertFalse(self._client("192.168.3.50").get("/api/scene/blender").json()["can"])
        self.assertTrue(self._client("127.0.0.1").get("/api/scene/blender").json()["can"])

    def test_only_a_model_in_a_project(self):
        for url in ("/files/projects/blender-test/.deck/assets/a1/m.txt", "/files/projects/blender-test/../../secret.glb", "/etc/passwd"):
            r, popen, _ = self._post("127.0.0.1", url)
            self.assertIn(r.status_code, (400, 404), url)
            popen.assert_not_called()

    def test_gone_straight_away_says_so_and_leaves_nothing(self):
        proc = mock.Mock()
        proc.wait.return_value = 1
        with mock.patch.object(sceneasset.subprocess, "Popen", return_value=proc) as popen:
            r = self._client("127.0.0.1").post("/api/scene/blender", json={"url": self.url})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(Path(popen.call_args.kwargs["env"]["TMPDIR"]).exists())


if __name__ == "__main__":
    unittest.main()
