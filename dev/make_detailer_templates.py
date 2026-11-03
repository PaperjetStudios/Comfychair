"""Write the detailer templates: find one thing in a picture by name, make it again at full resolution, put it back.

Run: python3 dev/make_detailer_templates.py   (then ↻ templates in ComfyChair)

Made from each model's own image-to-image template (deck-krea2-i2i, deck-klein9b-i2i, deck-qwen21-i2i), so the
model, LoRA stack, sampler and prompt boxes are the same ones. What changes:

  SAM3 finds the thing the "Detail what" box names (face, hands, eyes, shoes...), the best match only
  -> KJNodes ImageCropByMaskAndResize cuts a padded square around it and scales it up to Crop size
  -> the model's image-to-image pass redraws the crop (low denoise: same shape, finer detail)
  -> ImageUncropByMask puts it back through a soft edge of the thing's own outline.

Everything outside the soft outline stays the original picture, at its own size. If SAM3 finds nothing the crop is
taken from the middle of the picture. Needs the comfyui-sam3 and comfyui-kjnodes packs (both installed).
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "templates"

MODELS = {
    # name: (i2i template, redraw strength key, strength, prompt)
    "krea2": ("deck-krea2-i2i", 0.3),
    "klein9b": ("deck-klein9b-i2i", 0.3),
    "qwen21": ("deck-qwen21-i2i", 0.4),
}
PROMPT = "A sharp, highly detailed close-up, natural skin texture, fine pores, crisp eyes, realistic hair strands"
# Face skin: the best of the skin tests on real pictures (Krea 2 drew dotted pores, Qwen 2.1 stayed smooth)
SKIN_LORA = "klein/Flux2 Klein 9B Realistic Detail LoRA.safetensors"
SKIN_PROMPT = "A candid close-up photograph of a face, natural skin with subtle texture and slight imperfections, soft daylight"


def node(cls, title=None, **inputs):
    n = {"class_type": cls, "inputs": inputs}
    if title:
        n["_meta"] = {"title": title}
    return n


def by_class(wf, cls):
    return next(k for k, n in wf.items() if n["class_type"] == cls)


def make(key, base, denoise, name="detail", prompt=PROMPT, lora=None):
    wf = json.loads((OUT / f"{base}.json").read_text())
    # the i2i template's picture + resize pair goes; the picture keeps its own size
    enc = by_class(wf, "VAEEncode")
    dec = by_class(wf, "VAEDecode")
    save = by_class(wf, "SaveImage")
    for k in ("20", "21"):
        del wf[k]
    wf["20"] = node("LoadImage", "@2 Picture [image]", image="")
    wf["20"]["_meta"]["deck_keep_size"] = True
    wf["30"] = node("LoadSAM3Model", "Load SAM3", precision="auto", compile=False)
    wf["31"] = node("SAM3Grounding", "@2 Detail what [text_prompt,confidence_threshold]", sam3_model_config=["30", 0],
                    image=["20", 0], confidence_threshold=0.3, text_prompt="face", max_detections=1)
    wf["32"] = node("ImageCropByMaskAndResize", "@8 Crop [base_resolution,padding]", image=["20", 0],
                    mask=["31", 0], base_resolution=1024, padding=48, min_crop_resolution=128,
                    max_crop_resolution=1024)
    wf["33"] = node("GrowMaskWithBlur", "@8 Blend [expand,blur_radius]", mask=["32", 1], expand=6,
                    incremental_expandrate=0.0, tapered_corners=True, flip_input=False, blur_radius=12.0,
                    lerp_alpha=1.0, decay_factor=1.0, fill_holes=False)
    wf["34"] = node("ImageUncropByMask", "Put it back", destination=["20", 0], source=[dec, 0], mask=["33", 0],
                    bbox=["32", 2])
    if key == "qwen21":   # (its VAE decodes to RGBA, which ImageUncropByMask refuses)
        wf["35"] = node("SplitImageWithAlpha", "Drop the decoded alpha (Qwen 2.1 VAE gives RGBA)", image=[dec, 0])
        wf["34"]["inputs"]["source"] = ["35", 0]
    wf[enc]["inputs"]["pixels"] = ["32", 0]
    wf[save]["inputs"]["images"] = ["34", 0]
    wf[save]["inputs"]["filename_prefix"] = f"{key}_{name.replace('-', '_')}"
    # the redraw strength and the prompt
    for n in wf.values():
        if n["class_type"] in ("KSampler", "SplitSigmasDenoise"):
            n["inputs"]["denoise"] = denoise
        if n["class_type"] in ("CLIPTextEncode", "TextEncodeQwenImage21") and n.get("_meta", {}).get("title", "").startswith("@1"):
            n["inputs"]["prompt" if n["class_type"] == "TextEncodeQwenImage21" else "text"] = prompt
    if lora:
        wf[by_class(wf, "LoraLoaderModelOnly")]["inputs"]["lora_name"] = lora
    (OUT / f"deck-{key}-{name}.json").write_text(json.dumps(wf, indent=1) + "\n")


for key, (base, denoise) in MODELS.items():
    make(key, base, denoise)
make("klein9b", "deck-klein9b-i2i", 0.3, name="face-skin", prompt=SKIN_PROMPT, lora=SKIN_LORA)
