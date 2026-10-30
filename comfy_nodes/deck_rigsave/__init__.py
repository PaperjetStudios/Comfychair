"""ComfyChair: publish a rigged model where ComfyChair finds it.

UniRig and Make It Animatable write a rigged FBX to disk and pass its path along as a string, so the run
reports no file of its own. Deck Save Rig moves that file into the output folder and lists it as an
output, so Use as -> Rig as a person can bring it into the 3D scene (scene-rig.js loads it with the
figure's skeleton driving its bones). What the rigger wrote beside it under the same name (Make It
Animatable's GLB twin and the .fbm texture folder) is deleted: ComfyChair keeps the one copy it collects,
and ComfyUI keeps none (app/storage.py).
"""
import os
import shutil
import uuid

import folder_paths


class DeckSaveRig:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "rig_path": ("STRING", {"default": "", "tooltip": "The rigged FBX (or GLB) an auto-rig node returned"}),
            "filename_prefix": ("STRING", {"default": "deck/rig"}),
        }}

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "ComfyChair"

    def save(self, rig_path, filename_prefix):
        path = str(rig_path or "").strip()
        if path and not os.path.isabs(path):
            path = os.path.join(folder_paths.get_output_directory(), path)
        if not path or not os.path.isfile(path):
            raise FileNotFoundError(f"Deck Save Rig: no file at {path or '(nothing)'}")
        # only a model the auto-rig nodes wrote (ComfyUI's output or temp folder): /view would serve any other file
        real = os.path.realpath(path)
        roots = [os.path.realpath(folder_paths.get_output_directory()), os.path.realpath(folder_paths.get_temp_directory())]
        if not any(os.path.commonpath([real, r]) == r for r in roots):
            raise ValueError("Deck Save Rig: the rig must be in ComfyUI's output or temp folder")
        ext = os.path.splitext(real)[1].lower()
        if ext not in (".fbx", ".glb", ".gltf"):
            raise ValueError(f"Deck Save Rig: {ext or 'no extension'} isn't a rigged model (FBX, GLB or glTF)")
        path = real
        out_dir = folder_paths.get_output_directory()
        folder, name, counter, sub, _ = folder_paths.get_save_image_path(filename_prefix, out_dir)
        os.makedirs(folder, exist_ok=True)
        fname = f"{name}_{counter:05}_{uuid.uuid4().hex[:4]}{ext}"
        shutil.move(path, os.path.join(folder, fname))
        stem, where = os.path.splitext(os.path.basename(path))[0], os.path.dirname(path)
        for other in os.listdir(where):   # (the rigger's twins: same name, another extension, and the texture folder)
            if os.path.splitext(other)[0] == stem or other == stem + ".fbm":
                q = os.path.join(where, other)
                shutil.rmtree(q, ignore_errors=True) if os.path.isdir(q) else os.remove(q)
        return {"ui": {"files": [{"filename": fname, "subfolder": sub, "type": "output"}]}}


NODE_CLASS_MAPPINGS = {"DeckSaveRig": DeckSaveRig}
NODE_DISPLAY_NAME_MAPPINGS = {"DeckSaveRig": "Deck Save Rig"}
