"""Write the inpaint templates: the painted area of a picture made again from the prompt, with the image models
already installed (no inpaint-specific weights).

Run: python3 dev/make_inpaint_templates.py   (then ↻ templates in ComfyChair)

Classic latent inpainting: the picture is VAE-encoded, the mask set as the latent's noise mask, and Differential
Diffusion on the model lets a soft mask edge blend in (grey = changed later in the schedule). Denoise 1.0 starts
the masked area from pure noise; lower keeps more of what was there (colours, shapes).

The mask comes from the Generate tab's Mask painter: an untitled LoadImageMask gets the painted mask
(app/maskcomp.py), and every saved image is put back onto the picture through the same mask, so outside the mask
nothing changes. The picture has no width/height of its own, so it gets the edit models' Size (app/editsize.py)
and Crop to mask: a small area is inpainted at the model's full resolution.

Tested on 2026-10-28 (robot frame, box masks, Crop to mask at 1024x1024): Krea 2 turbo gave the best fills (8 steps,
about 10-18 s) and stays closest to the rest of the picture; Qwen 2.1 turbo is as sharp (about 8 s) and takes
reference pictures (a jacket to copy, say), but drifts further from the picture around the mask. The picture itself is
NOT given to Qwen as a reference: with it, the edit model redraws what was there (the inside barely changes).
Flux 3 Klein was left out: with the picture as a reference it repainted the original, without it the fills
were incoherent.
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "templates"

# the painted mask, at the picture's working size: grown, then softened (Differential Diffusion uses the grey)
GROW = 16          # px, at the size the model works at
SOFT = 16          # ImageBlur radius (px)
DENOISE = 0.9       # 1.0 also redraws the background inside a loose mask; 0.8 keeps more of the old shapes


def node(cls, title=None, **inputs):
    n = {"class_type": cls, "inputs": inputs}
    if title:
        n["_meta"] = {"title": title}
    return n


class G(dict):
    def add(self, nid, n):
        self[nid] = n
        return nid


def loaders(g, unet, clip, clip_type, vae):
    g.add("1", node("UNETLoader", "@9 Model [unet_name]", unet_name=unet, weight_dtype="default"))
    g.add("2", node("CLIPLoader", "Load CLIP", clip_name=clip, type=clip_type, device="default"))
    g.add("3", node("VAELoader", "Load VAE", vae_name=vae))
    g.add("4", node("LoraLoaderModelOnly", "@5 LoRAs", model=["1", 0], lora_name="none", strength_model=1.0))
    g.add("5", node("DifferentialDiffusion", "Differential Diffusion (soft mask edge)", model=["4", 0], strength=1.0))


def picture_and_mask(g):
    """The picture (Size and Crop to mask act on it) and the painted mask fitted to it: the masked latent."""
    g.add("20", node("LoadImage", "@2 Image", image=""))
    g.add("30", node("LoadImageMask", "Inpaint mask (the painted mask)", image="", channel="red"))
    g.add("31", node("GetImageSize", "Picture size", image=["20", 0]))
    g.add("32", node("MaskToImage", "Mask as a picture", mask=["30", 0]))
    g.add("33", node("ImageScale", "Mask to the picture's size", image=["32", 0], upscale_method="bilinear",
                     width=["31", 0], height=["31", 1], crop="center"))
    g.add("34", node("ImageToMask", "Mask", image=["33", 0], channel="red"))
    g.add("35", node("GrowMask", f"Grow {GROW} px", mask=["34", 0], expand=GROW, tapered_corners=True))
    g.add("36", node("MaskToImage", "Grown mask as a picture", mask=["35", 0]))
    g.add("37", node("ImageBlur", f"Soft edge {SOFT} px", image=["36", 0], blur_radius=SOFT, sigma=0.5))
    g.add("38", node("ImageToMask", "Soft mask", image=["37", 0], channel="red"))
    g.add("40", node("VAEEncode", "Encode picture", pixels=["20", 0], vae=["3", 0]))
    g.add("41", node("SetLatentNoiseMask", "Only the mask is sampled", samples=["40", 0], mask=["38", 0]))
    return ["41", 0]


def sample(g, positive, negative, latent, sigmas, prefix):
    g.add("14", node("SplitSigmasDenoise", "@4 Denoise [denoise]", sigmas=sigmas, denoise=DENOISE))
    g.add("15", node("RandomNoise", "@6 Seed", noise_seed=0))
    g.add("16", node("KSamplerSelect", "Sampler select", sampler_name="euler"))
    g.add("17", node("CFGGuider", "CFG Guider", model=["5", 0], positive=positive, negative=negative, cfg=1.0))
    g.add("18", node("SamplerCustomAdvanced", "Sampler", noise=["15", 0], guider=["17", 0], sampler=["16", 0],
                     sigmas=["14", 1], latent_image=latent))
    g.add("12", node("VAEDecode", "VAE Decode", samples=["18", 0], vae=["3", 0]))
    g.add("13", node("SaveImage", "Save Image", filename_prefix=prefix, images=["12", 0]))


def qwen():
    """Qwen Image 2.1 turbo (deck-qwen21-edit's models): 8 fixed turbo steps; up to two reference pictures."""
    g = G()
    loaders(g, "qwen_image_2.1_turbo_int8_convrot.safetensors", "qwen3vl_8b_int8_convrot.safetensors", "qwen_image",
            "qwen_image_2.1_vae_bf16.safetensors")
    latent = picture_and_mask(g)
    g.add("21", node("LoadImage", "@3 More references", image=""))
    g.add("22", node("LoadImage", "@3 More references", image=""))
    g.add("8", node("TextEncodeQwenImage21", "@1 Prompt [prompt,negative_prompt]", clip=["2", 0], vae=["3", 0],
                    prompt="A brass diving helmet with round glass portholes, matching the light of the picture",
                    negative_prompt="", resolution=0,
                    **{"images.image_1": ["21", 0], "images.image_2": ["22", 0]}))
    g.add("11", node("ManualSigmas", "Turbo sigmas (8 steps)",
                     sigmas="1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0"))
    sample(g, ["8", 0], ["8", 1], latent, ["11", 0], "qwen21_inpaint")
    return g


def krea():
    """Krea 2 turbo: text only, 8 steps."""
    g = G()
    loaders(g, "krea2_turbo_fp8_scaled.safetensors", "qwen3vl_4b_fp8_scaled.safetensors", "krea2",
            "qwen_image_vae.safetensors")
    latent = picture_and_mask(g)
    g.add("8", node("CLIPTextEncode", "@1 Prompt [text]", clip=["2", 0],
                    text="A brass diving helmet with round glass portholes, studio light"))
    g.add("9", node("ConditioningZeroOut", "Negative (zeroed)", conditioning=["8", 0]))
    g.add("11", node("BasicScheduler", "@7 Steps [steps]", model=["5", 0], scheduler="simple", steps=8, denoise=1.0))
    sample(g, ["8", 0], ["9", 0], latent, ["11", 0], "krea2_inpaint")
    return g


TEMPLATES = {
    "deck-qwen21-inpaint": qwen,
    "deck-krea2-inpaint": krea,
}

if __name__ == "__main__":
    for name, make in TEMPLATES.items():
        (OUT / f"{name}.json").write_text(json.dumps(make(), indent=1) + "\n")
        print("wrote", name)
