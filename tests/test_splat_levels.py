"""Splat preview levels (app/sceneasset.py): lighter copies of a splat beside its full set, made after SHARP and
on demand for older splats and imported .ply files. Uses small synthetic .ply files; SHARP never runs."""
import os
import shutil
import stat
import struct
import sys
import tempfile
import time
import unittest
from pathlib import Path

import numpy as np

PROPS = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global config, db, main, sa, TestClient
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from fastapi.testclient import TestClient as TC
    from app import config as c, db as d, main as m, sceneasset as s
    config, db, main, sa, TestClient = c, d, m, s, TC


def write_ply(path: Path, n: int, seed=0, camera=False):
    """n random Gaussians in a 2 × 1 × 3 box; opacity and size grow with the index so the most visible are the last.
    camera: SHARP's intrinsic and image_size elements after them (a 1000 × 750 picture, fy 750)."""
    rng = np.random.default_rng(seed)
    d = np.zeros((n, len(PROPS)), "<f4")
    d[:, 0:3] = rng.random((n, 3)) * [2, 1, 3]
    d[:, 3:6] = rng.random((n, 3))
    t = np.linspace(0, 1, n)
    d[:, 6] = -3 + 6 * t                       # opacity (logit)
    d[:, 7:10] = (np.log(0.01) + t)[:, None]   # scales (log)
    d[:, 10] = 1
    head = ["ply", "format binary_little_endian 1.0", f"element vertex {n}", *[f"property float {k}" for k in PROPS]]
    if camera:
        head += ["element intrinsic 9", "property float intrinsic", "element image_size 2", "property uint image_size"]
    with path.open("wb") as f:
        f.write(("\n".join(head + ["end_header"]) + "\n").encode())
        f.write(d.tobytes())
        if camera:
            f.write(struct.pack("<9f", 750, 0, 500, 0, 750, 375, 0, 0, 1))
            f.write(struct.pack("<2I", 1000, 750))
    return d


def count(path: Path) -> int:
    props, data = sa._read_ply(path)
    return len(data)


