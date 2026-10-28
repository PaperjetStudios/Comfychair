"""Remove watermark (the VFX tab's Quick effect, POST /api/video/delogo): boxes drawn over a logo, a caption or a
burned-in mark are painted out.

Quality runs ProPainter (ComfyUI_ProPainter_Nodes) in ComfyUI: it fills each box from what the other frames show
there (flow propagation), and invents only what no frame shows. It doesn't see the whole frame: boxes close together
share a crop with some picture around them, the crop runs at the clip's own resolution (smaller only when it is very
big), and only the boxes, grown a little, are pasted back, so the rest of each frame is the clip's own pixels.
Fast is ffmpeg's delogo: instant, a smooth smear from the box's edges. Find (find_boxes) guesses where a mark is: the
parts of the picture whose edges stay put while the rest changes."""
import subprocess
from pathlib import Path

import numpy as np

from . import videoedit

PAD = 6               # px the pasted-back box reaches past the drawn one (and ProPainter's own mask grows by)
MAX_AREA = 960 * 540  # a crop bigger than this many pixels runs scaled down (ProPainter's memory grows with it)


def boxes_px(boxes: list[dict], W: int, H: int) -> list[tuple[int, int, int, int]]:
    """Boxes as fractions of the frame ({x, y, w, h}) -> (x0, y0, x1, y1) pixel rects inside it, dropping empty ones."""
    out = []
    for b in boxes or []:
        try:
            x, y, w, h = (float(b[k]) for k in ("x", "y", "w", "h"))
        except (KeyError, TypeError, ValueError):
            raise ValueError("A box needs x, y, w and h")
        x0, y0 = max(0, int(x * W)), max(0, int(y * H))
        x1, y1 = min(W, int(round((x + w) * W))), min(H, int(round((y + h) * H)))
        if x1 - x0 >= 2 and y1 - y0 >= 2:
            out.append((x0, y0, x1, y1))
    return out


def _context(r, W, H):
    """A rect grown by the picture ProPainter should see around it, on the 8 px grid it works on."""
    m = max(64, int(0.75 * max(r[2] - r[0], r[3] - r[1])))
    out = []
    for lo, hi, size in ((r[0], r[2], W), (r[1], r[3], H)):
        a, b = max(0, lo - m), min(size, hi + m)
        n = (b - a) // 8 * 8
        out.append((a, a + n) if a + n >= hi else (b - n, b))   # trimmed to the grid on the side that keeps the box
    (x0, x1), (y0, y1) = out
    return x0, y0, x1, y1


