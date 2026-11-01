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


# One cell of a sheet: made bigger, then SAM3 cuts out what the prompt names (the best match). Saved as one RGBA picture.
# The Image tool "Split a sheet" cuts the sheet into cells in the browser and runs this once per cell.
def sheet_cell(fast):
    wf = {"img": {**node("LoadImage", image=""), "_meta": {"title": "@1 Picture [image]", "deck_keep_size": True}}}
    if fast:
        wf.update({
            "um": node("UpscaleModelLoader", model_name="4x-UltraSharp.pth"),
            "up4": node("ImageUpscaleWithModel", upscale_model=["um", 0], image=["img", 0]),
            "up": node("ImageScaleBy", "@3 Enlarge [scale_by]", image=["up4", 0], upscale_method="lanczos", scale_by=0.5),
        })
    else:
        wf.update({
            "pre0": node("ImageScaleBy", "@3 Enlarge [scale_by]", image=["img", 0], upscale_method="lanczos", scale_by=2.0),
            "pad": node("SeedVR2Preprocess", resized_images=["pre0", 0]),
            "vae": node("VAELoader", vae_name="seedvr2_ema_vae_fp16.safetensors"),
            "unet": node("UNETLoader", unet_name="seedvr2_7b_sharp_int8_convrot.safetensors", weight_dtype="default"),
            "enc": node("VAEEncodeTiled", pixels=["pad", 0], vae=["vae", 0], tile_size=512, overlap=128, temporal_size=64, temporal_overlap=8),
            "cond": node("SeedVR2Conditioning", model=["unet", 0], vae_conditioning=["enc", 0]),
            "ks": node("KSampler", "@4 Seed [seed]", model=["unet", 0], positive=["cond", 0], negative=["cond", 1], latent_image=["enc", 0],
                       seed=42, steps=1, cfg=1.0, sampler_name="euler", scheduler="simple", denoise=1.0),
            "dec": node("VAEDecodeTiled", samples=["ks", 0], vae=["vae", 0], tile_size=512, overlap=128, temporal_size=64, temporal_overlap=8),
            "up": node("SeedVR2PostProcessing", images=["dec", 0], original_resized_images=["pre0", 0], color_correction_method="lab"),
        })
    wf.update({
        "model": node("LoadSAM3Model", precision="auto", compile=False),
        "find": node("SAM3Grounding", "@2 Cut out what [text_prompt]", sam3_model_config=["model", 0], image=["up", 0],
                     confidence_threshold=0.2, text_prompt="person", max_detections=1),
        # the matte at the picture's own size whatever SAM3 returns (nothing found = a small empty one)
        "mimg": node("MaskToImage", mask=["find", 0]),
        "size": node("GetImageSize", image=["up", 0]),
        "msize": node("ImageScale", image=["mimg", 0], upscale_method="bilinear", width=["size", 0], height=["size", 1], crop="disabled"),
        "mask": node("ImageToMask", image=["msize", 0], channel="red"),
        # JoinImageWithAlpha reads a mask as 1 = see-through, so the matte (1 = the thing) is flipped first
        "flip": node("InvertMask", mask=["mask", 0]),
        "join": node("JoinImageWithAlpha", image=["up", 0], alpha=["flip", 0]),
        "save": node("SaveImage", images=["join", 0], filename_prefix="deck/sheet-cell"),
    })
    return wf


write("deck-sheet-cell", sheet_cell(False))
write("deck-sheet-cell-fast", sheet_cell(True))
