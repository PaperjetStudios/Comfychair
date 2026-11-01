"""Pictures dragged in from a browser as a link: fetched for the page, only from public sites, and only if a picture."""
import io
import os
import tempfile
import unittest
from unittest import mock

import httpx
from PIL import Image


def setUpModule():
    global client, fp
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-fetchpic-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from fastapi.testclient import TestClient
    from app import fetchpicture, main
    fp = fetchpicture
    client = TestClient(main.app)


def png():
    b = io.BytesIO()
    Image.new("RGB", (2, 2)).save(b, "PNG")
    return b.getvalue()


class FetchPicture(unittest.TestCase):
    def serve(self, handler, public=True):
        for p in (mock.patch.object(fp, "TRANSPORT", httpx.MockTransport(handler)),
                  mock.patch.object(fp, "public_host", side_effect=public if callable(public) else lambda h: public)):
            p.start()
            self.addCleanup(p.stop)

    def post(self, url="https://site.test/a.png"):
        return client.post("/api/fetch-picture", json={"url": url})

    def test_gives_the_picture(self):
        self.serve(lambda q: httpx.Response(200, content=png()))
        r = self.post()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["content-type"], "image/png")
        self.assertEqual(r.content, png())

    def test_not_a_picture(self):
        self.serve(lambda q: httpx.Response(200, text="<html>a page</html>"))
        self.assertEqual(self.post().status_code, 400)

    def test_site_refuses(self):
        self.serve(lambda q: httpx.Response(403))
        self.assertEqual(self.post().status_code, 502)

    def test_only_web_addresses(self):
        self.serve(lambda q: httpx.Response(200, content=png()))
        for url in ("file:///etc/passwd", "ftp://site.test/a.png", ""):
            self.assertEqual(self.post(url).status_code, 400, url)

    def test_private_address_refused(self):
        hit = []
        self.serve(lambda q: hit.append(q) or httpx.Response(200, content=png()), public=False)
        self.assertEqual(self.post("http://192.168.1.2/a.png").status_code, 400)
        self.assertEqual(hit, [])

    def test_redirect_into_private_address_refused(self):
        hit = []
        def handler(q):
            hit.append(str(q.url))
            return httpx.Response(302, headers={"location": "http://127.0.0.1:8190/secret.png"})
        self.serve(handler, public=lambda h: h == "site.test")
        self.assertEqual(self.post().status_code, 400)
        self.assertEqual(hit, ["https://site.test/a.png"])

    def test_redirect_loop_stops(self):
        self.serve(lambda q: httpx.Response(302, headers={"location": "https://site.test/a.png"}))
        self.assertEqual(self.post().status_code, 502)

    def test_addresses(self):
        for ip in ("127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fe80::1%eth0"):
            self.assertFalse(fp._public(ip), ip)
        for ip in ("93.184.216.34", "2606:4700:4700::1111"):
            self.assertTrue(fp._public(ip), ip)


if __name__ == "__main__":
    unittest.main()