def regions(rects, W: int, H: int) -> list[dict]:
    """The crops ProPainter runs on: boxes whose surroundings overlap share one. Each is {x, y, w, h (the crop), pw, ph
    (the size it runs at: the crop's, or smaller to stay under MAX_AREA, multiples of 8), boxes: [(x0, y0, x1, y1) in
    the crop, grown by PAD]}."""
    groups = [[r, _context(r, W, H)] for r in rects]
    merged = True
    while merged:   # join any two groups whose crops overlap, until none do
        merged = False
        for i in range(len(groups)):
            for j in range(i + 1, len(groups)):
                a, b = groups[i][-1], groups[j][-1]
                if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                    rs = groups[i][:-1] + groups[j][:-1]
                    box = (min(r[0] for r in rs), min(r[1] for r in rs), max(r[2] for r in rs), max(r[3] for r in rs))
                    groups[i] = rs + [_context(box, W, H)]
                    del groups[j]
                    merged = True
                    break
            if merged:
                break
    out = []
    for g in groups:
        x0, y0, x1, y1 = g[-1]
        w, h = x1 - x0, y1 - y0
        k = min(1.0, (MAX_AREA / (w * h)) ** 0.5)
        pw, ph = max(8, int(w * k) // 8 * 8), max(8, int(h * k) // 8 * 8)
        bx = [(max(0, r[0] - PAD - x0), max(0, r[1] - PAD - y0), min(w, r[2] + PAD - x0), min(h, r[3] + PAD - y0)) for r in g[:-1]]
        out.append({"x": x0, "y": y0, "w": w, "h": h, "pw": pw, "ph": ph, "boxes": bx})
    return sorted(out, key=lambda r: (r["y"], r["x"]))


def build(video: str, W: int, H: int, fps: float, frames: int, rects, prefix: str, audio: bool = True) -> dict:
    """The ComfyUI workflow: the clip, then for each region its crop painted by ProPainter, scaled back to the crop's
    size and pasted over the frames through a mask of its boxes. Sound is the clip's own (audio: it has some; the
    loader fails on a silent clip when its sound is wired)."""
    wf = {}

    def add(nid, cls, title=None, **inputs):
        wf[nid] = {"class_type": cls, "inputs": inputs, **({"_meta": {"title": title}} if title else {})}
        return [nid, 0]

    add("src", "VHS_LoadVideoPath", "The clip", video=video, force_rate=0, custom_width=0, custom_height=0,
        frame_load_cap=frames, skip_first_frames=0, select_every_nth=1)
    frames_in = ["src", 0]
    for i, r in enumerate(regions(rects, W, H)):
        mask = add(f"m{i}", "SolidMask", value=0.0, width=r["w"], height=r["h"])
        for j, (x0, y0, x1, y1) in enumerate(r["boxes"]):
            box = add(f"m{i}b{j}", "SolidMask", value=1.0, width=x1 - x0, height=y1 - y0)
            mask = add(f"m{i}c{j}", "MaskComposite", destination=mask, source=box, x=x0, y=y0, operation="add")
        crop = add(f"crop{i}", "ImageCrop", f"Region {i + 1}: {r['w']}×{r['h']} at {r['x']},{r['y']}",
                   image=["src", 0], width=r["w"], height=r["h"], x=r["x"], y=r["y"])
        # the frames go in at the size it runs at, so the mask (made at the crop's size) is scaled the same way
        small = add(f"small{i}", "ImageScale", image=crop, upscale_method="area", width=r["pw"], height=r["ph"], crop="disabled")
        pmask = mask if (r["pw"], r["ph"]) == (r["w"], r["h"]) else add(
            f"pm{i}", "ImageToMask", channel="red",
            image=add(f"pmi{i}", "ImageScale", image=add(f"mi{i}", "MaskToImage", mask=mask), upscale_method="bilinear",
                      width=r["pw"], height=r["ph"], crop="disabled"))
        paint = add(f"pp{i}", "ProPainterInpaint", "ProPainter", image=small, mask=pmask, width=r["pw"], height=r["ph"],
                    mask_dilates=PAD // 2, flow_mask_dilates=8, ref_stride=10, neighbor_length=10, subvideo_length=80,
                    raft_iter=20, fp16="enable")
        back = add(f"up{i}", "ImageScale", image=paint, upscale_method="lanczos", width=r["w"], height=r["h"], crop="disabled")
        frames_in = add(f"paste{i}", "ImageCompositeMasked", destination=frames_in, source=back, x=r["x"], y=r["y"],
                        resize_source=False, mask=mask)
    add("save", "VHS_VideoCombine", images=frames_in, **({"audio": ["src", 2]} if audio else {}), frame_rate=fps, loop_count=0, filename_prefix=prefix,
        format="video/h264-mp4", pix_fmt="yuv420p", crf=17, save_metadata=True, trim_to_audio=False, pingpong=False,
        save_output=True)
    return wf


def fast(src: Path, out: Path, rects) -> dict:
    """ffmpeg's delogo over each box (it needs a pixel of picture all round, so boxes stop 1 px short of the edges)."""
    info = videoedit.probe(src)
    W, H = info["width"], info["height"]
    parts = []
    for x0, y0, x1, y1 in rects:
        x0, y0, x1, y1 = max(1, x0), max(1, y0), min(W - 2, x1), min(H - 2, y1)
        if x1 - x0 >= 2 and y1 - y0 >= 2:
            parts.append(f"delogo=x={x0}:y={y0}:w={x1 - x0}:h={y1 - y0}")
    if not parts:
        raise ValueError("Draw a box over the watermark first")
    args = ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-vf", ",".join(parts) + ",format=yuv420p",
            *videoedit.h264(17), "-c:a", "copy", str(out)]
    r = videoedit.run_ffmpeg(args, timeout=3600)
    videoedit.check(r)
    return videoedit.probe(out)


