"""ComfyDeck: follow a face through a clip, crop it square, and put a re-rendered crop back.

Deck Face Crop takes the clip and a mask that marks the face on each frame (DWPose face points are enough: only
their extent is used). Frames without a face hold or interpolate the box of their neighbours, the square has one
size for the whole clip (the largest face times Scale), its centre is smoothed both ways in time, and the frame is
padded at the edges, so every crop is full and the same size. Deck Face Uncrop pastes processed crops back through
a soft outline of each frame's face (the hull of its face points plus the forehead; an ellipse when there are no
points), so the neck, collar, hair and background stay the original footage.
"""
import cv2
import numpy as np
import torch
import torch.nn.functional as F


def _boxes(mask):
    out = []
    for m in mask:
        ys, xs = torch.nonzero(m > 0.5, as_tuple=True)
        if len(xs) == 0:
            out.append(None)
            continue
        x0, x1, y0, y1 = xs.min().item(), xs.max().item(), ys.min().item(), ys.max().item()
        out.append(((x0 + x1) / 2, (y0 + y1) / 2, max(x1 - x0, y1 - y0) + 1, x1 - x0 + 1, y1 - y0 + 1))
    return out


def _fill(boxes):
    """Frames without a face: linear between the nearest found frames, held at the ends."""
    known = [i for i, b in enumerate(boxes) if b is not None]
    if not known:
        raise ValueError("Deck Face Crop: no face found in any frame")
    out = list(boxes)
    for i in range(len(out)):
        if out[i] is not None:
            continue
        prev = max((k for k in known if k < i), default=None)
        nxt = min((k for k in known if k > i), default=None)
        if prev is None or nxt is None:
            out[i] = boxes[prev if nxt is None else nxt]
        else:
            t = (i - prev) / (nxt - prev)
            out[i] = tuple(a + (b - a) * t for a, b in zip(boxes[prev], boxes[nxt]))
    return out


def _hulls(mask, boxes):
    """Each frame's convex hull of the face pixels (full-frame x, y); frames without a face borrow the nearest
    found frame's hull, moved by the difference in box centres."""
    out = []
    for m in mask:
        ys, xs = torch.nonzero(m > 0.5, as_tuple=True)
        pts = torch.stack([xs, ys], 1).numpy().astype(np.int32) if len(xs) else None
        out.append(None if pts is None else cv2.convexHull(pts)[:, 0].astype(np.float32))
    known = [i for i, h in enumerate(out) if h is not None]
    for i in range(len(out)):
        if out[i] is None and known:
            k = min(known, key=lambda k: abs(k - i))
            out[i] = out[k] + np.float32([boxes[i][0] - boxes[k][0], boxes[i][1] - boxes[k][1]])
    return out


def _smooth(vals, alpha):
    """Zero-lag smoothing: an exponential average run forwards and then backwards."""
    if alpha <= 0 or len(vals) < 2:
        return vals
    fw = [vals[0]]
    for v in vals[1:]:
        fw.append(alpha * fw[-1] + (1 - alpha) * v)
    bw = [fw[-1]]
    for v in reversed(fw[:-1]):
        bw.append(alpha * bw[-1] + (1 - alpha) * v)
    return bw[::-1]


class DeckFaceCrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "mask": ("MASK", {"tooltip": "White where the face is, per frame (e.g. DWPose face points as a mask)."}),
            "scale": ("FLOAT", {"default": 1.8, "min": 1.0, "max": 6.0, "step": 0.05,
                                "tooltip": "Square side as a multiple of the largest face: 1.8 takes in the hair and chin."}),
            "size": ("INT", {"default": 512, "min": 64, "max": 2048, "step": 32, "tooltip": "Side of the output crops in pixels."}),
            "smooth": ("FLOAT", {"default": 0.6, "min": 0.0, "max": 0.99, "step": 0.01,
                                 "tooltip": "How steady the crop follows the face (higher = steadier, slower to follow)."}),
        }}

    RETURN_TYPES = ("IMAGE", "DECK_CROP")
    RETURN_NAMES = ("crops", "crop_info")
    FUNCTION = "crop"
    CATEGORY = "ComfyDeck"

    def crop(self, images, mask, scale, size, smooth):
        n, H, W, _ = images.shape
        if mask.dim() == 2:
            mask = mask[None]
        if mask.shape[1:] != (H, W):
            mask = F.interpolate(mask[:, None].float(), size=(H, W), mode="nearest")[:, 0]
        if mask.shape[0] < n:   # one mask for a still, or a short mask clip: repeat the last
            mask = torch.cat([mask, mask[-1:].expand(n - mask.shape[0], H, W)])
        boxes = _fill(_boxes(mask[:n]))
        hulls = _hulls(mask[:n], boxes)
        side = max(8, int(round(max(b[2] for b in boxes) * scale)))
        cx = _smooth([b[0] for b in boxes], smooth)
        cy = _smooth([b[1] for b in boxes], smooth)
        pad = side
        padded = F.pad(images.movedim(-1, 1), (pad, pad, pad, pad), mode="replicate")
        crops, corners = [], []
        for i in range(n):
            x0, y0 = int(round(cx[i] - side / 2)), int(round(cy[i] - side / 2))
            corners.append((x0, y0))
            c = padded[i:i + 1, :, y0 + pad:y0 + pad + side, x0 + pad:x0 + pad + side]
            crops.append(F.interpolate(c, size=(size, size), mode="bicubic", align_corners=False, antialias=True))
        crops = torch.cat(crops).clamp(0, 1).movedim(1, -1)
        # each frame's face (centre and size, smoothed like the crop) for the paste-back ellipse
        faces = list(zip(cx, cy, _smooth([b[3] for b in boxes], smooth), _smooth([b[4] for b in boxes], smooth)))
        return (crops, {"corners": corners, "side": side, "height": H, "width": W, "faces": faces, "hulls": hulls})


