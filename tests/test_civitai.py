"""Civitai LoRA browser: family -> base models, file names, the key (never returned or logged) and a download into a
temp LoRA folder. Civitai itself is never called: httpx goes through a MockTransport.
Run: .venv/bin/python -m unittest tests.test_civitai"""
import json
import logging
import os
import shutil
import stat
import struct
import tempfile
import time
import unittest
from pathlib import Path

import httpx

cv = None
client = None
LORAS = None
KEY = "abcdef0123456789abcdef0123456789"


def setUpModule():   # imported late, after DECK_DATA points at a temp folder (never the real data/)
    global cv, client, LORAS
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    LORAS = Path(tempfile.mkdtemp(prefix="deck-loras-"))
    os.environ["DECK_LORA_DIR"] = str(LORAS)
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app import civitai
    cv = civitai
    cv.SECRETS = Path(tempfile.mkdtemp(prefix="deck-secrets-")) / "secrets.json"
    app = FastAPI()
    app.include_router(cv.router)
    client = TestClient(app)


def tearDownModule():
    os.environ.pop("DECK_LORA_DIR", None)
    cv.TRANSPORT = None


def safetensors_bytes(n=4096) -> bytes:
    head = b'{"__metadata__":{}}'
    return struct.pack("<Q", len(head)) + head + b"\0" * (n - 8 - len(head))


class FakeCivitai:
    """Answers like civitai.com: /me needs the key, /model-versions/{id}, /models, the download (a redirect to a CDN)."""

    def __init__(self, body=None, need_key=False, early=False, name="My LoRA v1.safetensors"):
        self.body = body if body is not None else safetensors_bytes()
        self.need_key, self.early, self.name = need_key, early, name
        self.seen = []

    def version(self):
        return {"id": 77, "modelId": 5, "name": "v1", "baseModel": "Krea 2", "trainedWords": ["sks style"],
                "availability": "EarlyAccess" if self.early else "Public", "model": {"name": "Test LoRA"},
                "files": [{"id": 9, "name": self.name, "sizeKB": len(self.body) / 1024, "type": "Model", "primary": True,
                           "downloadUrl": "https://civitai.com/api/download/models/77", "hashes": {}}],
                "images": [{"url": "https://image.civitai.com/abc/uuid-1/original=true/1.jpeg", "type": "image", "nsfwLevel": 1}]}

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.seen.append(req)
        auth = req.headers.get("authorization")
        path = req.url.path
        if path == "/api/v1/me":
            return httpx.Response(200, json={"username": "kbuser"}) if auth == f"Bearer {KEY}" else httpx.Response(401, json={"error": "Unauthorized"})
        if path == "/api/v1/model-versions/77":
            return httpx.Response(200, json=self.version())
        if path == "/api/v1/models":
            return httpx.Response(200, json={"items": [{"id": 5, "name": "Test LoRA", "type": "LORA", "creator": {"username": "maker"},
                                                        "stats": {"downloadCount": 10}, "modelVersions": [self.version(),
                                                        {**self.version(), "id": 78, "baseModel": "SDXL 1.0"}]}],
                                              "metadata": {"nextCursor": "24"}})
        if path == "/api/download/models/77":
            if (self.need_key or self.early) and not auth:
                return httpx.Response(401, json={"error": "Unauthorized"})
            if self.early:
                return httpx.Response(403, json={"error": "early access"})
            return httpx.Response(307, headers={"location": "https://cdn.example.com/file?sig=1"})
        if req.url.host == "cdn.example.com":
            return httpx.Response(200, content=self.body, headers={"content-type": "application/octet-stream",
                                                                   "content-length": str(len(self.body))})
        return httpx.Response(404)


def wait(jid):
    for _ in range(200):
        s = cv.clipimport.JOBS[jid]
        if s["state"] != "running":
            return s
        time.sleep(0.02)
    raise AssertionError("job never ended")


