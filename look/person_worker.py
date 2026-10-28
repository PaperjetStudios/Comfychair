"""ComfyChair: the people in a picture, as tight boxes, for "Calibrate from a person" in the 3D tab (a photo's mesh
or splat scaled so a person in it is a real height). Run once per picture by app/sceneasset.py in ComfyUI's venv
(it has onnxruntime and PIL), on the CPU, with DWPose's YOLOX-L person detector (comfyui_controlnet_aux's ckpts).

  person_worker.py <picture> <yolox_l.onnx> [--threads 4]
  -> one JSON line: {"w": px, "h": px, "people": [[x0, y0, x1, y1, score], ...]}  (fractions; the tallest first)

The decoding is look/clip_worker.py's People without its padding and its size limit (that one crops for a look check;
this one wants the person's top and bottom where they are).
"""
import argparse
import json
import sys

import numpy as np
from PIL import Image

MIN_SCORE = 0.35


def _iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-6)


def people(im, det, threads=4):
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    s = ort.InferenceSession(det, so, providers=["CPUExecutionProvider"])
    a = np.asarray(im.convert("RGB"))[:, :, ::-1]   # (YOLOX was trained on BGR)
    h, w = a.shape[:2]
    r = min(640 / h, 640 / w)
    pad = np.full((640, 640, 3), 114, np.uint8)
    pad[:int(h * r), :int(w * r)] = np.asarray(Image.fromarray(np.ascontiguousarray(a)).resize((int(w * r), int(h * r)), Image.BILINEAR))
    out = s.run(None, {s.get_inputs()[0].name: pad.transpose(2, 0, 1)[None].astype(np.float32)})[0][0]
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
    keep = score > MIN_SCORE
    xy, wh, score = xy[keep], wh[keep], score[keep]
    boxes = np.concatenate([xy - wh / 2, xy + wh / 2], 1) / r
    picked = []
    for i in score.argsort()[::-1]:   # non-maximum suppression
        if all(_iou(boxes[i], boxes[j]) < 0.45 for j in picked):
            picked.append(i)
    res = []
    for i in picked:
        x0, y0, x1, y1 = boxes[i]
        res.append([round(float(max(0, x0) / w), 5), round(float(max(0, y0) / h), 5),
                    round(float(min(w, x1) / w), 5), round(float(min(h, y1) / h), 5), round(float(score[i]), 3)])
    res.sort(key=lambda b: b[3] - b[1], reverse=True)
    return w, h, res[:8]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("picture")
    ap.add_argument("det")
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    try:
        w, h, ps = people(Image.open(a.picture), a.det, a.threads)
        print(json.dumps({"w": w, "h": h, "people": ps}))
    except Exception as e:   # (one line back either way)
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
