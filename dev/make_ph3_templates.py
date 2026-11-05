"""Write the P-H3-Image templates: deck-ph3-t2i (text to image) and deck-ph3-edit (edit, with up to 7 references).

Run: python3 dev/make_ph3_templates.py   (then ↻ templates in ComfyChair)

P-H3-Image is PrunaAI's picture model made from MiniMax-H3: 8 steps, no CFG, no negative prompt. The graphs follow
PrunaAI/P-H3-Image-Comfy's own workflows (p-h3-image_text_to_image.json, p-h3-image_edit.json):
- MiniMaxH3SigmaShift at 1 / 1, euler, and the model's own 8-step list of sigmas;
- PH3ImageConditioning makes the conditioning and the latent. It needs ComfyUI v0.44.0 or later;
- the w4a8 files (4-bit weights), the smallest set, with the int8 VAE: a 12 GB card is under every figure the model
  card gives, so the picture model is offloaded in parts.

The prompt upsampler (a Qwen3.5-9B file) is in the graph but not connected: app/ph3image.py connects it at run time,
for the pictures the run has, when "Prompt upsampler" is on. Run outside ComfyChair these templates work without it.

Tested on 2026-11-05 (RTX 4070 Super, ComfyUI v0.44.0, one run each): text to image with the upsampler on at 1 MP took
136 s from cold (files on the SATA drive), 2 MP 143 s, and 4 MP 12.6 s with the models and upsampled text already
loaded (8 steps in 8.7 s); no out of memory. An edit at 832x1248 with one picture took 28 s and kept the face. 8 MP
and references were not run.
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "templates"
SIGMAS = "1.0, 0.984753, 0.967905, 0.951688, 0.925372, 0.881923, 0.810083, 0.528718, 0.0"
MODEL = "p-h3-image_w4a8.safetensors"
ENCODER = "p-h3-image_text_encoder_w4a8.safetensors"
UPSAMPLER = "p-h3-image_prompt_upsampler_w4a8.safetensors"
VAE = "p-h3-image_vae_int8_convrot.safetensors"
REFERENCES = 7   # after the picture to edit: 8 in all


def node(cls, title, meta=None, **inputs):
    return {"class_type": cls, "inputs": inputs, "_meta": {"title": title, **(meta or {})}}


def graph(prompt, prompt_title, prefix, seed_group):
    """What both templates share. seed_group is the first of the three group numbers after the pictures."""
    s = seed_group
    return {
        "1": node("UNETLoader", "@9 Model [unet_name]", unet_name=MODEL, weight_dtype="default"),
        "2": node("CLIPLoader", "Load text encoder", clip_name=ENCODER, type="minimax", device="default"),
        "3": node("VAELoader", "Load VAE", vae_name=VAE),
        "4": node("LoraLoaderModelOnly", f"@{s} LoRAs", model=["1", 0], lora_name="none", strength_model=1.0),
        "5": node("MiniMaxH3SigmaShift", "Shift (1 / 1)", model=["4", 0], shift_video=1.0, shift_audio=1.0),
        "6": node("PH3ImageConditioning", prompt_title, clip=["2", 0], prompt=prompt, width=0, height=0),
        "7": node("RandomNoise", f"@{s + 1} Seed", noise_seed=0),
        "8": node("KSamplerSelect", f"@{s + 2} Sampler", sampler_name="euler"),
        "9": node("ManualSigmas", "P-H3-Image sigmas (8 steps)", sigmas=SIGMAS),
        "10": node("BasicGuider", "Guider", model=["5", 0], conditioning=["6", 0]),
        "11": node("SamplerCustomAdvanced", "Sampler", noise=["7", 0], guider=["10", 0], sampler=["8", 0],
                   sigmas=["9", 0], latent_image=["6", 1]),
        "12": node("VAEDecode", "VAE Decode", samples=["11", 0], vae=["3", 0]),
        "13": node("SaveImage", "Save Image", filename_prefix=prefix, images=["12", 0]),
        # the upsampler: connected by app/ph3image.py when the setting is on
        "30": node("CLIPLoader", "Load prompt upsampler", clip_name=UPSAMPLER, type="minimax", device="default"),
        "31": node("TextGenerate", "Prompt upsampler", clip=["30", 0], prompt="", max_length=2048, sampling_mode="off",
                   thinking=True, use_default_template=True, mtp="auto"),
        "32": node("PrimitiveBoolean", f"@{s - 1} Prompt upsampler [value]", {"deck_ph3_upsampler": True}, value=True),
    }


def t2i():
    wf = graph('A neon sign that says "OPEN 24/7" above a ramen shop at night in the rain, cinematic photo',
               "@1 Picture [prompt,width,height]", "comfydeck/ph3", 3)
    wf["6"]["inputs"].update(width=2048, height=2048)
    return wf


def edit():
    wf = graph("Put the hat from <Picture 2> on the person in <Picture 1>.", "@1 Edit [prompt]", "comfydeck/ph3edit", 5)
    wf["6"]["inputs"]["vae"] = ["3", 0]
    wf["20"] = node("LoadImage", "@2 Image to edit", image="")
    wf["6"]["inputs"]["images.image_1"] = ["20", 0]
    for i in range(REFERENCES):
        wf[str(21 + i)] = node("LoadImage", "@3 References", image="")
        wf["6"]["inputs"][f"images.image_{i + 2}"] = [str(21 + i), 0]
    return wf


if __name__ == "__main__":
    for name, wf in (("deck-ph3-t2i", t2i()), ("deck-ph3-edit", edit())):
        (OUT / f"{name}.json").write_text(json.dumps(wf, indent=2) + "\n")
        print("wrote", name)
