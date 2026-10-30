"""Where files go and that they go away (app/storage.py): ComfyUI keeps nothing of a run once ComfyChair has its
copy, deleting a run, a picture or a project removes every copy and cache, and the sweep finds old leftovers but
never a sole copy. Run: .venv/bin/python -m unittest discover tests"""
import asyncio
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

config = db = main = storage = comfy = TestClient = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global config, db, main, storage, comfy, TestClient
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from fastapi.testclient import TestClient as T
    from app import comfy as cf, config as c, db as d, main as m, storage as s
    config, db, main, storage, comfy, TestClient = c, d, m, s, cf, T
    assert not str(config.DATA_DIR).startswith(str(config.BASE_DIR / "data")), config.DATA_DIR


def touch(p: Path, n=100, old=True) -> Path:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * n)
    if old:   # older than the sweep's ten minutes
        t = time.time() - 3600
        os.utime(p, (t, t))
    return p


class Storage(unittest.TestCase):
    def setUp(self):
        root = Path(tempfile.mkdtemp(prefix="deck-test-comfy-"))
        self.out, self.inp, self.tmp = root / "output", root / "input", root / "temp"
        for d in (self.out, self.inp, self.tmp):
            d.mkdir()
        self.patches = [mock.patch.object(config, "COMFY_OUTPUT_DIR", self.out), mock.patch.object(config, "COMFY_INPUT_DIR", self.inp),
                        mock.patch.object(config, "COMFY_TEMP_DIR", self.tmp), mock.patch.object(main.comfy, "forget", mock.AsyncMock())]
        for p in self.patches:
            p.start()
        self.pid = db.create_project(f"Store {time.time_ns()}")["id"]
        self.folder = db.project_folder(self.pid)

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def gen(self, name="h3_00001-audio.mp4", run="run-abc", keep_ours=True):
        """A finished run whose output ComfyUI saved (with a silent twin and a first-frame PNG beside it)."""
        sub = f"{config.COMFY_INPUT_SUBFOLDER}/{self.folder}/{run}"
        theirs = touch(self.out / sub / name)
        stem = name.removesuffix(".mp4").removesuffix("-audio")
        twins = [touch(self.out / sub / f"{stem}.mp4"), touch(self.out / sub / f"{stem}.png")]
        gid = db.create_generation(self.pid, "t", {"prompt": "x"}, {"1": {}}, f"p-{time.time_ns()}")
        rel = f"{self.folder}/{gid:05d}_{name}"
        ours = config.PROJECTS_DIR / rel
        if keep_ours:
            touch(ours)
        db.update_generation(gid, status="done", outputs=[{"filename": f"{gid:05d}_{name}", "path": rel, "kind": "video", "node": "9",
                                                           "comfy": {"filename": name, "subfolder": sub, "type": "output"}}])
        return gid, ours, theirs, twins

    def test_comfyui_keeps_nothing_once_we_have_the_copy(self):
        sub = self.out / config.COMFY_INPUT_SUBFOLDER / self.folder / "run-x1"
        files = [touch(sub / n) for n in ("h3_00001-audio.mp4", "h3_00001.mp4", "h3_00001.png")]
        other = touch(self.out / config.COMFY_INPUT_SUBFOLDER / self.folder / "run-x2" / "h3_00002.png")
        preview = touch(self.tmp / "ComfyUI_temp_00001_.png")
        item = {"filename": "h3_00001-audio.mp4", "subfolder": f"{config.COMFY_INPUT_SUBFOLDER}/{self.folder}/run-x1", "type": "output"}
        temp = {"filename": preview.name, "subfolder": "", "type": "temp"}
        ours = touch(Path(tempfile.mkdtemp()) / "ours.mp4")
        # our copy missing or empty: nothing goes (ComfyUI's may be the only one)
        self.assertEqual(storage.drop_comfy_outputs([item], [ours.with_name("gone.mp4")]), 0)
        self.assertTrue(all(f.exists() for f in files))
        storage.drop_comfy_outputs([item, temp], [ours])
        self.assertFalse(any(f.exists() for f in files), "the output, its silent twin and its PNG")
        self.assertFalse(sub.exists(), "the run's emptied folder")
        self.assertTrue(other.exists(), "another run's file stays")
        self.assertTrue(preview.exists(), "ComfyUI empties its temp folder itself")

    def test_a_queued_run_saves_into_its_own_folder(self):
        wf = {"1": {"class_type": "SaveImage", "inputs": {"filename_prefix": "comfydeck/P/krea2"}},
              "2": {"class_type": "MIAAutoRig", "inputs": {"fbx_name": ""}},
              "3": {"class_type": "X", "inputs": {"filename_prefix": "deck_tracks"}}}
        comfy.once(wf)
        a = wf["1"]["inputs"]["filename_prefix"]
        self.assertRegex(a, r"^comfydeck/P/run-[0-9a-f]{8}/krea2$")
        self.assertRegex(wf["3"]["inputs"]["filename_prefix"], r"^run-[0-9a-f]{8}/deck_tracks$")
        self.assertEqual(wf["2"]["inputs"]["fbx_name"], "deck_" + a.split("run-")[1].split("/")[0])
        comfy.once(wf)
        self.assertEqual(wf["1"]["inputs"]["filename_prefix"], a, "once only")

    def test_the_rig_mesh_copy(self):
        wf = {"meshpath": {"class_type": "PrimitiveString", "inputs": {"value": "3d/00672_object3d_00009.glb"}},
              "meshany": {"class_type": "LazySwitchKJ", "inputs": {"switch": True, "on_true": ["meshpath", 0], "on_false": ["meshpath", 0]}},
              "mesh": {"class_type": "UniRigLoadMesh", "inputs": {"source_folder": "input", "file_path": ["meshany", 0]}}}
        self.assertEqual(storage.rig_input(wf), self.inp / "3d" / "00672_object3d_00009.glb")
        wf["meshpath"]["inputs"]["value"] = "3d/Stanford_Bunny.stl"   # (UniRig's own samples stay)
        self.assertIsNone(storage.rig_input(wf))

    def test_deleting_a_run_removes_every_copy(self):
        gid, ours, theirs, twins = self.gen()
        mesh = touch(self.inp / "3d" / ours.name)
        thumbs = [touch(config.THUMB_DIR / "previews" / f"{storage.tag(ours.resolve())}-abc.jpg"),
                  touch(config.THUMB_DIR / "previews" / f"{storage.tag(ours.resolve())}-def.mp4")]
        with TestClient(main.app) as c:
            self.assertEqual(c.delete(f"/api/generations/{gid}").status_code, 200)
        for p in (ours, theirs, *twins, mesh, *thumbs):
            self.assertFalse(p.exists(), p)
        main.comfy.forget.assert_awaited()

    def test_deleting_a_picture(self):
        name = f"{config.COMFY_INPUT_SUBFOLDER}/pic{time.time_ns()}.png"
        files = [touch(config.INPUT_DIR / Path(name).name), touch(self.inp / name),
                 touch(config.THUMB_DIR / f"{storage.tag(name)}-256.jpg")]
        db.add_input(name, self.pid)
        with TestClient(main.app) as c:
            self.assertEqual(c.delete("/api/inputs", params={"name": "../secret.png"}).status_code, 400)
            self.assertEqual(c.delete("/api/inputs", params={"name": name}).status_code, 200)
        self.assertFalse(any(p.exists() for p in files))
        self.assertNotIn(name, [r["name"] for r in db.project_inputs(self.pid)])

    def test_a_project_takes_its_unused_pictures(self):
        sub = config.COMFY_INPUT_SUBFOLDER
        mine, shared = f"{sub}/mine{time.time_ns()}.png", f"{sub}/shared{time.time_ns()}.png"
        for n in (mine, shared):
            touch(config.INPUT_DIR / Path(n).name); touch(self.inp / n)
            db.add_input(n, self.pid)
        other = db.create_project(f"Other {time.time_ns()}")["id"]
        db.create_generation(other, "t", {"image": shared}, {}, f"p-{time.time_ns()}")
        name = db.get_project(self.pid)["name"]
        with TestClient(main.app) as c:
            self.assertEqual(c.delete(f"/api/projects/{self.pid}", params={"confirm": name}).status_code, 200)
        self.assertFalse((config.INPUT_DIR / Path(mine).name).exists() or (self.inp / mine).exists())
        self.assertTrue((config.INPUT_DIR / Path(shared).name).exists() and (self.inp / shared).exists(), "another project uses it")

    def test_sweep_never_takes_a_sole_copy(self):
        gid, ours, theirs, twins = self.gen()
        gid2, ours2, sole, twins2 = self.gen("h3_00002-audio.mp4", run="run-def", keep_ours=False)
        orphan = touch(self.out / config.COMFY_INPUT_SUBFOLDER / self.folder / "krea2_00009_.png")
        fresh = touch(self.out / config.COMFY_INPUT_SUBFOLDER / self.folder / "krea2_00010_.png", old=False)
        mesh, sample = touch(self.inp / "3d" / "00001_object3d_00001.glb"), touch(self.inp / "3d" / "bunny.stl")
        listed = {Path(i["path"]) for i in storage.sweep()["items"]}
        self.assertTrue({theirs, *twins, orphan, mesh} <= listed)
        self.assertNotIn(sole, listed, "ComfyUI's is the only copy left")
        self.assertFalse({fresh, sample} & listed)
        self.assertTrue(all(p.exists() for p in listed), "listing deletes nothing")
        storage.sweep(do=True)
        self.assertFalse(any(p.exists() for p in listed))
        self.assertTrue(sole.exists() and fresh.exists() and sample.exists() and ours.exists())


if __name__ == "__main__":
    unittest.main()
