"""Write templates/deck-3d-object-splat.json: Idol (Speridlabs, ComfyUI-Idol) makes a 3D gaussian splat of one object
from one picture, unseen sides included. The 3D tab's object sheet runs it and adds the .ply as a splat layer.

Run: python3 dev/make_idol_template.py   (then ↻ templates in ComfyChair)

Needs the ComfyUI-Idol node pack (custom_nodes) and, in ComfyUI's models: diffusion_models/idol_fp16, vae/idol_decoder_fp16 and
flux2-vae, clip_vision/dino_v3_vit_h, background_removal/birefnet. Settings are the pack's own defaults (50 Euler steps, cfg 4).
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "templates"


def node(cls, title=None, **inputs):
    n = {"class_type": cls, "inputs": inputs}
    if title:
        n["_meta"] = {"title": title}
    return n


wf = {
    "img": {**node("LoadImage", image=""), "_meta": {"title": "@1 Object picture [image]", "deck_keep_size": True}},   # (no Size picker: Idol crops it)
    "bgm": node("LoadBackgroundRemovalModel", bg_removal_name="birefnet.safetensors"),
    # a render or a generated picture (the object fills 1/1.2 of the frame) or a photograph (1/1.7): only the chosen one runs
    "pre_synth": node("IdolPreprocessImage", image=["img", 0], mode="synthetic", erode_radius=1, size=1024,
                      bg_removal_model=["bgm", 0]),
    "pre_real": node("IdolPreprocessImage", image=["img", 0], mode="real", erode_radius=1, size=1024,
                     bg_removal_model=["bgm", 0]),
    "real": node("PrimitiveBoolean", "@2 It is a photograph [value]", value=False),
    "pick": node("ComfySwitchNode", switch=["real", 0], on_false=["pre_synth", 0], on_true=["pre_real", 0]),
    "dino": node("CLIPVisionLoader", clip_name="dino_v3_vit_h.safetensors"),
    "flux": node("VAELoader", vae_name="flux2-vae.safetensors"),
    "cond": node("TripoSplatConditioning", clip_vision=["dino", 0], vae=["flux", 0], image=["pick", 0]),
    "unet": node("UNETLoader", unet_name="idol_fp16.safetensors", weight_dtype="default"),
    "dec": node("VAELoader", vae_name="idol_decoder_fp16.safetensors"),
    "seed": node("PrimitiveInt", "@4 Seed [value]", value=42),
    "steps": node("PrimitiveInt", "@3 Detail (steps) [value]", value=50),
    "ks": node("KSampler", model=["unet", 0], positive=["cond", 0], negative=["cond", 1], latent_image=["cond", 2],
               seed=["seed", 0], steps=["steps", 0], cfg=4.0, sampler_name="euler", scheduler="simple", denoise=1.0),
    "decode": node("VAEDecodeTripoSplat", samples=["ks", 0], vae=["dec", 0], num_gaussians=262144, seed=0),
    # about half of Idol's gaussians are near-transparent and draw as a haze: dropped
    "prune": node("IdolPruneSplat", splat=["decode", 0], min_opacity=0.05, max_scale=0.0),
    "file": node("SplatToFile3D", splat=["prune", 0], format="ply"),
    "save": node("SaveGaussianSplat", model_3d=["file", 0], filename_prefix="deck/idol", viewport_state="", width=1024, height=1024),
}
(OUT / "deck-3d-object-splat.json").write_text(json.dumps(wf, indent=1) + "\n")
