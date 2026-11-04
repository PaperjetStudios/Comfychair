"""Where files go and that they go away (app/storage.py): ComfyUI keeps nothing of a run once ComfyChair has its
copy, deleting a run, a picture or a project removes every copy and cache, and the sweep finds old leftovers but
never a sole copy. Run: .venv/bin/python -m unittest discover tests"""
import asyncio
import json
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


def png_bytes() -> bytes:
    from io import BytesIO
    from PIL import Image
    b = BytesIO()
    Image.new("RGB", (4, 4), (10, 20, 30)).save(b, "PNG")
    return b.getvalue()


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

    def test_a_camera_solve_leaves_nothing(self):
        # app/solve.py: its first frame goes from ComfyUI's input once read, its JSON answer (read, kept nowhere) and
        # the run's folder from the output; a frame left by a crash is swept
        answer = touch(self.out / config.COMFY_INPUT_SUBFOLDER / "solve" / "run-s1" / "moge_00001_.json")
        storage.drop_comfy_read([{"filename": answer.name, "subfolder": f"{config.COMFY_INPUT_SUBFOLDER}/solve/run-s1", "type": "output"}])
        self.assertFalse(answer.exists() or answer.parent.exists())
        frame = touch(self.inp / config.COMFY_INPUT_SUBFOLDER / "solve_0123456789ab.png")
        self.assertEqual(storage.comfy_input(f"{config.COMFY_INPUT_SUBFOLDER}/{frame.name}"), frame)
        self.assertIsNone(storage.comfy_input("../outside.png"))
        picture = touch(self.inp / config.COMFY_INPUT_SUBFOLDER / "holiday.png")
        listed = {Path(i["path"]) for i in storage.sweep()["items"]}
        self.assertIn(frame, listed)
        self.assertNotIn(picture, listed, "a picture's copy isn't the solve's")

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

    def test_rig_copy_of_a_model_file_has_a_name_the_sweep_knows(self):
        src = touch(config.PROJECTS_DIR / self.folder / "imports" / "abc" / "thing one.glb")
        r = TestClient(main.app).post("/api/scene/mesh", json={"url": f"/files/projects/{self.folder}/imports/abc/thing%20one.glb"})
        self.assertEqual(r.status_code, 200, r.text)
        name = r.json()["name"]
        self.assertTrue(storage.RIG_COPY.match(name), name)
        self.assertTrue((self.inp / "3d" / name).is_file())
        bad = TestClient(main.app).post("/api/scene/mesh", json={"url": f"/files/projects/{self.folder}/../../etc/passwd"})
        self.assertGreaterEqual(bad.status_code, 400)

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

    def test_deleting_a_run_takes_its_view_marks(self):
        gid, ours, theirs, twins = self.gen()
        folder = main.db.project_folder(main.db.get_generation(gid)["project_id"])
        marks = touch(config.PROJECTS_DIR / folder / ".deck" / "view-marks" / f"g{gid}.json")
        other = touch(config.PROJECTS_DIR / folder / ".deck" / "view-marks" / f"g{gid + 1}.json")
        with TestClient(main.app) as c:
            self.assertEqual(c.delete(f"/api/generations/{gid}").status_code, 200)
        self.assertFalse(marks.exists())
        self.assertTrue(other.exists())
        other.unlink()

    def test_deleting_a_run_takes_its_extend_frame_canvas(self):
        gid, ours, theirs, twins = self.gen()
        t = storage.tag(ours.resolve())
        canvas = [touch(config.VIDEOPREP_DIR / f"{t}-canvas_{'a' * 20}_{k}.mp4") for k in "vm"]
        other = touch(config.VIDEOPREP_DIR / f"{storage.tag('another clip')}-canvas_{'b' * 20}_v.mp4")
        with TestClient(main.app) as c:
            self.assertEqual(c.delete(f"/api/generations/{gid}").status_code, 200)
        self.assertFalse(any(p.exists() for p in canvas))
        self.assertTrue(other.exists(), "another clip's canvas stays")
        storage.prune_canvas()   # a month unused: gone too
        self.assertTrue(other.exists(), "an hour old stays")
        t0 = time.time() - 40 * 86400
        os.utime(other, (t0, t0))
        storage.prune_canvas()
        self.assertFalse(other.exists())

    def test_3d_assets_go_with_their_project(self):
        d = storage.asset_dir(self.folder, "0123abcd")
        self.assertTrue(d.is_relative_to(config.PROJECTS_DIR / self.folder))
        files = [touch(d / "bunny_quads.glb"), touch(storage.asset_dir(self.folder, "4567ef01") / "photo_splat_full.ply")]
        name = db.get_project(self.pid)["name"]
        with TestClient(main.app) as c:
            self.assertEqual(c.delete(f"/api/projects/{self.pid}", params={"confirm": name}).status_code, 200)
        self.assertFalse(any(p.exists() for p in files))

    def test_deleting_a_clip_takes_its_playable_copy(self):
        copy = touch(config.PLAYABLE_DIR / f"{storage.tag('abcd1234_clip.mov')}-play.mp4")
        other = touch(config.PLAYABLE_DIR / f"{storage.tag('other.mov')}-play.mp4")
        self.addCleanup(other.unlink, missing_ok=True)
        storage.drop_caches("abcd1234_clip.mov")
        self.assertFalse(copy.exists())
        self.assertTrue(other.exists())

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

    def _saved(self, c):
        self._uploads()
        r = c.post("/api/upload", data={"project_id": self.pid, "source": "editor", "board": "A layer", "multiple": 1},
                   files={"file": ("a.png", png_bytes(), "image/png")}).json()
        gid = db.input_origin(r["name"])["generation"]
        g = db.get_generation(gid)
        self.assertEqual((g["template"], g["params"]["label"], g["status"]), ("saved", "A layer", "done"))
        return r["name"], gid, config.PROJECTS_DIR / g["outputs"][0]["path"], config.INPUT_DIR / Path(r["name"]).name

    def _uploads(self):   # (ComfyUI's copy: named as main.upload_prepared would have it)
        p = mock.patch.object(main.comfy, "upload_image", mock.AsyncMock(side_effect=lambda png, fname, sub: f"{sub}/{fname}"))
        p.start()
        self.addCleanup(p.stop)

    def test_a_resampled_picture_is_an_input_that_goes_with_its_project(self):
        self._uploads()
        with TestClient(main.app) as c:
            big = c.post("/api/upload", data={"project_id": self.pid, "multiple": 1}, files={"file": ("a.png", png_bytes(), "image/png")}).json()
            w, h = big["width"], big["height"]
            mp = (w * h) / 4 / 1_000_000
            r = c.post("/api/inputs/resize", json={"name": big["name"], "mp": mp, "project_id": self.pid}).json()
            self.assertNotEqual(r["name"], big["name"])
            self.assertIs(big["existed"], False)
            self.assertIs(r["existed"], False)
            self.assertLessEqual(r["width"] * r["height"], w * h / 4)
            self.assertIn(r["name"], [x["name"] for x in db.project_inputs(self.pid)])
            again = c.post("/api/inputs/resize", json={"name": big["name"], "mp": mp, "project_id": self.pid}).json()
            self.assertEqual(again["name"], r["name"])   # (one file, however often it is picked)
            self.assertIs(again["existed"], True)   # (so a caller must not delete it as its own fresh copy)
            again2 = c.post("/api/upload", data={"project_id": self.pid, "multiple": 1}, files={"file": ("a.png", png_bytes(), "image/png")}).json()
            self.assertIs(again2["existed"], False)   # (uploads are uuid-named: never shared)
            self.assertNotEqual(again2["name"], big["name"])
            fits = c.post("/api/inputs/resize", json={"name": big["name"], "mp": 100, "project_id": self.pid}).json()
            self.assertEqual(fits["name"], big["name"])
            self.assertIs(fits["existed"], True)
            copy = config.INPUT_DIR / Path(r["name"]).name
            self.assertTrue(copy.is_file())
            self.assertEqual(c.delete("/api/inputs", params={"name": r["name"]}).status_code, 200)
        self.assertFalse(copy.exists())

    def test_an_input_without_board_makes_no_run(self):
        self._uploads()
        with TestClient(main.app) as c:
            r = c.post("/api/upload", data={"project_id": self.pid, "multiple": 1}, files={"file": ("a.png", png_bytes(), "image/png")}).json()
        self.assertIsNone(db.input_origin(r["name"]))

    def test_deleting_a_saved_pictures_run_takes_the_input(self):
        with TestClient(main.app) as c:
            name, gid, run_file, input_file = self._saved(c)
            self.assertTrue(run_file.is_file() and input_file.is_file())
            self.assertEqual(c.delete(f"/api/generations/{gid}").status_code, 200)
        self.assertFalse(run_file.exists() or input_file.exists())
        self.assertNotIn(name, [r["name"] for r in db.project_inputs(self.pid)])

    def test_deleting_a_saved_picture_takes_its_run(self):
        with TestClient(main.app) as c:
            name, gid, run_file, input_file = self._saved(c)
            self.assertEqual(c.delete("/api/inputs", params={"name": name}).status_code, 200)
        self.assertFalse(run_file.exists() or input_file.exists())
        self.assertIsNone(db.get_generation(gid))

    def test_a_copy_made_from_a_saved_pictures_run_leaves_the_run(self):
        with TestClient(main.app) as c:
            _, gid, run_file, _ = self._saved(c)
            copy = c.post(f"/api/generations/{gid}/to-input", json={"index": 0, "mp": 0, "multiple": 1}).json()["name"]
            self.assertEqual(c.delete("/api/inputs", params={"name": copy}).status_code, 200)
        self.assertTrue(run_file.is_file())
        self.assertIsNotNone(db.get_generation(gid))

    def test_a_saved_picture_in_a_document_cant_go(self):
        with TestClient(main.app) as c:
            name, gid, run_file, input_file = self._saved(c)
            doc = config.PROJECTS_DIR / self.folder / ".deck" / "edit-tabs" / "t.json"
            doc.parent.mkdir(parents=True, exist_ok=True)
            doc.write_text(json.dumps({"id": "t", "name": "Edit", "payload": {"layers": [{"name": name}]}}))
            self.assertEqual(c.delete(f"/api/generations/{gid}").status_code, 409)
            doc.unlink()
        self.assertTrue(run_file.is_file() and input_file.is_file())

    def test_a_saved_picture_another_run_used_stays_as_an_input(self):
        with TestClient(main.app) as c:
            name, gid, run_file, input_file = self._saved(c)
            other = db.create_generation(self.pid, "x", {"pic": name}, {}, "edit-x")
            self.assertEqual(c.delete(f"/api/generations/{gid}").status_code, 200)
            self.assertFalse(run_file.exists())
            self.assertTrue(input_file.is_file())
            self.assertIsNone(db.input_origin(name))
            db.delete_generation(other)

    def test_a_run_that_found_nothing_says_so(self):
        self.assertIn("found nothing", main.run_error({"node_type": "SAM3Propagate", "exception_message": "cannot mmap an empty file"}))
        self.assertEqual(main.run_error({"node_type": "KSampler", "exception_message": "out of memory"}), "KSampler: out of memory")

    def test_a_project_takes_its_saved_pictures(self):
        with TestClient(main.app) as c:
            _, _, run_file, input_file = self._saved(c)
            name = db.get_project(self.pid)["name"]
            self.assertEqual(c.delete(f"/api/projects/{self.pid}", params={"confirm": name}).status_code, 200)
        self.assertFalse(run_file.exists() or input_file.exists())

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

    # ---- what's attached: the Board's protection ----
    def doc(self, kind, payload, name="Mara", did="c1", folder=None):
        f = config.PROJECTS_DIR / (folder or self.folder) / ".deck" / kind / f"{did}.json"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"id": did, "kind": kind, "name": name, "order": 0, "rev": 1, "updated": 0, "payload": payload}))
        return f

    def test_attachments_see_a_run_used_as_a_splat_frame(self):
        """An animated splat's later frames sit in objects[].frames[]: their runs can't be deleted either."""
        a, _, _, _ = self.gen(run="r1")
        b, _, _, _ = self.gen(run="r2")
        self.doc("scene-tabs", {"objects": [{"type": "splat", "gen": a, "frames": [{"url": "/x.ply", "gen": b, "genIndex": 0}]}]})
        got = storage.attachments()
        self.assertIn(a, got)
        self.assertIn(b, got)

    def test_attachments_see_each_kind_of_reference(self):
        a, _, _, _ = self.gen(run="r1")
        b, _, _, _ = self.gen(run="r2")
        c, _, _, _ = self.gen(run="r3")
        d, _, _, _ = self.gen(run="r4")
        pic = f"{config.COMFY_INPUT_SUBFOLDER}/made{time.time_ns()}.png"
        db.set_input_origin(pic, {"generation": c, "index": 0, "frame": None})
        self.doc("characters", {"media": [{"src": {"generation": a, "index": 0}}], "cands": [{"id": "x", "gen": b, "index": 0}], "pics": [pic],
                                "vpending": [{"gen": d, "view": "front"}]})
        got = storage.attachments()
        for gid in (a, b, c):
            self.assertEqual(got[gid][0]["name"], "Mara")
            self.assertEqual(got[gid][0]["label"], "Character")
        self.assertNotIn(d, got, "a run still on its way isn't a use")

    def test_a_table_scans_cleanly_and_reports_an_explicit_run(self):
        a, _, _, _ = self.gen(run="r1")
        frames = [{"id": "f1", "kind": "image", "doc": "e1", "x": 0, "y": 0, "w": 1024, "h": 1024, "label": "A"},
                  {"id": "f2", "kind": "note", "x": 0, "y": 0, "w": 10, "h": 10, "text": "hi"},
                  {"id": "f3", "kind": "image", "doc": "s1", "x": 0, "y": 0, "w": 10, "h": 10, "story": {"scene": "sc", "shot": "sh"}}]
        self.doc("tables", {"v": 1, "view": {"x": 0, "y": 0, "z": 1}, "grid": {"on": True, "size": 64}, "frames": frames, "story": "st1"}, name="T", did="t0")
        self.assertNotIn(a, storage.attachments())
        self.doc("tables", {"v": 1, "frames": frames, "extra": {"generation": a}}, name="T2", did="t1")
        got = storage.attachments()
        self.assertEqual(got[a][0]["label"], "Table")
        self.assertEqual(got[a][0]["name"], "T2")

    def test_a_parent_or_a_trashed_owner_is_no_attachment(self):
        a, _, _, _ = self.gen(run="r1")
        self.doc("gen-tabs", {"parent": {"generation": a, "index": 0}}, did="t1")
        f = self.doc("characters", {"media": [{"src": {"generation": a}}]}, did="c2")
        trash = f.parent / ".trash"
        trash.mkdir()
        f.rename(trash / "c2.123.json")
        self.assertNotIn(a, storage.attachments())

    def test_an_attached_run_is_refused_until_it_is_detached(self):
        gid, ours, _, _ = self.gen()
        f = self.doc("characters", {"media": [{"src": {"generation": gid, "index": 0}}]})
        with TestClient(main.app) as c:
            r = c.delete(f"/api/generations/{gid}")
            self.assertEqual(r.status_code, 409)
            self.assertIn("Mara", r.json()["detail"]["message"])
            self.assertEqual(r.json()["detail"]["used_by"][0]["kind"], "characters")
            self.assertTrue(ours.exists() and db.get_generation(gid))
            f.unlink()
            self.assertEqual(c.delete(f"/api/generations/{gid}").status_code, 200)
        self.assertFalse(ours.exists() or db.get_generation(gid))

    def test_delete_all_takes_only_what_nothing_uses(self):
        kept, kept_file, _, _ = self.gen(run="r1")
        free, free_file, _, _ = self.gen(run="r2")
        self.doc("video-tabs", {"items": [{"src": {"generation": kept, "index": 0}}]}, name="Cut", did="v1")
        with TestClient(main.app) as c:
            attached = c.get("/api/generations/attached").json()
            self.assertEqual(attached[str(kept)][0]["label"], "Video")
            r = c.post("/api/generations/delete", json={"ids": [kept, free, 99999999]}).json()
        self.assertEqual(r["deleted"], [free])
        self.assertEqual([x["id"] for x in r["kept"]], [kept])
        self.assertTrue(kept_file.exists())
        self.assertFalse(free_file.exists())

    def test_a_character_holds_its_pictures(self):
        name = f"{config.COMFY_INPUT_SUBFOLDER}/face{time.time_ns()}.png"
        touch(config.INPUT_DIR / Path(name).name)
        db.add_input(name, self.pid)
        other = db.create_project(f"Other {time.time_ns()}")
        f = self.doc("characters", {"looks": [{"views": {"front": name}}]}, folder=other["folder"] if "folder" in other else db.project_folder(other["id"]))
        self.assertTrue(storage.input_used(name), "a character in another project uses it")
        with TestClient(main.app) as c:
            r = c.delete("/api/inputs", params={"name": name})
            self.assertEqual(r.status_code, 409)
            self.assertIn("Mara", r.json()["detail"])
            self.assertTrue((config.INPUT_DIR / Path(name).name).exists())
            pname = db.get_project(self.pid)["name"]
            self.assertEqual(c.delete(f"/api/projects/{self.pid}", params={"confirm": pname}).status_code, 200)
            self.assertTrue((config.INPUT_DIR / Path(name).name).exists(), "deleting the project that owned it spares it")
            f.unlink()
            self.assertEqual(c.delete("/api/inputs", params={"name": name}).status_code, 200)
        self.assertFalse((config.INPUT_DIR / Path(name).name).exists())

    def test_a_character_leaving_the_trash_takes_only_its_own_pictures(self):
        mine, shared = (f"{config.COMFY_INPUT_SUBFOLDER}/{n}{time.time_ns()}.png" for n in ("mine", "shared"))
        for n in (mine, shared):
            touch(config.INPUT_DIR / Path(n).name)
            db.add_input(n, self.pid)
        self.doc("story-tabs", {"frames": [{"input": shared}]}, did="s1")
        f = self.doc("characters", {"pics": [mine, shared]}, did="c9")
        with TestClient(main.app) as c:
            q = {"project_id": self.pid}
            self.assertEqual(c.delete("/api/store/characters/c9", params=q).status_code, 200)
            self.assertTrue((config.INPUT_DIR / Path(mine).name).exists(), "still in the trash: Undo can bring it back")
            old = next((f.parent / ".trash").glob("c9.*.json"))
            old.rename(old.with_name(f"c9.{time.time_ns() - 40 * 86400 * 10**9}.json"))
            self.doc("characters", {}, did="c10")
            self.assertEqual(c.delete("/api/store/characters/c10", params=q).status_code, 200)   # the next delete clears old trash
        self.assertFalse((config.INPUT_DIR / Path(mine).name).exists())
        self.assertTrue((config.INPUT_DIR / Path(shared).name).exists())

    def test_a_voice_a_character_uses_is_refused(self):
        from app import voice
        vid = "abc123def456"
        voice.VOICES.mkdir(parents=True, exist_ok=True)
        (voice.VOICES / f"{vid}.json").write_text(json.dumps({"id": vid, "name": "V"}))
        (voice.VOICES / f"{vid}.wav").write_bytes(b"x")
        f = self.doc("characters", {"voice": vid})
        with TestClient(main.app) as c:
            r = c.delete(f"/api/voice/voices/{vid}")
            self.assertEqual(r.status_code, 409)
            self.assertIn("Mara", r.json()["detail"])
            f.unlink()
            self.assertEqual(c.delete(f"/api/voice/voices/{vid}").status_code, 200)
        self.assertFalse((voice.VOICES / f"{vid}.wav").exists())

    def test_a_character_brought_in_shares_nothing_with_the_original(self):
        gid, ours, _, _ = self.gen()
        name = f"{config.COMFY_INPUT_SUBFOLDER}/face{time.time_ns()}.png"
        pic = touch(config.INPUT_DIR / Path(name).name)
        db.add_input(name, self.pid)
        self.doc("characters", {"looks": [{"id": "main", "name": "Main", "views": {"front": name}, "model": "m1"}], "voice": "v",
                                "media": [{"id": "m1", "kind": "mesh", "src": {"generation": gid, "index": 0}, "role": "model"}],
                                "cands": [{"id": "x", "gen": gid, "index": 0}], "vpending": [{"gen": 5}]}, did="c1")
        other = db.create_project(f"Other {time.time_ns()}")["id"]
        with TestClient(main.app) as c:
            d = c.post(f"/api/projects/{other}/characters/copy", json={"from_project": self.pid, "id": "c1"})
            self.assertEqual(d.status_code, 200, d.text)
            d = d.json()
            p = d["payload"]
            new_pic = p["looks"][0]["views"]["front"]
            new_gen = p["media"][0]["src"]["generation"]
            self.assertNotEqual(new_pic, name)
            self.assertNotEqual(new_gen, gid)
            self.assertEqual(p["cands"], [])
            self.assertEqual(p["vpending"], [])
            self.assertEqual(p["voice"], "v")
            copied_output = config.PROJECTS_DIR / db.get_generation(new_gen)["outputs"][0]["path"]
            self.assertTrue(copied_output.exists())
            self.assertEqual(db.get_generation(new_gen)["project_id"], other)
            pname = db.get_project(self.pid)["name"]
            self.assertEqual(c.delete(f"/api/projects/{self.pid}", params={"confirm": pname}).status_code, 200)
            self.assertFalse(ours.exists() or pic.exists(), "the original's files went with its project")
            self.assertTrue(copied_output.exists() and (config.INPUT_DIR / Path(new_pic).name).exists(), "the copy is whole")
            self.assertEqual(c.delete(f"/api/generations/{new_gen}").status_code, 409)

    def test_a_duplicate_project_remaps_gen_references(self):
        from app import projects
        fix = projects._relinker("A", "B", {7: 70})
        self.assertEqual(fix({"cands": [{"gen": 7, "index": 0}], "src": {"generation": 7}, "gen": 8}),
                         {"cands": [{"gen": 70, "index": 0}], "src": {"generation": 70}, "gen": 8})

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

    # ---- Clean up this project ----
    def free_picture(self, name=None, old=True):
        name = name or f"{time.time_ns()}.png"
        full = f"{config.COMFY_INPUT_SUBFOLDER}/{name}"
        touch(config.INPUT_DIR / name, old=old)
        db.add_input(full, self.pid)
        return full

    def unused(self):
        return {i["id"]: i for i in storage.project_unused(self.pid)["items"]}

    def put_doc(self, payload, kind="edit-tabs", trashed=False, stem=None):
        d = config.PROJECTS_DIR / self.folder / ".deck" / kind
        d = d / ".trash" if trashed else d
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{stem or time.time_ns()}.json").write_text(json.dumps({"id": "d", "name": "D", "payload": payload}))

    def test_unused_lists_only_what_nothing_holds_and_lists_without_deleting(self):
        free, in_doc, by_url, in_trash, fresh = self.free_picture(), self.free_picture(), self.free_picture(), self.free_picture(), self.free_picture(old=False)
        self.put_doc({"layers": [{"name": in_doc}], "src": "/api/input?name=" + by_url.replace("/", "%2F")})
        self.put_doc({"name": in_trash}, trashed=True)
        got = self.unused()
        self.assertEqual(got[f"input:{free}"]["tier"], "free")
        for held in (in_doc, by_url, in_trash, fresh):
            self.assertNotIn(f"input:{held}", got)
        self.assertTrue(storage.input_files(free)[0].is_file(), "listing deletes nothing")

    def test_unused_sees_another_projects_document_and_a_character(self):
        a, b = self.free_picture(), self.free_picture()
        other = db.project_folder(db.create_project(f"Other {time.time_ns()}")["id"])
        d = config.PROJECTS_DIR / other / ".deck" / "scene-tabs"
        d.mkdir(parents=True)
        (d / "x.json").write_text(json.dumps({"payload": {"p": a}}))
        self.put_doc({"look": b}, kind="characters")
        got = self.unused()
        self.assertNotIn(f"input:{a}", got)
        self.assertNotIn(f"input:{b}", got)

    def test_unused_runs_tier_and_a_run_on_its_way_holds(self):
        old, sized, waiting = self.free_picture(), self.free_picture(), self.free_picture()
        gid = db.create_generation(self.pid, "x", {"image": old}, {"1": {"inputs": {"image": sized}}}, f"p-{time.time_ns()}")
        db.update_generation(gid, status="done")
        db.create_generation(self.pid, "x", {"image": waiting}, {}, f"p-{time.time_ns()}")
        got = self.unused()
        self.assertEqual(got[f"input:{old}"]["tier"], "runs")
        self.assertEqual(got[f"input:{sized}"]["tier"], "runs", "named only by the workflow")
        self.assertNotIn(f"input:{waiting}", got)

    def test_unused_keeps_a_picture_saved_to_the_board(self):
        name = self.free_picture()
        gid = db.create_generation(self.pid, "saved", {}, {}, f"p-{time.time_ns()}")
        db.set_input_origin(name, {"generation": gid, "index": 0, "frame": None, "saved": True})
        self.assertNotIn(f"input:{name}", self.unused())

    def test_unused_assets_and_stray_files_go_with_their_caches(self):
        root = config.PROJECTS_DIR / self.folder
        free = touch(root / ".deck" / "assets" / "aaaa1111" / "m.glb")
        kept = touch(root / ".deck" / "assets" / "bbbb2222" / "s.ply")
        self.put_doc({"url": f"/files/projects/{self.folder}/.deck/assets/bbbb2222/s.ply"}, kind="scene-tabs")
        gid, ours, _, _ = self.gen()
        stray, nested = touch(root / "stray.png"), touch(root / "sheets" / "only-in-this-folder.png")
        cache = touch(config.THUMB_DIR / f"{storage.tag(stray.resolve())}-96.jpg")
        got = self.unused()
        self.assertTrue({"asset:aaaa1111", "file:stray.png", "file:sheets/only-in-this-folder.png"} <= set(got))
        self.assertNotIn("asset:bbbb2222", got)
        self.assertFalse([k for k in got if k.endswith(ours.name)], "a run's output is no stray")
        self.assertFalse([k for k in got if ".deck" in k])
        r = storage.drop_unused(self.pid, ["asset:aaaa1111", "file:stray.png", "file:sheets/only-in-this-folder.png"])
        self.assertEqual(r["count"], 3)
        self.assertFalse(free.parent.exists() or stray.exists() or cache.exists() or nested.parent.exists())
        self.assertTrue(kept.exists() and ours.exists())

    def test_unused_leaves_imports_while_an_outside_job_has_the_card(self):
        touch(config.PROJECTS_DIR / self.folder / ".deck" / "assets" / "cccc3333" / "m.glb")
        with mock.patch("app.gpu.state", return_value=({"label": "splat"}, [])):
            self.assertNotIn("asset:cccc3333", self.unused())

    def test_drop_unused_takes_only_what_was_picked_and_is_still_unused(self):
        a, b, late = self.free_picture(), self.free_picture(), self.free_picture()
        copy = touch(self.inp / a)
        self.put_doc({"name": late})
        r = storage.drop_unused(self.pid, [f"input:{a}", f"input:{late}", "file:../../secret", "asset:nope"])
        self.assertEqual((r["count"], r["pictures"]), (1, [a]))
        self.assertFalse(copy.exists() or storage.input_files(a)[0].exists())
        self.assertEqual(db.input_origin(a), None)
        self.assertTrue(storage.input_files(b)[0].exists() and storage.input_files(late)[0].exists())

    def test_a_pictures_crops_go_with_it(self):
        name, other = self.free_picture(), self.free_picture()
        sub = self.inp / config.COMFY_INPUT_SUBFOLDER
        mine, theirs = touch(sub / storage.crop_name(name, "aaaa")), touch(sub / storage.crop_name(other, "aaaa"))
        storage.delete_input(name)
        self.assertFalse(mine.exists(), "a crop cut from the picture goes with it")
        self.assertTrue(theirs.exists(), "another picture's crop stays")

    def test_unused_routes(self):
        name = self.free_picture()
        with TestClient(main.app) as c:
            self.assertEqual(c.get("/api/storage/unused", params={"project_id": 99999999}).status_code, 404)
            listed = c.get("/api/storage/unused", params={"project_id": self.pid}).json()
            self.assertIn(f"input:{name}", [i["id"] for i in listed["items"]])
            self.assertEqual(c.post("/api/storage/unused", json={"project_id": self.pid, "ids": [f"input:{name}"]}).json()["count"], 1)
        self.assertFalse(storage.input_files(name)[0].exists())

    def test_sweep_takes_playable_copies_of_gone_media_only(self):
        keep_media = touch(config.MEDIA_DIR / "aaaa1111_keep.mov")
        keep = touch(config.PLAYABLE_DIR / f"{storage.tag(keep_media.name)}-play.mp4")
        orphan = touch(config.PLAYABLE_DIR / f"{storage.tag('bbbb2222_gone.mov')}-play.mp4")
        listed = {Path(i["path"]) for i in storage.sweep()["items"]}
        self.assertIn(orphan, listed)
        self.assertNotIn(keep, listed)
        storage.sweep(do=True)
        self.assertFalse(orphan.exists())
        self.assertTrue(keep.exists() and keep_media.exists())

    def test_media_in_use_is_refused(self):
        f = touch(config.MEDIA_DIR / "cccc3333_clip.mp4")
        with TestClient(main.app) as c:
            self.assertIsNone(storage.media_used(f.name))
            tabs = config.PROJECTS_DIR / "Proj" / ".deck" / "video-tabs"
            tabs.mkdir(parents=True)
            (tabs / "1.json").write_text('{"items":[{"src":{"media":"%s"}}]}' % f.name)
            self.assertEqual(storage.media_used(f.name), "Proj")
            r = c.delete("/api/media", params={"name": f.name})
            self.assertEqual(r.status_code, 409)
            self.assertIn("Proj", r.json()["detail"])
            self.assertTrue(f.exists())
            (tabs / "1.json").unlink()
            self.assertEqual(c.delete("/api/media", params={"name": f.name}).status_code, 200)
            self.assertFalse(f.exists())


if __name__ == "__main__":
    unittest.main()