def _frames(src: Path, info: dict, n: int = 32, width: int = 256) -> np.ndarray:
    """n grey frames spread over the clip, width px across: (n, h, width) floats 0..1."""
    h = max(2, int(round(width * info["height"] / max(1, info["width"]) / 2)) * 2)
    rate = n / max(0.5, info["duration"])
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", str(src), "-vf", f"fps={rate:.4f},scale={width}:{h},format=gray",
                        "-frames:v", str(n), "-f", "rawvideo", "-"], capture_output=True, timeout=300, check=True)
    a = np.frombuffer(r.stdout, np.uint8)
    return a[: a.size // (width * h) * width * h].reshape(-1, h, width).astype(np.float32) / 255


def _label(mask: np.ndarray) -> list[tuple[int, int, int, int, int]]:
    """The connected blobs of a boolean grid (8-neighbour) as (x0, y0, x1, y1, cells)."""
    seen = np.zeros_like(mask, bool)
    out = []
    H, W = mask.shape
    for y, x in zip(*np.nonzero(mask)):
        if seen[y, x]:
            continue
        stack, xs, ys = [(y, x)], [], []
        seen[y, x] = True
        while stack:
            cy, cx = stack.pop()
            xs.append(cx); ys.append(cy)
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
        out.append((min(xs), min(ys), max(xs) + 1, max(ys) + 1, len(xs)))
    return out


def find_boxes(src: Path, max_boxes: int = 4) -> list[dict]:
    """Where a watermark probably is, as boxes in fractions of the frame (best first; none when the whole picture
    holds still, as on a locked-off shot, since then everything looks stuck on). A mark keeps sharp edges in the
    same place on every frame while the picture under it changes."""
    info = videoedit.probe(src)
    f = _frames(src, info)
    if len(f) < 4:
        return []
    gy, gx = np.abs(np.diff(f, axis=1))[:, :, :-1], np.abs(np.diff(f, axis=2))[:, :-1, :]
    edge = gx + gy
    steady = np.percentile(edge, 15, axis=0)          # edges there on (nearly) every frame
    moving = f[:, :-1, :-1].std(axis=0)               # how much the picture changes there
    if np.median(moving) < 0.02:                      # a still shot: nothing to tell a mark apart from
        return []
    cell = 8                                          # look at 8×8 px cells of the small frames
    Hc, Wc = steady.shape[0] // cell, steady.shape[1] // cell
    s = steady[: Hc * cell, : Wc * cell].reshape(Hc, cell, Wc, cell).mean(axis=(1, 3))
    around = np.median(moving)
    m = moving[: Hc * cell, : Wc * cell].reshape(Hc, cell, Wc, cell).mean(axis=(1, 3))
    hot = (s > max(0.04, np.percentile(s, 97))) & (m < around * 1.5 + 0.05)
    if hot.mean() > 0.3:
        return []
    blobs = [b for b in _label(hot) if b[4] >= 2 and (b[2] - b[0]) * (b[3] - b[1]) < 0.25 * Hc * Wc]
    blobs.sort(key=lambda b: -b[4])
    pad = 0.5   # half a cell of room round each blob
    return [{"x": round(max(0, b[0] - pad) / Wc, 4), "y": round(max(0, b[1] - pad) / Hc, 4),
             "w": round((min(Wc, b[2] + pad) - max(0, b[0] - pad)) / Wc, 4),
             "h": round((min(Hc, b[3] + pad) - max(0, b[1] - pad)) / Hc, 4)} for b in blobs[:max_boxes]]