class Levels(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix="splat-"))
        self.addCleanup(shutil.rmtree, self.d, True)
        self.old = sa.LEVELS
        sa.LEVELS = (("light", 100), ("medium", 200), ("dense", 400))   # (small numbers: the same code path)
        self.addCleanup(setattr, sa, "LEVELS", self.old)

    def test_levels_lighter_than_full_only(self):
        src = self.d / "a_full.ply"
        data = write_ply(src, 300)
        made = sa.make_levels(src, "a")
        self.assertEqual(made["n"], 300)
        self.assertEqual(sorted(made["levels"]), ["light", "medium"])   # dense (400) ≥ 300: not written
        self.assertEqual(count(self.d / "a_light.ply"), 100)
        self.assertEqual(count(self.d / "a_medium.ply"), 200)
        self.assertFalse((self.d / "a_dense.ply").exists())
        # the most visible were kept (the last ones here), in file order
        props, light = sa._read_ply(self.d / "a_light.ply")
        np.testing.assert_allclose(light[:, :3], data[200:, :3])
        # grown a little to close the gaps
        g = sa.grow_for(300, 100)
        self.assertTrue(1.0 < g <= 1.15)
        np.testing.assert_allclose(light[:, 7], data[200:, 7] + np.log(g), rtol=1e-5)
        self.assertEqual(sa.grow_for(300, 300), 1.0)
        self.assertEqual(sa.grow_for(10_000_000, 1), 1.15)
        # the box is the middle 99% of the full set
        x0, y0, z0, x1, y1, z1 = made["box"]
        self.assertTrue(0 <= x0 < 0.1 and 1.9 < x1 <= 2 and 2.8 < z1 <= 3, made["box"])

    def test_small_splat_gets_none_and_old_levels_go(self):
        src = self.d / "b.ply"
        write_ply(src, 50)
        (self.d / "b_light.ply").write_bytes(b"old")
        made = sa.make_levels(src, "b")
        self.assertEqual(made["levels"], {})
        self.assertFalse((self.d / "b_light.ply").exists())
        self.assertTrue(src.exists())

    def test_thin_splat_still_works(self):
        src = self.d / "c_full.ply"
        write_ply(src, 300, camera=True)
        sa.thin_splat(src, self.d / "c.ply", 120)
        self.assertEqual(count(self.d / "c.ply"), 120)
        self.assertEqual(sa._ply_lens(src)["height"], 750)

    def test_bad_files(self):
        p = self.d / "x.ply"
        p.write_bytes(b"ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n")
        with self.assertRaises(ValueError):
            sa._read_ply(p)
        p.write_bytes(b"ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nend_header\n")
        with self.assertRaises(ValueError):   # no Gaussians
            sa._read_ply(p)
        p.write_bytes(b"not a ply")
        with self.assertRaises(ValueError):
            sa._read_ply(p)

    def test_pick_level(self):
        lv = [{"k": "light"}, {"k": "medium"}, {"k": "full"}]
        self.assertEqual(sa.pick_level(lv, "light")["k"], "light")
        self.assertEqual(sa.pick_level(lv, "dense")["k"], "medium")
        self.assertEqual(sa.pick_level(lv, "full")["k"], "full")
        self.assertEqual(sa.pick_level([{"k": "medium"}, {"k": "full"}], "light")["k"], "medium")

    def test_finish_splat_keep_and_drop_full(self):
        for keep in (True, False):
            d = self.d / str(keep); d.mkdir()
            full = d / "pic_splat_full.ply"
            write_ply(full, 300, camera=True)
            r = sa.finish_splat(full, "Proj", "abcdef12", "dense", keep)
            self.assertEqual(r["lens"]["width"], 1000)
            self.assertEqual(r["n"], 300)
            ks = [v["k"] for v in r["levels"]]
            self.assertEqual(ks, ["light", "medium", "full"] if keep else ["light", "medium"])
            self.assertEqual(full.exists(), keep)
            self.assertEqual((r["level"], r["name"]), ("medium", "pic_splat_medium.ply"))   # dense asked; medium is the densest under it
            self.assertTrue(r["url"].endswith("/.deck/assets/abcdef12/pic_splat_medium.ply"))
            self.assertEqual(r["size"], (d / "pic_splat_medium.ply").stat().st_size)


