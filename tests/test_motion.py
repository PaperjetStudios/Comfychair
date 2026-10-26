"""Motion retargeting (web/motion.js): every pose preset survives a trip through SMPL-22 points."""
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "node not installed")
class Motion(unittest.TestCase):
    def test_retarget(self):
        r = subprocess.run(["node", str(Path(__file__).with_name("motion.test.mjs"))], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        self.assertIn("motion ok", r.stdout)


if __name__ == "__main__":
    unittest.main()
