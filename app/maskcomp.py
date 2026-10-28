"""Masked edits: paint over the picture where it may change, and keep the rest exactly as it was.

An image template's first picture gets a Mask setting (a pseudo field "<node>.__mask", kind "mask"). Its value is
{name, feather, grow, fit, box, …}: name is a white-on-black PNG painted over the picture as cropped (white =
change). At generate time:
- every saved image is put back onto the original: the picture, scaled to the output's size (centre crop, as
  editsize does), is the destination, the generated image the source, and the mask, scaled to the output, grown and
  softened, says where the generated pixels are used. Core ComfyUI nodes only.
- a mask input of the template's own (a LoadImageMask, or a picture whose group or label says mask / inpaint) gets
  the mask too.
- fit ("Crop to mask", templates with an editsize Size only): the model sees only a box around the mask, at the
  template's size, and the result is scaled back into that box on the full picture (more detail for a small area).
The extra settings ride on the value, so tabs, shots and Replay & edit keep them like any other value.
"""
import math
import re

from .accel import _is_link
from . import editsize

MASK = "__mask"
IMAGE_OUT = {"SaveImage", "PreviewImage"}
MASK_WORDS = re.compile(r"mask|inpaint", re.I)
BLUR_MAX = 31          # ImageBlur's largest radius; softer edges blur a smaller copy
FIT_MARGIN = 0.35      # crop to mask: room around the mask, a share of its larger side
FIT_MIN = 128          # … and at least this many picture pixels on each side
FIT_SKIP = 0.8         # a box this much of the picture (by area) gains nothing: run on the whole picture


def is_mask_input(wf: dict, f: dict) -> bool:
    """A picture field that is itself a mask (it takes the mask, it doesn't get one)."""
    return f["kind"] == "image" and (wf.get(f["node"], {}).get("class_type") == "LoadImageMask"
                                     or bool(MASK_WORDS.search(f"{f.get('group', '')} {f.get('label', '')}")))


def _saves_images(wf: dict) -> bool:
    classes = {n.get("class_type", "") for n in wf.values()}
    from .templates import media_kind   # (templates imports this module)
    return media_kind(wf) == "image" and bool(classes & IMAGE_OUT)


def _mask_nodes(wf: dict) -> list[str]:
    return [k for k, n in wf.items() if n.get("class_type") == "LoadImageMask"]


def fields(wf: dict, template_fields: list[dict]) -> list[dict]:
    """The Mask setting for the template's first picture: on image templates (composited back), and on any template
    with a mask input of its own (it gets the mask)."""
    takes = any(is_mask_input(wf, f) for f in template_fields) or bool(_mask_nodes(wf))
    composite = _saves_images(wf)
    if not (takes or composite):
        return []
    first = next((f for f in template_fields if f["kind"] == "image" and not is_mask_input(wf, f)), None)
    if not first:
        return []
    fit = composite and any(f["key"] == editsize.WIDTH for f in template_fields)
    return [{"key": f"{first['node']}.{MASK}", "node": first["node"], "input": MASK, "kind": "mask", "label": "Mask",
             "value": None, "group": first["group"], "image_key": first["key"], "composite": composite,
             "takes": takes, "fit": fit}]


def mask_of(values: dict, f: dict) -> dict | None:
    v = values.get(f["key"])
    return v if isinstance(v, dict) and isinstance(v.get("name"), str) and v["name"] else None


def prefill(values: dict, template_fields: list[dict], wf: dict) -> dict:
    """Before apply(): an empty mask picture of the template's own takes the mask (left empty it would be dropped)."""
    for mf in (f for f in template_fields if f["kind"] == "mask"):
        m = mask_of(values, mf)
        if not m or not values.get(mf["image_key"]):
            continue
        for f in template_fields:
            if is_mask_input(wf, f) and not values.get(f["key"]):
                values[f["key"]] = m["name"]
    return values


def _num(v, lo, hi, default=0):
    try:
        return max(lo, min(hi, int(round(float(v)))))
    except (TypeError, ValueError):
        return default


class _Graph:
    """Adds nodes to a workflow under fresh numeric ids."""
    def __init__(self, wf):
        self.wf = wf
        self.next = max((int(k) for k in wf if k.isdigit()), default=0) + 1

    def add(self, cls, title, **inputs) -> list:
        nid = str(self.next)
        self.next += 1
        self.wf[nid] = {"class_type": cls, "inputs": inputs, "_meta": {"title": f"Mask: {title}"}}
        return [nid, 0]


def _soften(g: _Graph, mask_img: list, w, h, grow: int, feather: int) -> list:
    """A mask picture (IMAGE, white = change) at w×h -> the MASK the composite uses: grown, then blurred."""
    m = g.add("ImageToMask", "as a mask", image=mask_img, channel="red")
    if grow:
        m = g.add("GrowMask", f"grow {grow} px", mask=m, expand=grow, tapered_corners=True)
    if feather:
        img = g.add("MaskToImage", "to blur", mask=m)
        k = math.ceil(feather / BLUR_MAX)   # past ImageBlur's radius: blur a copy 1/k the size, then scale back
        if k > 1:
            img = g.add("ImageScaleBy", "smaller to blur", image=img, upscale_method="area", scale_by=round(1 / k, 4))
        img = g.add("ImageBlur", f"soft edge {feather} px", image=img, blur_radius=max(1, round(feather / k)), sigma=0.4)
        if k > 1:
            img = g.add("ImageScale", "back to size", image=img, upscale_method="bilinear", width=w, height=h, crop="disabled")
        m = g.add("ImageToMask", "softened", image=img, channel="red")
    return m


