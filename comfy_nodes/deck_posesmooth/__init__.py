"""ComfyDeck: steady DWPose over a clip.

Deck Pose Smooth takes DWPose's keypoints (the POSE_KEYPOINT output of the DWPose Estimator in
comfyui_controlnet_aux), steadies them over the whole clip (smooth.py: people followed from frame to frame,
short gaps filled, jumps pulled back, a Gaussian in time) and draws them again as OpenPose pictures, the size of
the DWPose picture it is given. Smoothing is in frames (0 is off).
"""
import importlib.util
from pathlib import Path

import numpy as np
import torch

_spec = importlib.util.spec_from_file_location("deck_posesmooth_smooth", Path(__file__).with_name("smooth.py"))
smooth = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(smooth)


def _normalised(frame):
    """Points as 0..1 of the canvas, which is what draw_poses scales to the picture."""
    W, H = float(frame.get("canvas_width") or 1), float(frame.get("canvas_height") or 1)
    vals = [v for p in frame["people"] for part in smooth.PARTS for v in (p.get(part) or [])[0::3]]
    if not vals or max(vals) <= 1.5:
        return frame
    out = []
    for p in frame["people"]:
        q = dict(p)
        for part in smooth.PARTS:
            a = p.get(part)
            if a:
                q[part] = [v / W if i % 3 == 0 else v / H if i % 3 == 1 else v for i, v in enumerate(a)]
        out.append(q)
    return {**frame, "people": out}


class DeckPoseSmooth:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "pose_keypoint": ("POSE_KEYPOINT",),
            "image": ("IMAGE", {"tooltip": "DWPose's picture: sets the size the poses are drawn at"}),
            "smoothing": ("FLOAT", {"default": 2.0, "min": 0.0, "max": 12.0, "step": 0.1,
                                    "tooltip": "Frames each point is averaged over (hands and face get half). 0 is off."}),
            "max_gap": ("INT", {"default": 6, "min": 0, "max": 48,
                                "tooltip": "Frames a point may go missing and still be filled in"}),
            "draw_hands": ("BOOLEAN", {"default": True}),
            "draw_face": ("BOOLEAN", {"default": True}),
        }}

    RETURN_TYPES = ("IMAGE", "POSE_KEYPOINT")
    FUNCTION = "run"
    CATEGORY = "ComfyDeck"

    def run(self, pose_keypoint, image, smoothing, max_gap, draw_hands, draw_face):
        from custom_controlnet_aux.dwpose import decode_json_as_poses, draw_poses   # comfyui_controlnet_aux

        frames = smooth.smooth(list(pose_keypoint), smoothing, max_gap)
        H, W = int(image.shape[1]), int(image.shape[2])
        pics = []
        for f in frames:
            poses = decode_json_as_poses(_normalised(f))[0]
            pics.append(draw_poses(poses, H, W, draw_body=True, draw_hand=draw_hands, draw_face=draw_face))
        out = torch.from_numpy(np.stack(pics).astype(np.float32) / 255.0)
        return (out, frames)


NODE_CLASS_MAPPINGS = {"DeckPoseSmooth": DeckPoseSmooth}
NODE_DISPLAY_NAME_MAPPINGS = {"DeckPoseSmooth": "Deck Pose Smooth"}