class Families(unittest.TestCase):
    def test_known_families(self):
        self.assertEqual(cv.bases_for("krea")[0], ["Krea 2"])
        self.assertEqual(cv.bases_for("h3")[0], ["MiniMax H3"])
        self.assertEqual(cv.bases_for("moss")[0], ["MOSS Image"])
        self.assertIn("Flux.2 Klein 9B", cv.bases_for("klein")[0])
        self.assertEqual(cv.bases_for("qwen")[0], ["Qwen 2.1"])
        self.assertEqual(cv.bases_for("ltx2.5")[0], ["LTXV 2.5", "LTXV 2.3"])
        self.assertEqual(cv.bases_for("ltx2.3")[0], ["LTXV 2.3"])

    def test_prefix_and_unknown(self):
        self.assertEqual(cv.bases_for("LTX2.4")[0], cv.bases_for("ltx")[0])
        self.assertEqual(cv.bases_for("ace"), ([], []))

    def test_search_maps_family_and_filters_versions(self):
        fake = FakeCivitai()
        cv.TRANSPORT = httpx.MockTransport(fake)
        cv._cache.clear()
        r = client.get("/api/civitai/search", params={"family": "krea", "sort": "newest", "nsfw": "off"}).json()
        q = fake.seen[-1].url.params
        self.assertEqual(q.get_list("baseModels"), ["Krea 2"])
        self.assertEqual((q["sort"], q["nsfw"], q["types"]), ("Newest", "false", "LORA"))
        self.assertEqual([v["id"] for v in r["items"][0]["versions"]], [77])
        self.assertEqual(r["items"][0]["otherVersions"], 1)
        self.assertEqual(r["next"], "24")
        self.assertIn("/width=450/", r["items"][0]["versions"][0]["images"][0]["thumb"])

    def test_unknown_family_searches_its_name(self):
        fake = FakeCivitai()
        cv.TRANSPORT = httpx.MockTransport(fake)
        cv._cache.clear()
        client.get("/api/civitai/search", params={"family": "ace"})
        q = fake.seen[-1].url.params
        self.assertEqual((q.get_list("baseModels"), q["query"]), ([], "ace"))


class Filenames(unittest.TestCase):
    def test_sanitise(self):
        self.assertEqual(cv.safe_filename("../../etc/passwd"), "passwd.safetensors")
        self.assertEqual(cv.safe_filename("a\\b\\My LoRA: v2?.SafeTensors"), "My LoRA_ v2_.safetensors")
        self.assertEqual(cv.safe_filename("...safetensors"), "lora.safetensors")
        self.assertTrue(cv.safe_filename("x" * 400).endswith(".safetensors"))
        self.assertLessEqual(len(cv.safe_filename("x" * 400)), 170)

    def test_family_must_be_a_plain_folder(self):
        from fastapi import HTTPException
        for bad in ("", "../x", "a/b", ".hidden"):
            with self.assertRaises(HTTPException):
                cv.family_dir(bad)
        self.assertEqual(cv.family_dir("ltx2.5"), LORAS.resolve() / "ltx2.5")

    def test_media_url(self):
        u = "https://image.civitai.com/xG1/0bec-uuid/original=true/146.mp4"
        self.assertEqual(cv.media_url(u, "width=450"), "https://image.civitai.com/xG1/0bec-uuid/width=450/146.mp4")
        self.assertEqual(cv.media_url("https://elsewhere/x.jpg", "width=450"), "https://elsewhere/x.jpg")


class Key(unittest.TestCase):
    def setUp(self):
        cv.SECRETS.unlink(missing_ok=True)
        self.fake = FakeCivitai()
        cv.TRANSPORT = httpx.MockTransport(self.fake)

    def test_bad_key_not_stored(self):
        r = client.put("/api/civitai/key", json={"key": "wrongwrongwrongwrong"})
        self.assertEqual(r.status_code, 400)
        self.assertFalse(cv.SECRETS.exists())

    def test_key_stored_private_never_returned_or_logged(self):
        with self.assertLogs(level=logging.DEBUG) as logs:
            logging.getLogger("x").debug("start")
            r = client.put("/api/civitai/key", json={"key": KEY})
            st = client.get("/api/civitai/key")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn(KEY, r.text)
        self.assertEqual(st.json(), {"set": True, "user": "kbuser"})
        self.assertNotIn(KEY, st.text)
        self.assertNotIn(KEY, "\n".join(logs.output))
        self.assertEqual(stat.S_IMODE(cv.SECRETS.stat().st_mode), 0o600)
        self.assertEqual(self.fake.seen[-1].headers["authorization"], f"Bearer {KEY}")
        self.assertNotIn(KEY, str(self.fake.seen[-1].url))
        self.assertEqual(client.delete("/api/civitai/key").json()["set"], False)
        self.assertNotIn(KEY, cv.SECRETS.read_text())

    def test_scrub(self):
        cv._save_secrets({"civitai": {"key": KEY}})
        self.assertNotIn(KEY, cv.scrub(f"failed https://civitai.com/x?token={KEY}&a=1 {KEY}"))
        self.assertIn("token=***", cv.scrub("https://x/?token=zzz"))


