"""ComfyChair: TAPNext++ point tracking as a ComfyUI node.

Deck TAPNext++ Track takes a video (IMAGE batch) and points to follow (JSON, pixels, each with the frame
it is picked on), or a grid, and writes the tracks as a JSON file in the output folder (ComfyChair's
motion tracking reads it). Points picked on a later frame are tracked forwards and backwards from there.

The checkpoint (tapnextpp_ckpt.pt, Apache 2.0, google-deepmind/tapnet) goes in models/tapnet/ next to
any of ComfyUI's model folders (extra_model_paths.yaml bases count too). The model lives on the CPU
between runs so it doesn't hold VRAM that the video models need.
"""
import json
import os
import time

import numpy as np
import torch

import comfy.model_management as mm
import comfy.utils
import folder_paths

from .tapnext.model import TAPNextPP

FOLDER = "tapnet"


def _register():
    """models/tapnet beside every known models folder (the extra_model_paths bases have no tapnet entry)."""
    roots = {folder_paths.models_dir}
    for key in ("loras", "checkpoints", "diffusion_models", "vae"):
        try:
            roots.update(os.path.dirname(os.path.normpath(p)) for p in folder_paths.get_folder_paths(key))
        except Exception:
            pass
    paths = [os.path.join(r, FOLDER) for r in sorted(roots)]
    folder_paths.folder_names_and_paths[FOLDER] = (paths, {".pt", ".ckpt", ".pth"})


_register()
_CACHE = {}


def _model(name: str) -> TAPNextPP:
    _register()
    path = folder_paths.get_full_path(FOLDER, name)
    if not path:
        raise FileNotFoundError(f"{name} isn't in any models/{FOLDER} folder")
    if path not in _CACHE:
        _CACHE.clear()
        _CACHE[path] = TAPNextPP.from_checkpoint(path, device="cpu")
    return _CACHE[path]


def _grid(n: int, w: int, h: int) -> list[dict]:
    m = 0.06  # keep off the edges, where points leave first
    xs = np.linspace(m * w, (1 - m) * w, n)
    ys = np.linspace(m * h, (1 - m) * h, n)
    return [{"x": float(x), "y": float(y), "t": 0} for y in ys for x in xs]


def _run(model: TAPNextPP, frames: np.ndarray, pts: np.ndarray, order: list[int], pbar) -> tuple[np.ndarray, np.ndarray]:
    """Track pts (Q,2, picked on frames[order[0]]) through frames in this order. Returns (Q,len,2), (Q,len)."""
    pos = np.zeros((len(pts), len(order), 2), np.float32)
    vis = np.zeros((len(pts), len(order)), bool)
    state = None
    for k, i in enumerate(order):
        bgr = np.ascontiguousarray(frames[i][..., ::-1])
        p, v, state = model.track_frame(bgr, pts if state is None else None, state)
        pos[:, k], vis[:, k] = p, v
        pbar.update(1)
    return pos, vis


class DeckTAPNextTrack:
    @classmethod
    def INPUT_TYPES(cls):
        _register()   # (again: extra_model_paths may load after this module)
        return {
            "required": {
                "images": ("IMAGE",),
                "checkpoint": (folder_paths.get_filename_list(FOLDER) or ["tapnextpp_ckpt.pt"],),
                "points": ("STRING", {"default": "[]", "multiline": True,
                                      "tooltip": 'JSON [{"x": px, "y": px, "t": frame}]. Empty: a grid.'}),
                "grid": ("INT", {"default": 16, "min": 2, "max": 48,
                                 "tooltip": "Grid points per side when no points are given (on the first frame)."}),
                "filename_prefix": ("STRING", {"default": "tracks"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("tracks",)
    FUNCTION = "track"
    OUTPUT_NODE = True
    CATEGORY = "ComfyChair"

    def track(self, images, checkpoint, points, grid, filename_prefix):
        frames = (images.clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
        n, h, w = frames.shape[:3]
        try:
            pts = json.loads(points or "[]")
        except json.JSONDecodeError as e:
            raise ValueError(f"points isn't JSON: {e}")
        if not pts:
            pts = _grid(grid, w, h)
        pts = [{"x": float(p["x"]), "y": float(p["y"]), "t": min(n - 1, max(0, int(p.get("t", 0))))} for p in pts]

        model = _model(checkpoint)
        dev = mm.get_torch_device()
        model._model.to(dev); model.device = dev
        pos = np.zeros((len(pts), n, 2), np.float32)
        vis = np.zeros((len(pts), n), bool)
        starts = sorted({p["t"] for p in pts})
        pbar = comfy.utils.ProgressBar(sum((n - t) + (t + 1 if t else 0) for t in starts))
        t0 = time.time()
        try:
            for t in starts:   # one forward (and, for a later frame, one backward) pass per pick frame
                idx = [i for i, p in enumerate(pts) if p["t"] == t]
                q = np.array([[pts[i]["x"], pts[i]["y"]] for i in idx], np.float32)
                fp, fv = _run(model, frames, q, list(range(t, n)), pbar)
                pos[idx, t:], vis[idx, t:] = fp, fv
                if t > 0:
                    bp, bv = _run(model, frames, q, list(range(t, -1, -1)), pbar)
                    pos[idx, :t + 1] = bp[:, ::-1]; vis[idx, :t + 1] = bv[:, ::-1]
        finally:
            model._model.to("cpu"); model.device = torch.device("cpu")
            mm.soft_empty_cache()

        out = {
            "version": 1, "model": "tapnext++", "width": w, "height": h, "frames": n,
            "seconds": round(time.time() - t0, 2),
            "points": pts,
            # per point, per frame: [x, y, visible]
            "tracks": [[[round(float(x), 2), round(float(y), 2), int(v)] if np.isfinite(x) and np.isfinite(y) else [-1, -1, 0]
                        for (x, y), v in zip(pos[q], vis[q])] for q in range(len(pts))],
        }
        text = json.dumps(out, separators=(",", ":"))
        folder, name, counter, sub, _ = folder_paths.get_save_image_path(filename_prefix, folder_paths.get_output_directory(), w, h)
        fname = f"{name}_{counter:05}_.json"
        with open(os.path.join(folder, fname), "w") as f:
            f.write(text)
        return {"ui": {"files": [{"filename": fname, "subfolder": sub, "type": "output"}]}, "result": (text,)}


NODE_CLASS_MAPPINGS = {"DeckTAPNextTrack": DeckTAPNextTrack}
NODE_DISPLAY_NAME_MAPPINGS = {"DeckTAPNextTrack": "Deck TAPNext++ Track"}