class Endpoint(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.c = TestClient(main.app)
        cls.pid = db.create_project("Splat Levels")["id"]
        cls.folder = db.project_folder(cls.pid)

    def setUp(self):
        self.old = sa.LEVELS
        sa.LEVELS = (("light", 100), ("medium", 200), ("dense", 400))
        self.addCleanup(setattr, sa, "LEVELS", self.old)

    def upload(self, name, n):
        f = Path(tempfile.mkdtemp()) / name
        write_ply(f, n)
        r = self.c.post("/api/scene/asset", files={"file": (name, f.read_bytes())}, data={"project_id": str(self.pid)})
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def levels(self, url):
        return self.c.post("/api/scene/splat/levels", json={"url": url})

    def test_imported_ply_gets_levels(self):
        up = self.upload("My Splat.ply", 500)
        r = self.levels(up["url"])
        self.assertEqual(r.status_code, 200, r.text)
        j = r.json()
        self.assertEqual(j["n"], 500)
        self.assertEqual([v["k"] for v in j["levels"]], ["light", "medium", "dense", "full"])
        self.assertEqual(j["levels"][-1]["url"], up["url"])   # the file itself is the full set
        for v in j["levels"][:3]:
            got = self.c.get(v["url"])
            self.assertEqual(got.status_code, 200, v["url"])
            self.assertIn(f"element vertex {v['n']}".encode(), got.content[:400])
        # asked again from a level's URL: the same levels (made from the full file, not the level)
        again = self.levels(j["levels"][0]["url"]).json()
        self.assertEqual(again["levels"], j["levels"])

    def test_old_photo_splat_uses_its_full_set(self):
        # an older photo splat: <name>.ply (thinned) beside <name>_full.ply
        up = self.upload("pic_splat_full.ply", 300)
        d = Path(config.PROJECTS_DIR) / self.folder / ".deck" / "assets" / up["group"]
        sa.thin_splat(d / "pic_splat_full.ply", d / "pic_splat.ply", 250)
        url = up["url"].replace("pic_splat_full.ply", "pic_splat.ply")
        j = self.levels(url).json()
        self.assertEqual(j["n"], 300)
        self.assertEqual([v["k"] for v in j["levels"]], ["light", "medium", "full"])
        self.assertTrue(j["levels"][-1]["url"].endswith("pic_splat_full.ply"))
        self.assertTrue((d / "pic_splat_light.ply").is_file())

    def test_refusals(self):
        self.assertEqual(self.levels("/etc/passwd").status_code, 400)
        self.assertEqual(self.levels(f"/files/projects/{self.folder}/.deck/assets/abcdef12/none.ply").status_code, 404)
        self.assertEqual(self.levels(f"/files/projects/../.deck/assets/abcdef12/x.ply").status_code, 404)
        self.assertEqual(self.levels(f"/files/projects/{self.folder}/.deck/assets/abcdef12/..%2F..%2Fx.ply").status_code, 404)
        spz = self.c.post("/api/scene/asset", files={"file": ("a.spz", b"x")}, data={"project_id": str(self.pid)}).json()
        self.assertEqual(self.levels(spz["url"]).status_code, 400)
        bad = self.c.post("/api/scene/asset", files={"file": ("bad.ply", b"ply\nformat ascii 1.0\nend_header\n")},
                          data={"project_id": str(self.pid)}).json()
        self.assertEqual(self.levels(bad["url"]).status_code, 400)
        # a level whose full set is gone
        up = self.upload("gone_full.ply", 300)
        d = Path(config.PROJECTS_DIR) / self.folder / ".deck" / "assets" / up["group"]
        self.levels(up["url"])
        (d / "gone_full.ply").unlink()
        self.assertEqual(self.levels(up["url"].replace("gone_full", "gone_light")).status_code, 400)

    def test_photo_splat_with_a_stand_in_sharp(self):
        """The whole /api/scene/splat job, with a script standing in for SHARP (it copies a synthetic .ply out)."""
        from app import voice
        tmp = Path(tempfile.mkdtemp(prefix="fake-sharp-"))
        made = tmp / "made.ply"
        write_ply(made, 300, camera=True)
        fake = tmp / "sharp"
        fake.write_text(f"#!{sys.executable}\nimport shutil, sys\nout = sys.argv[sys.argv.index('-o') + 1]\n"
                        f"import os; os.makedirs(out, exist_ok=True); shutil.copy({str(made)!r}, out + '/x.ply')\n")
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        ckpt = tmp / "ck.pt"; ckpt.write_bytes(b"x")
        (Path(config.INPUT_DIR) / "splat-src.png").write_bytes(b"png")
        olds = (sa.SHARP, sa.SHARP_CKPT, voice._free_gpu)
        sa.SHARP, sa.SHARP_CKPT, voice._free_gpu = fake, ckpt, lambda: None
        try:
            r = self.c.post("/api/scene/splat", json={"image": "splat-src.png", "project_id": self.pid, "preview": "medium", "keep_full": True})
            self.assertEqual(r.status_code, 200, r.text)
            jid = r.json()["job"]
            for _ in range(200):
                j = self.c.get(f"/api/clip/job/{jid}").json()
                if j["state"] != "running":
                    break
                time.sleep(0.05)
            self.assertEqual(j["state"], "done", j)
            res = j["result"]
            self.assertEqual((res["level"], res["name"], res["n"]), ("medium", "splat-src_splat_medium.ply", 300))
            self.assertEqual([v["k"] for v in res["levels"]], ["light", "medium", "full"])
            self.assertEqual(res["lens"]["height"], 750)
            self.assertEqual(self.c.get(res["levels"][-1]["url"]).status_code, 200)
            self.assertEqual(self.c.post("/api/scene/splat", json={"image": "splat-src.png", "preview": "huge"}).status_code, 400)
        finally:
            sa.SHARP, sa.SHARP_CKPT, voice._free_gpu = olds
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
