"""ComfyChair: GFPGAN on a face crop.

ComfyUI's Upscale Image (using Model) gives a model its picture with the channels moved but not copied. GFPGAN's encoder
then calls .view() on a tensor that isn't contiguous and fails. This node takes the model from the same Load Upscale Model,
with each frame contiguous. It writes no file of its own.
"""
import torch

import comfy.model_management as mm


class DeckFaceRestore:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"upscale_model": ("UPSCALE_MODEL",), "image": ("IMAGE",)}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = "ComfyChair"

    def run(self, upscale_model, image):
        device = upscale_model.patcher.load_device
        mm.load_models_gpu([upscale_model.patcher], force_full_load=True)
        rgb = image[..., :3]
        out = [upscale_model(rgb[i:i + 1].permute(0, 3, 1, 2).contiguous().to(device).float()).clamp(0, 1).permute(0, 2, 3, 1).to(rgb)
               for i in range(rgb.shape[0])]
        return (torch.cat(out),)


NODE_CLASS_MAPPINGS = {"DeckFaceRestore": DeckFaceRestore}
NODE_DISPLAY_NAME_MAPPINGS = {"DeckFaceRestore": "Deck Face Restore"}
