"""Deck Pose Smooth (comfy_nodes/deck_posesmooth/smooth.py): steadier DWPose keypoints over a clip.
Run: .venv/bin/python -m unittest discover tests"""
import importlib.util
import unittest
from pathlib import Path

import numpy as np

_spec = importlib.util.spec_from_file_location(
    "posesmooth", Path(__file__).resolve().parent.parent / "comfy_nodes" / "deck_posesmooth" / "smooth.py")
smooth = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smooth)


def person(x, y, missing=()):
    """18 body points in a 0.2 x 0.4 box at (x, y); points in `missing` not found."""
    pts = []
    for k in range(18):
        found = k not in missing
        pts += [x + 0.2 * (k % 3) / 2, y + 0.4 * (k // 3) / 5, 1.0] if found else [0.0, 0.0, 0.0]
    return {"pose_keypoints_2d": pts, "face_keypoints_2d": None, "hand_left_keypoints_2d": None, "hand_right_keypoints_2d": None}


def frames(people_per_frame):
    return [{"people": ps, "canvas_width": 512, "canvas_height": 512} for ps in people_per_frame]


def xy(frame, i=0, k=0):
    a = frame["people"][i]["pose_keypoints_2d"]
    return np.array(a[k * 3:k * 3 + 3])


class Smooth(unittest.TestCase):
    def test_shake_is_smaller(self):
        rng = np.random.default_rng(1)
        noise = rng.normal(0, 0.01, 40)
        out = smooth.smooth(frames([[person(0.3 + n, 0.2)] for n in noise]), smoothing=2.0)
        got = np.array([xy(f)[0] for f in out]) - 0.3
        self.assertLess(np.std(got), np.std(noise) * 0.5)

    def test_steady_motion_keeps_its_place(self):
        # no lag: a person walking at a steady pace is where they were, smoothing or not
        out = smooth.smooth(frames([[person(0.1 + 0.01 * t, 0.2)] for t in range(30)]), smoothing=3.0)
        self.assertAlmostEqual(xy(out[15])[0], 0.25, places=6)

    def test_short_gap_is_filled_long_gap_is_not(self):
        seq = [[person(0.3, 0.2)] for _ in range(30)]
        for t in (10, 11):
            seq[t] = [person(0.3, 0.2, missing={4})]
        for t in range(18, 28):
            seq[t] = [person(0.3, 0.2, missing={5})]
        out = smooth.smooth(frames(seq), max_gap=6)
        self.assertEqual(xy(out[11], k=4)[2], 1.0)
        self.assertAlmostEqual(xy(out[11], k=4)[0], 0.3 + 0.2 * (4 % 3) / 2)
        self.assertEqual(xy(out[22], k=5)[2], 0.0)

    def test_a_jump_is_pulled_back(self):
        seq = [[person(0.3, 0.2)] for _ in range(20)]
        bad = person(0.3, 0.2)
        bad["pose_keypoints_2d"][0] = 0.9            # point 0 lands on the far side for one frame
        seq[10] = [bad]
        out = smooth.smooth(frames(seq), smoothing=0)
        self.assertAlmostEqual(xy(out[10])[0], 0.3, places=6)

    def test_people_keep_their_track_when_dwpose_swaps_the_order(self):
        seq = [[person(0.1, 0.2), person(0.7, 0.2)] if t % 2 else [person(0.7, 0.2), person(0.1, 0.2)] for t in range(10)]
        out = smooth.smooth(frames(seq), smoothing=2.0)
        lefts = {round(xy(f, 0)[0], 6) for f in out} | {round(xy(f, 1)[0], 6) for f in out}
        self.assertEqual(lefts, {0.1, 0.7})          # never averaged into a point between them

    def test_off_and_empty(self):
        seq = frames([[person(0.3, 0.2)], [], [person(0.3, 0.2)]])
        self.assertEqual(smooth.smooth([]), [])
        out = smooth.smooth(seq, smoothing=0, max_gap=0)
        self.assertEqual(out[1]["people"], [])
        self.assertEqual(out[0]["canvas_width"], 512)


if __name__ == "__main__":
    unittest.main()
