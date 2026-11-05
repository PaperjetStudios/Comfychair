"""Deck Face Restore: a picture that isn't GFPGAN's 512x512 face goes face by face. No GPU. Run with: .venv/bin/python -m unittest tests/test_facerestore.py"""
import importlib.util
import unittest
from pathlib import Path

import numpy as np

try:
    import cv2  # noqa: F401
    import torch
except ImportError:
    cv2 = torch = None

ROOT = Path(__file__).resolve().parent.parent


def load():
    spec = importlib.util.spec_from_file_location("deck_facerestore", ROOT / "comfy_nodes/deck_facerestore/__init__.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def points(mask, x, y, size):
    """Face points scattered over a square, as DWPose draws them."""
    mask[y:y + size:12, x:x + size:12] = True


@unittest.skipIf(torch is None, "needs torch and cv2")
class FaceRestore(unittest.TestCase):
    def setUp(self):
        self.m = load()

    def test_each_face_gets_a_square_with_room_inside_the_picture(self):
        mask = np.zeros((800, 1200), bool)
        points(mask, 100, 100, 200)
        points(mask, 900, 500, 100)
        boxes = self.m.face_boxes(mask, 1200, 800)
        self.assertEqual(len(boxes), 2)
        (x, y, side), (x2, y2, side2) = boxes
        self.assertGreater(side, side2)
        self.assertAlmostEqual(side, 200 * self.m.ROOM, delta=30)
        for bx, by, s in boxes:
            self.assertTrue(0 <= bx and bx + s <= 1200 and 0 <= by and by + s <= 800)
        self.assertLess(x, 100)
        self.assertLess(y, 100)

    def test_a_speck_or_nothing_is_no_face(self):
        mask = np.zeros((600, 600), bool)
        self.assertEqual(self.m.face_boxes(mask, 600, 600), [])
        mask[10, 10] = True
        self.assertEqual(self.m.face_boxes(mask, 600, 600), [])

    def test_only_the_faces_change_and_the_size_stays(self):
        calls = []

        def model(x):
            calls.append(x.shape)
            return torch.ones_like(x)

        rgb, mask = torch.zeros(1, 400, 700, 3), torch.zeros(400, 700)
        mask[100:200:8, 100:200:8] = 1
        out = self.m.restore_frame(rgb, model, mask)
        self.assertEqual(out.shape, rgb.shape)
        self.assertEqual(calls, [torch.Size([1, 3, 512, 512])])   # the model only ever sees its own size
        self.assertGreater(out[0, 150, 150, 0].item(), 0.9)
        self.assertEqual(out[0, 390, 690, 0].item(), 0)

    def test_a_512_crop_goes_straight_in_and_asks_for_no_mask(self):
        out = self.m.restore_frame(torch.zeros(1, 512, 512, 3), lambda x: torch.ones_like(x))
        self.assertEqual(out.min().item(), 1)
        node = self.m.DeckFaceRestore()
        self.assertEqual(node.check_lazy_status(image=torch.zeros(1, 512, 512, 3)), [])
        self.assertEqual(node.check_lazy_status(image=torch.zeros(1, 400, 700, 3)), ["mask"])

    def test_no_face_says_so(self):
        with self.assertRaisesRegex(ValueError, "no face found"):
            self.m.restore_frame(torch.zeros(1, 400, 700, 3), lambda x: x, torch.zeros(400, 700))
        with self.assertRaisesRegex(ValueError, "no face found"):
            self.m.restore_frame(torch.zeros(1, 400, 700, 3), lambda x: x)


if __name__ == "__main__":
    unittest.main()