def fit_box(box: dict, W: int, H: int, aspect: float, extra: int = 0) -> dict | None:
    """Crop to mask: the box (fractions of the W×H picture) with room around it, widened to the output's aspect and
    kept inside the picture, in whole pixels ({x, y, w, h}). None when it would be most of the picture anyway."""
    try:
        bx, by, bw, bh = (float(box[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        return None
    if bw <= 0 or bh <= 0 or not W or not H or not aspect:
        return None
    cx, cy = (bx + bw / 2) * W, (by + bh / 2) * H
    pad = max(FIT_MIN, FIT_MARGIN * max(bw * W, bh * H)) + extra
    w, h = bw * W + 2 * pad, bh * H + 2 * pad
    if w / h < aspect:
        w = h * aspect
    else:
        h = w / aspect
    if w > W:
        w, h = W, W / aspect
    if h > H:
        w, h = H * aspect, H
    w, h = max(8, round(w)), max(8, round(h))
    if w * h >= FIT_SKIP * W * H:
        return None
    x = min(max(0, round(cx - w / 2)), W - w)
    y = min(max(0, round(cy - h / 2)), H - h)
    return {"x": x, "y": y, "w": w, "h": h}


def _relink(wf: dict, old: list, new: list, keep: set):
    for nid, node in wf.items():
        if nid in keep:
            continue
        for k, v in node["inputs"].items():
            if _is_link(v) and v[0] == old[0] and v[1] == old[1]:
                node["inputs"][k] = list(new)


def inject(wf: dict, values: dict, template_fields: list[dict], dims: tuple[int, int] | None = None) -> dict:
    """Run after apply / editsize: feed the template's own mask nodes and put every saved image back onto the
    original through the mask. dims: the picture's size in pixels (needed for Crop to mask)."""
    mf = next((f for f in template_fields if f["kind"] == "mask"), None)
    m = mask_of(values, mf) if mf else None
    src = mf and mf["node"]
    if not m or src not in wf:   # no mask, or no picture this run (its node was dropped)
        return wf
    for k in _mask_nodes(wf):    # a LoadImageMask of the template's own reads the painted mask's red channel
        wf[k]["inputs"].update(image=m["name"], channel="red")
    if not mf.get("composite"):
        return wf

    saves = [node for node in wf.values() if node.get("class_type") in IMAGE_OUT and _is_link(node["inputs"].get("images"))]
    if not saves:
        return wf
    g = _Graph(wf)
    grow, feather = _num(m.get("grow"), 0, 256), _num(m.get("feather"), 0, 256)
    region = None
    if m.get("fit") and mf.get("fit") and dims and values.get(editsize.WIDTH) and values.get(editsize.HEIGHT):
        region = fit_box(m.get("box") or {}, dims[0], dims[1],
                         float(values[editsize.WIDTH]) / float(values[editsize.HEIGHT]), grow + feather)
    if region:   # the model sees the box only (editsize then scales it to the template's size)
        crop = g.add("ImageCrop", "the box around the mask", image=[src, 0], width=region["w"], height=region["h"],
                     x=region["x"], y=region["y"])
        _relink(wf, [src, 0], crop, keep={crop[0]})
        for k in _mask_nodes(wf):   # the template's own mask, cut the same way
            cm = g.add("CropMask", "the box around the mask", mask=[k, 0], x=region["x"], y=region["y"],
                       width=region["w"], height=region["h"])
            _relink(wf, [k, 0], cm, keep={cm[0]})
    mask_load = g.add("LoadImage", "the painted mask", image=m["name"])

    done = {}
    for node in saves:
        gen = node["inputs"]["images"]
        key = tuple(gen)
        if key not in done:
            size = g.add("GetImageSize", "the output's size", image=list(gen))
            n = [size[0], 2]
            if region:   # the result scaled into the box, on the whole picture
                W, H = dims
                piece = g.add("ImageScale", "result to the box", image=list(gen), upscale_method="lanczos",
                              width=region["w"], height=region["h"], crop="disabled")
                dest = g.add("RepeatImageBatch", "one per result", image=[src, 0], amount=n)
                mimg = g.add("ImageScale", "mask to the picture", image=mask_load, upscale_method="bilinear",
                             width=W, height=H, crop="center")
                mimg = g.add("ImageCrop", "mask in the box", image=mimg, width=region["w"], height=region["h"],
                             x=region["x"], y=region["y"])
                mask = _soften(g, mimg, region["w"], region["h"], grow, feather)
                out = g.add("ImageCompositeMasked", "result into the picture", destination=dest, source=piece,
                            x=region["x"], y=region["y"], resize_source=False, mask=mask)
            else:        # the picture at the output's size, the result over it where the mask is
                w, h = [size[0], 0], [size[0], 1]
                orig = g.add("ImageScale", "picture to the output's size", image=[src, 0], upscale_method="lanczos",
                             width=w, height=h, crop="center")
                dest = g.add("RepeatImageBatch", "one per result", image=orig, amount=n)
                mimg = g.add("ImageScale", "mask to the output's size", image=mask_load, upscale_method="bilinear",
                             width=w, height=h, crop="center")
                mask = _soften(g, mimg, w, h, grow, feather)
                out = g.add("ImageCompositeMasked", "result over the picture", destination=dest, source=list(gen),
                            x=0, y=0, resize_source=False, mask=mask)
            done[key] = out
        node["inputs"]["images"] = list(done[key])
    return wf
