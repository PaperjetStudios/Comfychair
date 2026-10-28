"""Write deck-moss-edit: MOSS-Image SFT with the Moss-Image-Edit LoRA (chinoll), an instruction edit of a picture
with up to three more reference pictures.

Run: python3 dev/make_moss_edit_template.py   (then ↻ templates in ComfyChair)

Needs ComfyUI with the native "Text Encode MOSS-Image Edit" node (PR #17296, after v0.42.4) and
moss_image_edit_lora_bf16.safetensors from huggingface.co/PedroMarinhoDev/Moss-Image-Edit-ComfyUI (chinoll's LoRA with
ComfyUI key names, 297 MB) in loras/moss/. Licence: the training project is GPLv3; the weights name no licence of
their own.

How it works: the edit node VAE-encodes every picture as a reference latent (edit_format "Moss-Image-Edit": the
references sit at t = 0 before the text; the text encoder does not see them). Image 1 is the picture being edited and
the output takes its size (the Generate tab's Size crops it); the other references are scaled to about 1 MP each,
since the LoRA was trained with references and output at one size. The negative is the same node with an empty
prompt and the same pictures. Prompts name the pictures "image 1", "image 2"… ("Dress the woman in image 1 in the
jacket from image 2").

Settings from the LoRA's notes: strength 1.0 (lower redraws the scene instead of editing it), CFG 5 (4 also takes
nearby objects on removals), 30 steps, euler / simple, layer 22 skipped on the negative pass.
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "templates"
LORA = "moss/moss_image_edit_lora_bf16.safetensors"


def node(cls, title=None, **inputs):
    n = {"class_type": cls, "inputs": inputs}
    if title:
        n["_meta"] = {"title": title}
    return n


def edit():
    g = {}
    g["1"] = node("UNETLoader", "@9 Model [unet_name]", unet_name="moss_image_sft_int8_convrot.safetensors",
                  weight_dtype="default")
    g["2"] = node("CLIPLoader", "Load CLIP", clip_name="qwen3.5_9b_w4a8_gptq.safetensors", type="moss_image",
                  device="default")
    g["3"] = node("VAELoader", "Load VAE", vae_name="flux2-vae_small.safetensors")
    g["4"] = node("SkipLayerGuidanceDiTSimple", "Skip layer 22 on the negative pass", model=["1", 0],
                  double_layers="", single_layers="22", start_percent=0.0, end_percent=1.0)
    g["5"] = node("LoraLoaderModelOnly", "Moss-Image-Edit LoRA", model=["4", 0], lora_name=LORA, strength_model=1.0)
    g["6"] = node("LoraLoaderModelOnly", "@6 LoRAs", model=["5", 0], lora_name="none", strength_model=1.0)
    g["20"] = node("LoadImage", "@2 Image to edit", image="")
    images = {"images.image_0": ["20", 0]}
    for i, nid in enumerate(("21", "22", "23")):
        g[nid] = node("LoadImage", "@3 References", image="")
        sid = str(24 + i)
        scale = node("ImageScaleToTotalPixels", f"Reference {i + 1} at 1 MP", image=[nid, 0],
                     upscale_method="lanczos", megapixels=1.0, resolution_steps=16)
        scale["_meta"]["deck_drop"] = True   # goes with an empty slot
        g[sid] = scale
        images[f"images.image_{i + 1}"] = [sid, 0]
    g["30"] = node("TextEncodeMOSSImageEdit", "@1 Edit [prompt]", clip=["2", 0], vae=["3", 0],
                   prompt="Put the character from image 2 into image 1, standing in the middle of the room.",
                   edit_format="Moss-Image-Edit", image_strength=1.0, **images)
    g["31"] = node("TextEncodeMOSSImageEdit", "Negative (same pictures)", clip=["2", 0], vae=["3", 0], prompt="",
                   edit_format="Moss-Image-Edit", image_strength=1.0, **images)
    g["40"] = node("VAEEncode", "Encode picture (size only, denoise 1)", pixels=["20", 0], vae=["3", 0])
    g["50"] = node("KSampler", "@5 Sampler [seed,steps,cfg]", seed=0, steps=30, cfg=5.0, sampler_name="euler",
                   scheduler="simple", denoise=1.0, model=["6", 0], positive=["30", 0], negative=["31", 0],
                   latent_image=["40", 0])
    g["51"] = node("VAEDecode", "VAE Decode", samples=["50", 0], vae=["3", 0])
    g["52"] = node("SaveImage", "Save Image", filename_prefix="moss_edit", images=["51", 0])
    return g


if __name__ == "__main__":
    (OUT / "deck-moss-edit.json").write_text(json.dumps(edit(), indent=1) + "\n")
    print("wrote deck-moss-edit")
