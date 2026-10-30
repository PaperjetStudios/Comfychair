"""Route registration and coherent app-shell versioning after the feature split."""
import os
import re
import tempfile
import unittest


def setUpModule():
    global client, main
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-routes-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from fastapi.testclient import TestClient
    from app import main as server
    main = server
    client = TestClient(main.app)


class Routes(unittest.TestCase):
    def test_feature_routes_registered_once(self):
        schema = client.get("/openapi.json").json()["paths"]
        for path in ("/api/video/render", "/api/video/matte", "/api/audio/extract",
                     "/api/sound/render", "/api/scene/depth-combine", "/api/motion/clean"):
            self.assertIn("post", schema[path], path)
        self.assertIn("get", schema["/api/snippets"])
        self.assertIn("get", schema["/api/storage/sweep"])

    def test_shell_uses_one_version_for_styles_and_modules(self):
        page = client.get("/")
        self.assertEqual(page.status_code, 200)
        css = re.search(r'app\.css\?v=(\d+)', page.text).group(1)
        script = re.search(r'app\.js\?v=(\d+)', page.text).group(1)
        self.assertEqual(css, script)
        self.assertEqual(page.headers["cache-control"], "no-cache")
        module = client.get(f"/app.js?v={script}")
        self.assertIn(f"'./gentabs.js?v={script}'", module.text)
        self.assertIn(f"'./navigation.js?v={script}'", module.text)

    def test_feature_validation_still_reaches_its_handler(self):
        for path in ("/api/video/render", "/api/audio/extract", "/api/scene/photo"):
            response = client.post(path, json={})
            self.assertEqual(response.status_code, 400, (path, response.text))
