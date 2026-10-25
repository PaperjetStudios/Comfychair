"""The camera made from a motion track (web/track-math.js) is pure, so node runs it directly."""
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "node not installed")
class TrackMath(unittest.TestCase):
    def test_camera(self):
        r = subprocess.run(["node", str(Path(__file__).with_name("track.test.mjs"))], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        self.assertIn("track math ok", r.stdout)


if __name__ == "__main__":
    unittest.main()
