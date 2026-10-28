"""The 3D gizmo's World / Local / View axes and pivot (web/gizmo-orient.js) are pure maths, so node runs them directly."""
import shutil
import subprocess
import unittest
from pathlib import Path


@unittest.skipUnless(shutil.which("node"), "node not installed")
class GizmoOrient(unittest.TestCase):
    def test_gizmo_orient(self):
        r = subprocess.run(["node", str(Path(__file__).with_name("gizmo_orient.test.mjs"))], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr[-2000:])
        self.assertIn("gizmo_orient ok", r.stdout)


if __name__ == "__main__":
    unittest.main()
