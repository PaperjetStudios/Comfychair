"""Motion files (app/motion.py): joint arrays found, z-up turned to y-up, start facing +Z, on the floor."""
import io
import json
import unittest

import numpy as np

from app import motion

# a standing person, y up, facing +Z, left on +X (enough of the 22 joints to read)
STAND = np.zeros((22, 3))
for i, p in {0: (0, .95, 0), 1: (.09, .9, 0), 2: (-.09, .9, 0), 15: (0, 1.65, 0), 10: (.09, .02, .12), 11: (-.09, .02, .12),
             7: (.09, .07, 0), 8: (-.09, .07, 0)}.items():
    STAND[i] = p


def npz(**arrays):
    b = io.BytesIO()
    np.savez(b, **arrays)
    return b.getvalue()


class Read(unittest.TestCase):
    def test_npz_y_up(self):
        walk = np.stack([STAND + [0, 0, 0.05 * f] for f in range(10)])
        m = motion.read(npz(posed_joints=walk[:, None].repeat(1, 1)[:, 0], mocap_framerate=np.array(30.0)), "a.npz")
        self.assertEqual((m["fps"], len(m["frames"]), m["joints"]), (30.0, 10, 22))
        f = np.array(m["frames"])
        self.assertAlmostEqual(f[-1, 0, 2], 0.45, places=3)          # walked forward along +Z
        self.assertAlmostEqual(f[:, [10, 11], 1].min(), 0.0, places=4)

    def test_z_up_and_turned(self):
        zup = STAND[:, [0, 2, 1]] * [1, -1, 1]                       # y up -> z up
        turned = zup @ np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]]).T  # and turned 90° about the vertical
        m = motion.read(npz(joints=np.stack([turned, turned])), "b.npz", default_fps=20)
        f = np.array(m["frames"])
        self.assertEqual(m["fps"], 20)
        self.assertGreater(f[0, 15, 1], 1.5)                         # head up
        self.assertGreater(f[0, 1, 0] - f[0, 2, 0], 0.17)             # left hip on +X again

    def test_json_and_errors(self):
        m = motion.read(json.dumps({"fps": 24, "frames": np.stack([STAND, STAND]).tolist()}).encode(), "c.json")
        self.assertEqual(m["fps"], 24)
        with self.assertRaises(ValueError):
            motion.read(npz(x=np.zeros((5, 3))), "d.npz")


if __name__ == "__main__":
    unittest.main()
