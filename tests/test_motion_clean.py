"""Mocap clean-up (app/motion.py): jitter, bone lengths, a planted foot, and a pan put back."""
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path

import numpy as np

from app import motion


def standing():
    """22 joints, y up, feet on the floor, a left step that can be planted."""
    p = np.zeros((22, 3))
    p[0] = [0, 0.95, 0]
    p[1] = [0.10, 0.90, 0]
    p[2] = [-0.10, 0.90, 0]
    p[3] = [0, 1.15, 0]
    p[4] = [0.10, 0.50, 0.02]
    p[5] = [-0.10, 0.50, 0.02]
    p[6] = [0, 1.32, 0]
    p[7] = [0.10, 0.08, 0.05]
    p[8] = [-0.10, 0.08, 0.05]
    p[9] = [0, 1.48, 0]
    p[10] = [0.10, 0.00, 0.18]
    p[11] = [-0.10, 0.00, 0.18]
    p[12] = [0, 1.58, 0]
    p[13] = [0.08, 1.48, 0]
    p[14] = [-0.08, 1.48, 0]
    p[15] = [0, 1.72, 0]
    p[16] = [0.18, 1.45, 0]
    p[17] = [-0.18, 1.45, 0]
    p[18] = [0.20, 1.15, 0]
    p[19] = [-0.20, 1.15, 0]
    p[20] = [0.18, 0.90, 0.02]
    p[21] = [-0.18, 0.90, 0.02]
    return p


def second_diff(a):
    return np.abs(np.diff(a, n=2, axis=0)).mean()


class Clean(unittest.TestCase):
    def test_jitter_and_bones(self):
        rng = np.random.default_rng(0)
        base = standing()
        frames = np.stack([base + rng.normal(0, 0.008, base.shape) for _ in range(40)])
        # the left knee pushed along its bone, a different amount each frame
        bone = frames[:, 4] - frames[:, 1]
        bone /= np.linalg.norm(bone, axis=1)[:, None]
        frames[:, 4] += bone * rng.normal(0, 0.03, len(frames))[:, None]
        raw_len = np.linalg.norm(frames[:, 4] - frames[:, 1], axis=1)
        raw_jit = second_diff(frames[:, 0])
        out, _ = motion.clean(frames, 30, {"smooth": True, "bones": True})
        got_len = np.linalg.norm(out[:, 4] - out[:, 1], axis=1)
        self.assertLess(got_len.std(), raw_len.std() * 0.25)
        self.assertLess(second_diff(out[:, 0]), raw_jit * 0.5)

    def test_planted_foot_holds(self):
        rng = np.random.default_rng(1)
        frames = np.stack([standing() for _ in range(30)])
        frames[:, 10, [0, 2]] += rng.normal(0, 0.001, (30, 2))   # 1 mm, slow enough to count as contact
        frames[:, 10, 1] += rng.uniform(0, 0.01, 30)
        frames[:, 11, 1] = 0.25                                  # the other foot is up, so it is not a contact
        out, contacts = motion.clean(frames, 30, {"feet": True, "ground": True})
        on = np.array(contacts["l"], dtype=bool)
        self.assertGreater(on.sum(), 20)
        self.assertEqual(sum(contacts["r"]), 0)
        mid = out[on, 10][:, [0, 2]]
        # the middle of the step is one place (the blend frames at the ends may still move)
        core = mid[6:-6]
        self.assertLess(core.std(axis=0).max(), 1e-6)
        self.assertLess(abs(float(out[on, 10, 1].mean())), 0.005)

    def test_pan_comes_back(self):
        """A body that only turns because the camera panned is still once that pan is undone."""
        world = standing()
        yaws = np.linspace(-0.4, 0.4, 12)
        seen = []
        for yaw in yaws:
            c, s = np.cos(yaw), np.sin(yaw)
            rot = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
            seen.append(world @ rot.T)
        back = []
        for yaw, frame in zip(yaws, seen):
            c, s = np.cos(-yaw), np.sin(-yaw)
            rot = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])
            back.append(frame @ rot.T)
        np.testing.assert_allclose(np.stack(back), np.broadcast_to(world, (len(back),) + world.shape), atol=1e-8)

    def test_old_json_is_unchanged(self):
        stand = standing()
        raw = {"fps": 24, "frames": np.stack([stand, stand + [0, 0, 0.1]]).tolist()}
        m = motion.read(json.dumps(raw).encode(), "old.json")
        self.assertNotIn("hands", m)
        self.assertNotIn("contacts", m)
        self.assertEqual(len(m["frames"][0]), 22)
        # a file that already names its hands keeps them, in the same space as the joints
        given = stand @ np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]]).T + [0.4, -0.2, -2]
        hand = np.stack([given[20] + [0, -0.02 * i, 0] for i in range(21)])
        doc = {"fps": 24, "source": "sam3d-body", "frames": np.stack([given, given]).tolist(),
               "hands": {"l": np.stack([hand, hand]).tolist(), "r": np.stack([hand, hand]).tolist()},
               "face": np.stack([given[[15, 15, 15, 15, 15]], given[[15, 15, 15, 15, 15]]]).tolist()}
        got = motion.read(json.dumps(doc).encode(), "hands.json")
        M, t, f = np.array(got["space"]["m"]), np.array(got["space"]["t"]), np.array(got["frames"])
        np.testing.assert_allclose((f[0] - t) @ M, given, atol=1e-3)
        wrist = np.array(got["hands"]["l"][0][0])
        np.testing.assert_allclose((wrist - t) @ M, given[20], atol=1e-3)


class Hands(unittest.TestCase):
    def test_mhr_order(self):
        sys.modules.setdefault("folder_paths", types.ModuleType("folder_paths"))
        path = Path(__file__).parents[1] / "comfy_nodes" / "deck_motion" / "__init__.py"
        spec = importlib.util.spec_from_file_location("deck_motion_hands", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        k = np.zeros((70, 3))
        k[41] = [1, 0, 0]     # right wrist
        k[32] = [0, 2, 0]     # right middle knuckle (third joint)
        k[29] = [0, 3, 0]     # right middle tip
        k[62] = [4, 0, 0]     # left wrist
        h = mod.hands_of(k)
        np.testing.assert_allclose(h["r"][0], [1, 0, 0])
        np.testing.assert_allclose(h["r"][1 + 8], [0, 2, 0])    # middle finger, knuckle first
        np.testing.assert_allclose(h["r"][1 + 11], [0, 3, 0])   # then the tip
        np.testing.assert_allclose(h["l"][0], [4, 0, 0])
        self.assertIsNone(mod.hands_of(np.zeros((10, 3))))


if __name__ == "__main__":
    unittest.main()
