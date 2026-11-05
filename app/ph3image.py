"""P-H3-Image's prompt upsampler, wired in for the pictures a run really has.

P-H3-Image (PrunaAI, on MiniMax-H3) is sensitive to how its prompt is written, so its own workflows put a small
language model in front: it turns a short request into the long brief the picture model was trained on. What that
model is given depends on the run:
- text to image: the request and the shape of the picture ("Aspect ratio: 16:9");
- an edit: every picture going into the edit, each named <Picture N>, and the request.

A template can't say that ahead of time (reference slots left empty are dropped at run time), so the templates carry
the upsampler unconnected, with an on/off setting, and inject() connects it once the run's pictures are known. The
strings are the ones in PrunaAI/P-H3-Image-Comfy's workflows (p-h3-image_text_to_image.json, p-h3-image_edit.json).
"""
import math
import re

from . import editsize
from .accel import _is_link

COND = "PH3ImageConditioning"
GENERATE = {"TextGenerate", "TextGenerateV2"}
TOGGLE = "deck_ph3_upsampler"   # _meta key on the on/off node
STEP = 32                       # the picture's sides are multiples of this (ComfyUI's CANVAS_MULTIPLE)
# the shapes the model card lists; the upsampler is told the nearest one
RATIOS = ((1, 1), (4, 3), (3, 4), (3, 2), (2, 3), (16, 9), (9, 16))
PICTURE = "<Picture {}>: <|vision_start|><|image_pad|><|vision_end|>"
EDIT = "<|im_start|>user\n{pictures}{request}<|im_end|>\n<|im_start|>assistant\n<think>\n"
ALREADY_EDIT = re.compile(r"\s*Edit <Picture \d+>")   # the conditioning node's own test for "use it as it is"
T2I_TOKENS, EDIT_TOKENS = 2048, 3072


def ratio(width: int, height: int) -> str:
    """The listed shape nearest to width x height, as "16:9"."""
    if not width or not height:
        return "1:1"
    want = math.log(width / height)
    a, b = min(RATIOS, key=lambda r: abs(math.log(r[0] / r[1]) - want))
    return f"{a}:{b}"


def _pictures(inputs: dict) -> list:
    keys = [k for k in inputs if k.startswith("images.image_") and _is_link(inputs[k])]
    return [inputs[k] for k in sorted(keys, key=lambda k: int(k.rsplit("_", 1)[-1]))]


def _drop_unused(wf: dict, nid: str) -> None:
    """Take a node out, and then whatever fed only it (the upsampler's loader)."""
    feeders = [v[0] for v in wf[nid]["inputs"].values() if _is_link(v)]
    del wf[nid]
    for f in feeders:
        if f in wf and not any(_is_link(v) and v[0] == f for n in wf.values() for v in n["inputs"].values()):
            _drop_unused(wf, f)


def inject(wf: dict, values: dict | None = None) -> dict:
    cond = next((k for k, n in wf.items() if n.get("class_type") == COND), None)
    if cond is None:
        return wf
    ins = wf[cond]["inputs"]
    pics = _pictures(ins)
    # an edit comes out at the Size picked for its first picture, and its references are shrunk to that area. Left
    # at 0 the node would take every reference at up to 8.5 MP, whatever the size of the result
    w, h = (values or {}).get(editsize.WIDTH), (values or {}).get(editsize.HEIGHT)
    if pics and w and h and not ins.get("width") and not ins.get("height"):
        ins["width"], ins["height"] = int(w) // STEP * STEP, int(h) // STEP * STEP

    toggle = next((k for k, n in wf.items() if (n.get("_meta") or {}).get(TOGGLE)), None)
    on = bool(wf[toggle]["inputs"].get("value", True)) if toggle else True
    if toggle:
        del wf[toggle]   # only a setting: nothing in the graph reads it
    gen = next((k for k, n in wf.items() if n.get("class_type") in GENERATE), None)
    if gen is None:
        return wf
    text = ins.get("prompt")
    if not on or not isinstance(text, str) or not text.strip():
        _drop_unused(wf, gen)
        return wf

    g = wf[gen]["inputs"]
    if not pics:
        g.update(prompt=f"Aspect ratio: {ratio(ins.get('width') or 0, ins.get('height') or 0)}\nRequest: {text.strip()}",
                 max_length=T2I_TOKENS, thinking=True)
    else:
        nid = max((int(k) for k in wf if k.isdigit()), default=0) + 1

        def add(cls, title, **inputs):
            nonlocal nid
            wf[str(nid)] = {"class_type": cls, "inputs": inputs, "_meta": {"title": title}}
            nid += 1
            return [str(nid - 1), 0]

        # the upsampler looks at the pictures small: the first at 1 MP, the others fitted and padded to its size
        first = add("ImageScaleToTotalPixels", "Picture 1 at 1 MP (for the upsampler)", image=pics[0],
                    upscale_method="lanczos", megapixels=1.0, resolution_steps=1)
        seen = first
        if len(pics) > 1:
            size = add("GetImageSize", "Size of picture 1", image=first)
            batch = {"images.image0": first}
            for i, pic in enumerate(pics[1:], start=1):
                batch[f"images.image{i}"] = add("ResizeAndPadImage", f"Picture {i + 1} padded to picture 1", image=pic,
                                                target_width=size, target_height=[size[0], 1],
                                                padding_color="white", interpolation="lanczos")
            seen = add("BatchImagesNode", "Pictures for the upsampler", **batch)
        request = text.strip() if ALREADY_EDIT.match(text) else f"Edit <Picture 1>. {text.strip()}"
        g.update(prompt=EDIT.format(pictures="".join(PICTURE.format(i + 1) for i in range(len(pics))), request=request),
                 image=seen, max_length=EDIT_TOKENS, thinking=False)
    ins["prompt"] = [gen, 0]
    return wf
