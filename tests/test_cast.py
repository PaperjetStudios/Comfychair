"""Characters in the Story tab's shot text (web/cast.js) are pure, so node runs them directly."""
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "node not installed")
class Cast(unittest.TestCase):
    def test_cast(self):
        r = subprocess.run(["node", str(Path(__file__).with_name("cast.test.mjs"))], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        self.assertIn("cast ok", r.stdout)


if __name__ == "__main__":
    unittest.main()
