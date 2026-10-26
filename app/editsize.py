"""A Size picker for templates whose output takes its size from the first image (the edit models).

They have no width/height of their own: the latent is made from Image 1, often after rescaling it
to about 1 MP. These templates get a width + height pair on a pseudo node, which the UI shows as
its usual size picker. At generate time Image 1 is centre-cropped and scaled to exactly that size,
and the nodes that would resize it again are told to keep it.
"""
from .accel import _is_link

WIDTH, HEIGHT = "__deck.width", "__deck.height"
# upscalers size their output from the input on purpose: no picker, no crop
UPSCALE_CLASSES = {"SeedVR2Preprocess", "ImageUpscaleWithModel", "ImageUpscaleWithModelBatched"}


def fields(workflow: dict, template_fields: list[dict]) -> list[dict]:
    if any(f["kind"] == "int" and (f.get("input") in ("width", "height") or f.get("label", "").lower() in ("width", "height"))
           for f in template_fields):
        return []
    # templates that size themselves from a Resolution setting (the LTX ones) keep the image as it is
    if any(f["kind"] == "int" and "resolution" in f"{f.get('group', '')} {f.get('label', '')}".lower() for f in template_fields):
        return []
    if any(n.get("class_type") in UPSCALE_CLASSES for n in workflow.values()):
        return []
    first = next((f for f in template_fields if f["kind"] == "image"), None)
    if not first:
        return []
    # Qwen Image 2.1 keeps the reference at its own size rounded to 32; the others take 16
    step = 32 if any(n.get("class_type") == "TextEncodeQwenImage21" for n in workflow.values()) else 16
    common = {"node": "__deck", "kind": "int", "min": 256, "max": 4096, "step": step,
              "group": first["group"], "image_node": first["node"]}
    return [{**common, "key": WIDTH, "input": "width", "label": "Width", "value": 1024, "match_image": True},
            {**common, "key": HEIGHT, "input": "height", "label": "Height", "value": 1024}]


def _relink(wf: dict, old: list, new: list, skip: str | None = None):
    for nid, node in wf.items():
        if nid == skip:
            continue
        for name, v in node["inputs"].items():
            if _is_link(v) and v[0] == old[0] and v[1] == old[1]:
                node["inputs"][name] = list(new)


def inject(wf: dict, values: dict, template_fields: list[dict]) -> dict:
    f = next((f for f in template_fields if f["key"] == WIDTH), None)
    w, h = values.get(WIDTH), values.get(HEIGHT)
    if not f or not w or not h or f["image_node"] not in wf:  # no Image 1 this run: leave it alone
        return wf
    src = f["image_node"]
    nid = str(max((int(k) for k in wf if k.isdigit()), default=0) + 1)
    wf[nid] = {"class_type": "ImageScale", "_meta": {"title": "Size (crop to fit)"},
               "inputs": {"image": [src, 0], "upscale_method": "lanczos", "width": int(w), "height": int(h), "crop": "center"}}
    _relink(wf, [src, 0], [nid, 0], skip=nid)
    for k, node in list(wf.items()):
        cls, ins = node["class_type"], node["inputs"]
        if cls == "ImageScaleToTotalPixels" and ins.get("image") == [nid, 0]:
            _relink(wf, [k, 0], [nid, 0])  # it would rescale to ~1 MP again: skip it
        elif cls == "ReferenceMultiLatent" and ins.get("resolution") == "resize":
            ins["resolution"] = "keep resolution"
            ins.pop("resolution.megapixels", None)
        elif cls == "TextEncodeQwenImage21":
            ins["resolution"] = 0  # keep every reference at its own size, so the output is Image 1's
    return wf
