"""The talking shot helpers (web/talk.js) are pure, so node runs it directly."""
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "node not installed")
class Talk(unittest.TestCase):
    def test_talk(self):
        r = subprocess.run(["node", str(Path(__file__).with_name("talk.test.mjs"))], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        self.assertIn("talk ok", r.stdout)


if __name__ == "__main__":
    unittest.main()
