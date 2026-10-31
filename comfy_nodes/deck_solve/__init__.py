"""ComfyChair: 3D camera solve helpers as ComfyUI nodes.

Deck MoGe Export takes the geometry of one picture from ComfyUI's MoGe nodes and points picked on it
(JSON pixels), and writes their 3D positions, the camera's intrinsics and a sparse grid of the scene
as a JSON file in the output folder. Deck DA3 Export does the same for a multi-view Depth Anything 3
run: each view's camera (camera-to-world) and intrinsics, and the first view's depth as a grid.
ComfyChair's motion tracking (app/solve.py) reads the file, then deletes it.

Neither node holds anything on the GPU: the tensors are copied to the CPU and the work is numpy (geom.py).
"""
import json
import os

import numpy as np

import folder_paths

from .geom import da3_export, moge_export


def _np(t):
    return None if t is None else (t.detach().float().cpu().numpy() if hasattr(t, "detach") else np.asarray(t))


def _save(data: dict, prefix: str, w: int, h: int) -> dict:
    text = json.dumps(data, separators=(",", ":"))
    folder, name, counter, sub, _ = folder_paths.get_save_image_path(prefix, folder_paths.get_output_directory(), w, h)
    fname = f"{name}_{counter:05}_.json"
    with open(os.path.join(folder, fname), "w") as f:
        f.write(text)
    return {"ui": {"files": [{"filename": fname, "subfolder": sub, "type": "output"}]}, "result": (text,)}


class DeckMoGeExport:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "moge_geometry": ("MOGE_GEOMETRY",),
                "points": ("STRING", {"default": "[]", "multiline": True,
                                      "tooltip": "JSON [[x, y], ...] in pixels of the picture: their 3D positions are written."}),
                "grid": ("INT", {"default": 48, "min": 4, "max": 256,
                                 "tooltip": "Columns of the sparse point grid (for finding the floor)."}),
                "filename_prefix": ("STRING", {"default": "moge_export"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("geometry",)
    FUNCTION = "export"
    OUTPUT_NODE = True
    CATEGORY = "ComfyChair"

    def export(self, moge_geometry, points, grid, filename_prefix):
        if "points" not in moge_geometry or "intrinsics" not in moge_geometry:
            raise ValueError("Deck MoGe Export needs perspective MoGe geometry (points and intrinsics): use Run MoGe Inference")
        try:
            queries = json.loads(points or "[]")
        except json.JSONDecodeError as e:
            raise ValueError(f"points isn't JSON: {e}")
        pmap = _np(moge_geometry["points"][0])
        mask = _np(moge_geometry.get("mask")[0]) if moge_geometry.get("mask") is not None else None
        data = moge_export(pmap, mask, _np(moge_geometry["intrinsics"][0]), queries, grid)
        return _save(data, filename_prefix, data["width"], data["height"])


class DeckDA3Export:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "da3_geometry": ("DA3_GEOMETRY",),
                "grid": ("INT", {"default": 48, "min": 4, "max": 256,
                                 "tooltip": "Columns of the first view's depth grid."}),
                "resolution": ("INT", {"default": 504, "min": 140, "max": 2520, "step": 14,
                                       "tooltip": "The resolution Run Depth Anything 3 used (upper_bound_resize): its intrinsics are in those pixels."}),
                "filename_prefix": ("STRING", {"default": "da3_export"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("geometry",)
    FUNCTION = "export"
    OUTPUT_NODE = True
    CATEGORY = "ComfyChair"

    def export(self, da3_geometry, grid, resolution, filename_prefix):
        if "extrinsics" not in da3_geometry or "intrinsics" not in da3_geometry:
            raise ValueError("Deck DA3 Export needs multi-view Depth Anything 3 geometry (mode: multiview, a Small or Base model)")
        depth = _np(da3_geometry["depth"])
        extr, intr = _np(da3_geometry["extrinsics"])[0], _np(da3_geometry["intrinsics"])[0]
        data = da3_export(depth, extr, intr, grid, resolution, sky=_np(da3_geometry.get("sky")),
                          conf=_np(da3_geometry.get("confidence")))
        return _save(data, filename_prefix, data["width"], data["height"])


NODE_CLASS_MAPPINGS = {"DeckMoGeExport": DeckMoGeExport, "DeckDA3Export": DeckDA3Export}
NODE_DISPLAY_NAME_MAPPINGS = {"DeckMoGeExport": "Deck MoGe Export", "DeckDA3Export": "Deck DA3 Export"}
