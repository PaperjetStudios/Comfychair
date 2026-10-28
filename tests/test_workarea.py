"""The work area's maths (web/workarea-math.js) is pure, so node runs it directly."""
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "node not installed")
class WorkAreaMath(unittest.TestCase):
    def test_math(self):
        r = subprocess.run(["node", str(Path(__file__).with_name("workarea.test.mjs"))], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        self.assertIn("workarea math ok", r.stdout)


if __name__ == "__main__":
    unittest.main()
