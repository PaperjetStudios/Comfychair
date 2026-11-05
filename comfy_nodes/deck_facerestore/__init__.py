"""ComfyChair: GFPGAN on faces.

ComfyUI's Upscale Image (using Model) gives a model its picture with the channels moved but not copied. GFPGAN's encoder
then calls .view() on a tensor that isn't contiguous and fails. This node takes the model from the same Load Upscale Model,
with each frame contiguous. It writes no file of its own.

GFPGAN only takes a 512x512 picture of one face. A picture that size is taken to be that (Restore cuts its faces that way). Any
other goes by the optional mask of face points (DWPose): each separate face is cut out square with room round it, drawn at 512x512
and laid back through a soft oval, as Restore does (web/photo-restore.js faceBox, web/imagetools.js redrawFaces).
"""
import numpy as np
import torch
import torch.nn.functional as F

SIDE = 512
ROOM = 1.6   # the square round a face, as a multiple of its size
MIN_FACE = 24


def face_boxes(mask, width, height):
    """The square (x, y, side) round each separate face in a 2D bool array, largest first. Points closer than a face's size are one face."""
    import cv2
    pts = np.argwhere(mask)
    if not len(pts):
        return []
    # join a face's points: a closing wide enough to bridge them, scaled to the picture
    k = max(3, round(max(width, height) / 40)) | 1
    joined = cv2.dilate(mask.astype(np.uint8), np.ones((k, k), np.uint8))
    n, _, stats, _ = cv2.connectedComponentsWithStats(joined, connectivity=8)
    out = []
    for i in range(1, n):
        x, y, w, h = stats[i][:4]
        size = max(w - k + 1, h - k + 1)   # (without what the join added)
        if size < MIN_FACE:
            continue
        side = min(width, height, round(size * ROOM))
        out.append((int(max(0, min(width - side, round(x + w / 2 - side / 2)))), int(max(0, min(height - side, round(y + h / 2 - side / 2)))), int(side)))
    return sorted(out, key=lambda b: -b[2])


def soft_oval(side, device=None):
    """1 in the middle, fading to 0 at the square's edge: from 68% to 98% of the radius."""
    c = (torch.arange(side, device=device, dtype=torch.float32) + 0.5) / side * 2 - 1
    r = torch.sqrt(c[None, :] ** 2 + c[:, None] ** 2)
    return (1 - (r - 0.68) / 0.30).clamp(0, 1)


def _resized(x, h, w):
    return F.interpolate(x, size=(h, w), mode="bicubic", antialias=True, align_corners=False).clamp(0, 1)


def restore_frame(rgb, model, mask=None, device="cpu"):
    """rgb: 1×H×W×3. model: 1×3×512×512 → 1×3×512×512."""
    h, w = rgb.shape[1:3]
    x = rgb.permute(0, 3, 1, 2).contiguous().to(device).float()
    if h == SIDE and w == SIDE:
        return model(x).clamp(0, 1).permute(0, 2, 3, 1).to(rgb)
    boxes = face_boxes(mask.cpu().numpy() > 0.5, w, h) if mask is not None else []
    if not boxes:
        raise ValueError("Deck Face Restore: no face found in this picture")
    out = x.clone()
    for bx, by, side in boxes:
        made = _resized(model(_resized(x[:, :, by:by + side, bx:bx + side], SIDE, SIDE)).clamp(0, 1), side, side)
        a = soft_oval(side, made.device)
        out[:, :, by:by + side, bx:bx + side] = out[:, :, by:by + side, bx:bx + side] * (1 - a) + made * a
    return out.permute(0, 2, 3, 1).to(rgb)


class DeckFaceRestore:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"upscale_model": ("UPSCALE_MODEL",), "image": ("IMAGE",)},
                "optional": {"mask": ("MASK", {"lazy": True, "tooltip": "Marks the faces in a picture that isn't already a 512x512 face"})}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "run"
    CATEGORY = "ComfyChair"

    def check_lazy_status(self, upscale_model=None, image=None, mask=None):   # (Restore's own face crops skip the pose detector)
        return [] if image is None or image.shape[1:3] == (SIDE, SIDE) or mask is not None else ["mask"]

    def run(self, upscale_model, image, mask=None):
        import comfy.model_management as mm
        device = upscale_model.patcher.load_device
        mm.load_models_gpu([upscale_model.patcher], force_full_load=True)
        rgb = image[..., :3]
        masks = [None] * len(rgb) if mask is None else [mask[min(i, len(mask) - 1)] for i in range(len(rgb))]
        return (torch.cat([restore_frame(rgb[i:i + 1], upscale_model, masks[i], device) for i in range(len(rgb))]),)


NODE_CLASS_MAPPINGS = {"DeckFaceRestore": DeckFaceRestore}
NODE_DISPLAY_NAME_MAPPINGS = {"DeckFaceRestore": "Deck Face Restore"}
