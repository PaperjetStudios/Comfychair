import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "node not installed")
class DepthRange(unittest.TestCase):
    def test_depth_range(self):
        r = subprocess.run(["node", str(Path(__file__).with_name("depth_range.test.mjs"))], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
