"""Create object's geometry (web/model-geom.js) is pure, so node runs it directly."""
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "node not installed")
class ModelGeom(unittest.TestCase):
    def test_geometry(self):
        r = subprocess.run(["node", str(Path(__file__).with_name("model_geom.test.mjs"))], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        self.assertIn("model geometry ok", r.stdout)


if __name__ == "__main__":
    unittest.main()
