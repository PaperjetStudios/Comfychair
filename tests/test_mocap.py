"""Video mocap: SAM 3D Body's MHR70 keypoints -> the 3D tab's 22 SMPL joints (comfy_nodes/deck_motion).
Run: .venv/bin/python -m unittest discover tests"""
import importlib.util
import sys
import types
import unittest
from pathlib import Path

import numpy as np

sys.modules.setdefault("folder_paths", types.ModuleType("folder_paths"))   # only the save itself needs ComfyUI
_spec = importlib.util.spec_from_file_location(
    "deck_motion", Path(__file__).resolve().parent.parent / "comfy_nodes" / "deck_motion" / "__init__.py")
dm = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dm)


def standing(dx=0.0):
    """MHR70 keypoints of a person standing, in camera space (y down), dx metres to the right."""
    k = np.zeros((70, 3))
    at = {"nose": (0, -1.65, 0), "lear": (0.08, -1.62, 0), "rear": (-0.08, -1.62, 0), "neck": (0, -1.45, 0),
          "lsho": (0.2, -1.42, 0), "rsho": (-0.2, -1.42, 0), "lelb": (0.25, -1.12, 0), "relb": (-0.25, -1.12, 0),
          "lwri": (0.27, -0.85, 0), "rwri": (-0.27, -0.85, 0), "lhip": (0.1, -0.95, 0), "rhip": (-0.1, -0.95, 0),
          "lknee": (0.1, -0.5, 0), "rknee": (-0.1, -0.5, 0), "lank": (0.1, -0.08, 0), "rank": (-0.1, -0.08, 0),
          "ltoe": (0.12, 0, -0.15), "lsmall": (0.08, 0, -0.13), "rtoe": (-0.12, 0, -0.15), "rsmall": (-0.08, 0, -0.13)}
    for n, p in at.items():
        k[dm.MHR[n]] = np.array(p) + [dx, 0, 0]
    return k


class Mocap(unittest.TestCase):
    def test_joints_land_where_smpl_expects_them(self):
        j = dm.mhr_to_smpl22(standing())
        self.assertEqual(j.shape, (22, 3))
        np.testing.assert_allclose(j[0], [0, -0.95, 0])               # pelvis between the hips
        np.testing.assert_allclose(j[12], [0, -1.45, 0])              # neck
        self.assertTrue(j[0][1] > j[3][1] > j[6][1] > j[9][1] > j[12][1])   # spine climbs (y down) pelvis -> neck
        np.testing.assert_allclose(j[20], [0.27, -0.85, 0])          # left wrist
        self.assertAlmostEqual(j[15][1], -1.62)                      # head between the ears

    def test_frames_are_y_up_and_gaps_filled(self):
        person = lambda dx: {"pred_keypoints_3d": standing(dx), "pred_cam_t": np.array([0.0, 0.0, 3.0])}
        frames = dm.body_frames({"frames": [[person(0)], [], [person(0.2)]]})
        self.assertGreater(frames[0][15][1], frames[0][0][1])        # head above pelvis: y is up now
        np.testing.assert_allclose(frames[1][0][0], 0.1)            # the missing frame halfway between
        with self.assertRaises(ValueError):
            dm.body_frames({"frames": [[], []]})


if __name__ == "__main__":
    unittest.main()
