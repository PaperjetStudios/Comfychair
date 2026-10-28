"""ComfyChair look check: picture embeddings with a CLIP image tower, run in ComfyUI's own venv (it has torch,
open_clip, onnxruntime and cv2) on the CPU, so it never takes VRAM from a run. app/looks.py starts it and keeps it
while it's used.

The model is the DFN5B CLIP ViT-H-14 (378 px) that ComfyUI-MMAudio already keeps in models/mmaudio: only its image
tower is loaded, at 224 px by default (the position grid resized; about 1 s a picture on 8 cores, 3x faster than 378).
People in a frame are found with DWPose's YOLOX-L person detector (comfyui_controlnet_aux's ckpts), so a character in
a scene is compared on their own, not with the room around them.

  clip_worker.py <clip.safetensors> [--size 224] [--threads 8] [--det yolox_l.onnx]
One JSON request per stdin line, one JSON reply per stdout line:
  {"images": [{"path": "/abs/a.png", "people": true}, ...]}
  -> {"items": [{"crops": [{"box": null | [x0, y0, x1, y1] (fractions), "vec": [1024 floats]}, ...]}, ...]}
The first crop is the whole picture; with people, one more per person found (up to 4, the largest first).
Vectors are L2-normalised, so a dot product is the cosine similarity.
"""
import argparse
import json
import sys
import time

import numpy as np
import torch
import torch.nn.functional as F
from PIL import Image

CFG = {"embed_dim": 1024, "quick_gelu": True,
       "vision_cfg": {"image_size": 378, "layers": 32, "width": 1280, "head_width": 80, "patch_size": 14}}
MEAN = torch.tensor([0.48145466, 0.4578275, 0.40821073]).view(3, 1, 1)
STD = torch.tensor([0.26862954, 0.26130258, 0.27577711]).view(3, 1, 1)
MAX_PEOPLE = 4


def load(path, size):
    """The image tower at size px (the position grid resized from the trained 378)."""
    from open_clip.model import _build_vision_tower
    from safetensors.torch import load_file
    tower = _build_vision_tower(CFG["embed_dim"], {**CFG["vision_cfg"], "image_size": size}, quick_gelu=True)
    sd = load_file(path)
    vis = {k[len("visual."):]: v.float() for k, v in sd.items() if k.startswith("visual.")}
    g = size // CFG["vision_cfg"]["patch_size"]
    if g != CFG["vision_cfg"]["image_size"] // CFG["vision_cfg"]["patch_size"]:
        pe = vis["positional_embedding"]
        g0 = int(round((pe.shape[0] - 1) ** 0.5))
        grid = pe[1:].reshape(1, g0, g0, -1).permute(0, 3, 1, 2)
        grid = F.interpolate(grid, size=(g, g), mode="bicubic", align_corners=False, antialias=True)
        vis["positional_embedding"] = torch.cat([pe[:1], grid.permute(0, 2, 3, 1).reshape(g * g, -1)])
    tower.load_state_dict(vis)
    return tower.eval()


