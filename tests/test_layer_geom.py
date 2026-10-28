"""Where a turned Editor layer lands (web/layer-geom.js) is pure maths, so node runs it directly."""
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "node not installed")
class LayerGeom(unittest.TestCase):
    def test_layer_geom(self):
        r = subprocess.run(["node", str(Path(__file__).with_name("layer_geom.test.mjs"))], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        self.assertIn("layer geom ok", r.stdout)


if __name__ == "__main__":
    unittest.main()