class DeckFaceUncrop:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE", {"tooltip": "The original frames the crops came from."}),
            "crops": ("IMAGE", {"tooltip": "The processed crops, any square size."}),
            "crop_info": ("DECK_CROP",),
            "feather": ("FLOAT", {"default": 0.25, "min": 0.01, "max": 1.0, "step": 0.01,
                                  "tooltip": "Soft edge of the blend, as a share of its radius."}),
        }, "optional": {
            "shape": (["face", "oval"], {"default": "face",
                      "tooltip": "face: an ellipse around each frame's face and forehead (keeps neck and collar). oval: the whole crop."}),
            "grow": ("FLOAT", {"default": 1.05, "min": 0.5, "max": 3.0, "step": 0.05, "tooltip": "Size of the face outline."}),
            "chin": ("FLOAT", {"default": 0.82, "min": 0.5, "max": 1.3, "step": 0.01,
                               "tooltip": "Pulls the lower edge up (below 1) or down (above 1): lower it to keep the new face off the neck and collar."}),
        }}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "uncrop"
    CATEGORY = "ComfyDeck"

    def uncrop(self, images, crops, crop_info, feather, shape="face", grow=1.05, chin=0.82):
        side, pad = crop_info["side"], crop_info["side"]
        n = min(images.shape[0], crops.shape[0], len(crop_info["corners"]))
        H, W = images.shape[1:3]
        back = F.interpolate(crops[:n].movedim(-1, 1), size=(side, side), mode="bicubic", align_corners=False,
                             antialias=True).clamp(0, 1)
        g = torch.arange(side, dtype=torch.float32) + 0.5
        faces = crop_info.get("faces") if shape == "face" else None

        def ellipse(cx, cy, rx, ry):
            d = torch.sqrt(((g[None, :] - cx) / rx) ** 2 + ((g[:, None] - cy) / ry) ** 2)
            return ((1 - d) / feather).clamp(0, 1)[None, None].to(back)

        def outline(h, x0, y0):
            """A face hull with the forehead added, sized by grow and chin, filled in this crop's coordinates."""
            x_lo, y_lo = h.min(0)
            x_hi, y_hi = h.max(0)
            c = np.float32([(x_lo + x_hi) / 2, (y_lo + y_hi) / 2])
            fh = y_hi - y_lo + 1
            pts = np.concatenate([h, h[h[:, 1] < c[1]] - np.float32([0, 0.3 * fh])])
            pts = c + (pts - c) * grow
            below = pts[:, 1] > c[1]
            pts[below, 1] = c[1] + (pts[below, 1] - c[1]) * chin
            pts = cv2.convexHull(((pts - np.float32([x0, y0])) * 16).round().astype(np.int32))
            m = np.zeros((side, side), np.float32)
            cv2.fillConvexPoly(m, pts, 1.0, lineType=cv2.LINE_AA, shift=4)
            return cv2.GaussianBlur(m, (0, 0), max(0.5, 0.15 * feather * fh))

        hulls = crop_info.get("hulls") if shape == "face" else None
        oval = ellipse(side / 2, side / 2, side / 2, side / 2)
        canvas = F.pad(images[:n].movedim(-1, 1), (pad, pad, pad, pad), mode="replicate")
        for i, (x0, y0) in enumerate(crop_info["corners"][:n]):
            if hulls:   # this frame's outline averaged with its neighbours', so the edge doesn't jitter
                near = [hulls[j] for j in (i - 1, i, i + 1) if 0 <= j < len(hulls) and hulls[j] is not None]
                alpha = torch.from_numpy(sum(outline(h, x0, y0) for h in near) / len(near))[None, None].to(back) * oval
            elif faces:   # face points run brow to chin: reach up for the forehead, keep clear of the neck
                fx, fy, fw, fh = faces[i]
                alpha = ellipse(fx - x0, fy - y0 - 0.12 * fh, 0.5 * fw * grow, 0.62 * fh * grow) * oval
            else:
                alpha = oval
            ys, xs = slice(y0 + pad, y0 + pad + side), slice(x0 + pad, x0 + pad + side)
            canvas[i:i + 1, :, ys, xs] = back[i:i + 1] * alpha + canvas[i:i + 1, :, ys, xs] * (1 - alpha)
        return (canvas[:, :, pad:pad + H, pad:pad + W].movedim(1, -1),)


NODE_CLASS_MAPPINGS = {"DeckFaceCrop": DeckFaceCrop, "DeckFaceUncrop": DeckFaceUncrop}
NODE_DISPLAY_NAME_MAPPINGS = {"DeckFaceCrop": "Deck Face Crop", "DeckFaceUncrop": "Deck Face Uncrop"}
