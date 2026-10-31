"""Write the picture-tool templates the Image tab's Image tools panel runs (web/imagetools.js).

Run: python3 dev/make_image_tool_templates.py   (then ↻ templates in ComfyChair)

deck-cutout-image  BiRefNet: a black-and-white matte of the main subject (white = keep). The panel makes the
                   cut-out layer or the inpaint mask from it in the browser.
deck-mask-image    SAM3 finds what the prompt names ("the red car", "people"): one matte picture per thing found;
                   the panel joins them.
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "templates"


def node(cls, title=None, **inputs):
    n = {"class_type": cls, "inputs": inputs}
    if title:
        n["_meta"] = {"title": title}
    return n


def write(name, wf):
    (OUT / f"{name}.json").write_text(json.dumps(wf, indent=1) + "\n")


write("deck-cutout-image", {
    "img": {**node("LoadImage", image=""), "_meta": {"title": "@1 Picture [image]", "deck_keep_size": True}},
    "bgm": node("LoadBackgroundRemovalModel", bg_removal_name="birefnet.safetensors"),
    "bg": node("RemoveBackground", bg_removal_model=["bgm", 0], image=["img", 0]),
    "grey": node("MaskToImage", mask=["bg", 0]),
    "save": node("SaveImage", images=["grey", 0], filename_prefix="deck/matte"),
})

write("deck-mask-image", {
    "img": {**node("LoadImage", image=""), "_meta": {"title": "@1 Picture [image]", "deck_keep_size": True}},
    "model": node("LoadSAM3Model", precision="auto", compile=False),
    "find": node("SAM3Grounding", "@2 Prompt [text_prompt]", sam3_model_config=["model", 0], image=["img", 0],
                 confidence_threshold=0.2, text_prompt="person", max_detections=8),
    "grey": node("MaskToImage", mask=["find", 0]),
    "save": node("SaveImage", images=["grey", 0], filename_prefix="deck/sam3-image-mask"),
})
