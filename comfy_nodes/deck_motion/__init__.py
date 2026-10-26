"""ComfyDeck: save generated human motion where ComfyDeck finds it.

Deck Save Motion takes HY-Motion's motion data (ComfyUI-HY-Motion1) and writes the first 22 joints per frame
as a JSON file in the output folder, listed as a node output, so ComfyDeck's 3D tab can put it on a figure
(app/motion.py reads it). HY-Motion's own Save NPZ writes a file but doesn't list it as an output.
"""
import json
import os

import folder_paths

HY_FPS = 30.0


class DeckSaveMotion:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"motion_data": ("HYMOTION_DATA",), "filename_prefix": ("STRING", {"default": "deck_motion"})}}

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "ComfyDeck"

    def save(self, motion_data, filename_prefix):
        k3d = motion_data.output_dict["keypoints3d"]
        out_dir = folder_paths.get_output_directory()
        files = []
        for i in range(motion_data.batch_size):
            pts = k3d[i]
            pts = pts.cpu().numpy() if hasattr(pts, "cpu") else pts
            data = {"fps": HY_FPS, "frames": [[[round(float(c), 4) for c in p] for p in f[:22]] for f in pts],
                    "text": str(getattr(motion_data, "text", "") or ""), "source": "hy-motion"}
            folder, name, counter, sub, _ = folder_paths.get_save_image_path(filename_prefix, out_dir)
            fname = f"{name}_{counter:05}_.json"
            with open(os.path.join(folder, fname), "w") as f:
                json.dump(data, f, separators=(",", ":"))
            files.append({"filename": fname, "subfolder": sub, "type": "output"})
        return {"ui": {"files": files}}


NODE_CLASS_MAPPINGS = {"DeckSaveMotion": DeckSaveMotion}
NODE_DISPLAY_NAME_MAPPINGS = {"DeckSaveMotion": "Deck Save Motion"}
