"""Which splat file the 3D view and renders load (web/splat-levels.js) is pure, so node runs it directly."""
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "node not installed")
class SplatLevelsJs(unittest.TestCase):
    def test_levels(self):
        r = subprocess.run(["node", str(Path(__file__).with_name("splat_levels.test.mjs"))], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        self.assertIn("splat levels ok", r.stdout)

    def test_shape(self):
        r = subprocess.run(["node", str(Path(__file__).with_name("splat_shape.test.mjs"))], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        self.assertIn("splat shape ok", r.stdout)


if __name__ == "__main__":
    unittest.main()