class People:
    """YOLOX-L (COCO) persons: boxes as fractions of the picture, the largest first."""
    def __init__(self, path, threads):
        import onnxruntime as ort
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        self.s = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])

    def __call__(self, im):
        a = np.asarray(im.convert("RGB"))[:, :, ::-1]   # (YOLOX was trained on BGR)
        h, w = a.shape[:2]
        r = min(640 / h, 640 / w)
        pad = np.full((640, 640, 3), 114, np.uint8)
        pad[:int(h * r), :int(w * r)] = np.asarray(Image.fromarray(a).resize((int(w * r), int(h * r)), Image.BILINEAR))
        out = self.s.run(None, {self.s.get_inputs()[0].name: pad.transpose(2, 0, 1)[None].astype(np.float32)})[0][0]
        grids, strides = [], []
        for st in (8, 16, 32):
            n = 640 // st
            xv, yv = np.meshgrid(np.arange(n), np.arange(n))
            grids.append(np.stack((xv, yv), 2).reshape(-1, 2))
            strides.append(np.full((n * n, 1), st))
        grids, strides = np.concatenate(grids), np.concatenate(strides)
        xy = (out[:, :2] + grids) * strides
        wh = np.exp(out[:, 2:4]) * strides
        score = out[:, 4] * out[:, 5]   # objectness x person
        keep = score > 0.35
        xy, wh, score = xy[keep], wh[keep], score[keep]
        boxes = np.concatenate([xy - wh / 2, xy + wh / 2], 1) / r
        order, picked = score.argsort()[::-1], []
        for i in order:   # non-maximum suppression
            if all(_iou(boxes[i], boxes[j]) < 0.45 for j in picked):
                picked.append(i)
        out = []
        for i in picked:
            x0, y0, x1, y1 = boxes[i]
            bw, bh = x1 - x0, y1 - y0
            if bw * bh < 0.01 * w * h:   # too small to judge a look by
                continue
            x0, x1 = max(0, x0 - 0.08 * bw), min(w, x1 + 0.08 * bw)
            y0, y1 = max(0, y0 - 0.05 * bh), min(h, y1 + 0.05 * bh)
            out.append([float(x0 / w), float(y0 / h), float(x1 / w), float(y1 / h)])
        out.sort(key=lambda b: (b[2] - b[0]) * (b[3] - b[1]), reverse=True)
        return out[:MAX_PEOPLE]


def _iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-6)


def colours(im, box):
    """The crop's colours, as 12 hue bins of its colourful pixels (in its middle, to keep out most of the
    background) plus one bin for the grey ones; fractions that sum to 1."""
    if box:
        w, h = im.size
        im = im.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))
    w, h = im.size
    im = im.crop((int(w * 0.2), int(h * 0.08), int(w * 0.8), int(h * 0.92))).resize((96, 96))
    a = np.asarray(im.convert("HSV")).reshape(-1, 3).astype(np.float32) / 255
    colourful = (a[:, 1] > 0.25) & (a[:, 2] > 0.18)
    hist = np.bincount((a[colourful, 0] * 12).astype(int).clip(0, 11), minlength=12).astype(np.float32)
    out = np.append(hist, (~colourful).sum())
    return [round(float(x), 4) for x in out / out.sum()]


def tensor(im, box, size):
    if box:
        w, h = im.size
        im = im.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))
    # letterboxed onto mid grey, so a tall figure isn't squashed
    w, h = im.size
    s = max(w, h)
    sq = Image.new("RGB", (s, s), (128, 128, 128))
    sq.paste(im, ((s - w) // 2, (s - h) // 2))
    sq = sq.resize((size, size), Image.BICUBIC)
    t = torch.from_numpy(np.asarray(sq).copy()).permute(2, 0, 1).float() / 255
    return (t - MEAN) / STD


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("--size", type=int, default=224)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--det", default="")
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    t0 = time.time()
    model = load(a.model, a.size)
    people = None
    if a.det:
        try:
            people = People(a.det, a.threads)
        except Exception as e:  # noqa: BLE001 (the look check still works on whole pictures)
            print(f"person detector off: {e}", file=sys.stderr)
    print(json.dumps({"ready": True, "load_s": round(time.time() - t0, 2), "people": bool(people)}), flush=True)
    for line in sys.stdin:
        try:
            req = json.loads(line)
            jobs, items = [], []
            for it in req["images"]:
                im = Image.open(it["path"]).convert("RGB")
                boxes = [None] + (people(im) if people and it.get("people") else [])
                items.append([{"box": b, "hist": colours(im, b)} for b in boxes])
                jobs += [(im, b) for b in boxes]
            with torch.inference_mode():
                vecs = []
                for i in range(0, len(jobs), 8):
                    x = torch.stack([tensor(im, b, a.size) for im, b in jobs[i:i + 8]])
                    vecs += F.normalize(model(x), dim=-1).tolist()
            k = 0
            for crops in items:
                for c in crops:
                    c["vec"] = [round(v, 5) for v in vecs[k]]
                    k += 1
            print(json.dumps({"items": [{"crops": c} for c in items]}), flush=True)
        except Exception as e:  # noqa: BLE001 (any failure goes back as a reply)
            print(json.dumps({"error": f"{type(e).__name__}: {e}"}), flush=True)


if __name__ == "__main__":
    main()