class Download(unittest.TestCase):
    def setUp(self):
        cv.SECRETS.unlink(missing_ok=True)
        cv._cache.clear()
        shutil.rmtree(LORAS / "krea", ignore_errors=True)

    def run_dl(self, fake, **body):
        cv.TRANSPORT = httpx.MockTransport(fake)
        r = client.post("/api/civitai/download", json={"versionId": 77, "family": "krea", **body})
        if r.status_code != 200:
            return r, None
        return r, wait(r.json()["job"])

    def test_download_writes_file_and_sidecar_then_skips(self):
        cv._save_secrets({"civitai": {"key": KEY}})
        fake = FakeCivitai(name="../My LoRA v1.safetensors")
        _, job = self.run_dl(fake)
        self.assertEqual(job["state"], "done", job.get("error"))
        dest = LORAS / "krea" / "My LoRA v1.safetensors"
        self.assertEqual(dest.read_bytes(), fake.body)
        self.assertFalse(list((LORAS / "krea").glob("*.part")))
        side = json.loads((LORAS / "krea" / "My LoRA v1.safetensors.civitai.json").read_text())
        self.assertEqual((side["versionId"], side["trainedWords"], side["baseModel"]), (77, ["sks style"], "Krea 2"))
        self.assertNotIn(KEY, json.dumps(side))
        self.assertEqual(job["result"]["name"], "krea/My LoRA v1.safetensors")
        dl = [q for q in fake.seen if q.url.path.startswith("/api/download")][0]
        self.assertEqual(dl.headers["authorization"], f"Bearer {KEY}")
        self.assertNotIn("token", str(dl.url))
        cdn = [q for q in fake.seen if q.url.host == "cdn.example.com"][0]
        self.assertNotIn("authorization", cdn.headers)   # the key isn't sent on to the CDN
        # the search marks it as downloaded; a second download is skipped
        r = client.get("/api/civitai/search", params={"family": "krea"}).json()
        self.assertEqual(r["items"][0]["versions"][0]["downloaded"], "krea/My LoRA v1.safetensors")
        n = len(fake.seen)
        _, job2 = self.run_dl(fake)
        self.assertTrue(job2["result"]["skipped"])
        self.assertFalse([q for q in fake.seen[n:] if q.url.host == "cdn.example.com"])

    def test_needs_key_message(self):
        _, job = self.run_dl(FakeCivitai(need_key=True, name="needkey.safetensors"))
        self.assertEqual(job["state"], "error")
        self.assertIn("API key", job["error"])
        self.assertFalse((LORAS / "krea" / "needkey.safetensors").exists())

    def test_early_access_message(self):
        cv._save_secrets({"civitai": {"key": KEY}})
        _, job = self.run_dl(FakeCivitai(early=True, name="early.safetensors"))
        self.assertIn("early access", job["error"])
        self.assertNotIn(KEY, job["error"])

    def test_refuses_other_formats_and_html(self):
        r, _ = self.run_dl(FakeCivitai(name="model.ckpt"))
        self.assertEqual(r.status_code, 400)
        _, job = self.run_dl(FakeCivitai(body=b"<html>login</html>" * 10, name="html.safetensors"))
        self.assertEqual(job["state"], "error")
        self.assertFalse((LORAS / "krea" / "html.safetensors").exists())
        self.assertFalse((LORAS / "krea" / "html.safetensors.part").exists())

    def test_big_files_need_confirm(self):
        fake = FakeCivitai(name="huge.safetensors")
        v = fake.version()
        v["files"][0]["sizeKB"] = 5 * 1024 * 1024
        fake.version = lambda: v
        r, _ = self.run_dl(fake)
        self.assertEqual(r.status_code, 409)
        self.assertTrue(r.json()["detail"]["needsConfirm"])

    def test_different_file_same_name_kept(self):
        (LORAS / "krea").mkdir(exist_ok=True)
        (LORAS / "krea" / "clash.safetensors").write_bytes(b"other")
        _, job = self.run_dl(FakeCivitai(name="clash.safetensors"))
        self.assertEqual(job["result"]["file"], "clash_v77.safetensors")
        self.assertEqual((LORAS / "krea" / "clash.safetensors").read_bytes(), b"other")


if __name__ == "__main__":
    unittest.main()
