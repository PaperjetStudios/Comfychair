"""Network settings routes: addresses, QR codes, the CA download."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock


def setUpModule():
    global client, network
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-network-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from fastapi.testclient import TestClient
    from app import main, network as net
    network = net
    client = TestClient(main.app)


TS = {"state": "Running", "ip": "100.64.0.7", "dns": None}


class Network(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="deck-certs-"))
        for p in (mock.patch.object(network, "CERTS_DIR", self.tmp),
                  mock.patch.object(network, "_lan", return_value=[("wlan0", "192.168.1.5")]),
                  mock.patch.object(network, "_tailscale", return_value=dict(TS)),
                  mock.patch.object(network, "_cert", return_value=None)):
            p.start()
            self.addCleanup(p.stop)

    def test_lists_addresses(self):
        d = client.get("/api/network").json()
        kinds = [a["kind"] for a in d["addresses"]]
        self.assertEqual(kinds, ["lan", "tailscale", "mdns"])
        self.assertTrue(d["addresses"][0]["url"].endswith("192.168.1.5:%d" % d["port"]))
        self.assertEqual(d["tailscale"]["state"], "Running")
        self.assertFalse(d["ca"])

    def test_tailscale_waiting_has_no_address(self):
        with mock.patch.object(network, "_tailscale", return_value={**TS, "state": "NeedsMachineAuth"}):
            d = client.get("/api/network").json()
        self.assertEqual([a["kind"] for a in d["addresses"]], ["lan", "mdns"])
        self.assertIsNone(d["tailscale"]["url"])

    def test_qr(self):
        url = client.get("/api/network").json()["addresses"][0]["url"]
        r = client.get("/api/network/qr.svg", params={"url": url})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.headers["content-type"].startswith("image/svg+xml"))
        self.assertEqual(r.headers["cache-control"], "no-store")
        self.assertEqual(client.get("/api/network/qr.svg", params={"url": "http://evil.example"}).status_code, 400)

    def test_ca(self):
        self.assertEqual(client.get("/api/network/ca").status_code, 404)
        (self.tmp / "comfydeck-ca.crt").write_text("CERT")
        (self.tmp / "comfydeck-ca.key").write_text("SECRET")
        r = client.get("/api/network/ca")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.text, "CERT")
        self.assertIn("application/x-x509-ca-cert", r.headers["content-type"])
        self.assertIn('attachment; filename="comfydeck-ca.crt"', r.headers["content-disposition"])
        self.assertTrue(client.get("/api/network").json()["ca"])

    def test_keys_unreachable(self):
        (self.tmp / "comfydeck-ca.key").write_text("SECRET")
        for path in ("/api/network/comfydeck-ca.key", "/api/network/ca/comfydeck-ca.key", "/api/network/../certs/deck-key.pem"):
            r = client.get(path)
            self.assertNotIn("SECRET", r.text)
            self.assertNotEqual(r.status_code, 200, path)

    def test_cert_covers(self):
        cert = {"sans": ["192.168.1.5"], "expires": "2030-01-01T00:00:00+00:00", "covers": True}
        with mock.patch.object(network, "_cert", return_value=cert), mock.patch.dict(os.environ, {"SSL_CERT": "a", "SSL_KEY": "b"}):
            d = client.get("/api/network").json()
        self.assertEqual(d["scheme"], "https")
        self.assertFalse(d["cert"]["covers"])   # tailscale ip not in the SANs


if __name__ == "__main__":
    unittest.main()
