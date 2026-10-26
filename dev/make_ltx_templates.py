"""Write the VFX tab's LTX-2.5 templates (templates/deck-ltx-*.json) from shared pieces.

Run: python3 dev/make_ltx_templates.py   (then ↻ templates in ComfyDeck)

The graphs follow Lightricks' ComfyUI-LTXVideo 2.5 examples (distilled, single stage, 8 sigmas, CFG 1) with
the int8 transformer and text encoder, tiled decode tuned for 12 GB, and @-titled fields named the way the
VFX tab looks for them (web/vfx.js ROLES; README "VFX templates"). Frame counts are 8n+1 at 24 fps.
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "templates"
FPS = 24
UNET = "ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors"
CLIP = "gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"
VVAE = "ltx-2.5-video-vae-bf16.safetensors"
VVAE_CONV = "ltx-2.5-video-vae-conv-bf16.safetensors"
AVAE = "ltx-2.5-audio-vae-bf16.safetensors"
SIGMAS = "1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0"
LORA = "ltx2.5/"


def node(cls, title=None, **inputs):
    n = {"class_type": cls, "inputs": inputs}
    if title:
        n["_meta"] = {"title": title}
    return n


class G(dict):
    def add(self, nid, n):
        self[nid] = n
        return nid


def models(g, vae=VVAE):
    g.add("unet", node("UNETLoader", unet_name=UNET, weight_dtype="default"))
    g.add("clip", node("CLIPLoader", clip_name=CLIP, type="ltxv", device="default"))
    g.add("vvae", node("VAELoader", vae_name=vae))
    g.add("avae", node("VAELoader", vae_name=AVAE))


def text(g, prompt_title="@2 Prompt", prompt="", negative="", negative_title=None):
    if prompt_title:
        g.add("prompt", node("PrimitiveStringMultiline", prompt_title, value=prompt))
        pos = ["prompt", 0]
    else:
        pos = prompt
    if negative_title:
        g.add("negp", node("PrimitiveStringMultiline", negative_title, value=negative))
        negative = ["negp", 0]
    g.add("pos", node("CLIPTextEncode", text=pos, clip=["clip", 0]))
    g.add("neg", node("CLIPTextEncode", text=negative, clip=["clip", 0]))
    g.add("cond", node("LTXVConditioning", positive=["pos", 0], negative=["neg", 0], frame_rate=FPS))


def math(g, nid, expr, title, **vals):
    return g.add(nid, node("ComfyMathExpression", title, expression=expr, **{f"values.{k}": v for k, v in vals.items()}))


def source(g, secs=5.0, short=704, max_frames=None):
    """@1 Source video → its first 8n+1 frames (up to Length), resized so the short side is Resolution
    (both sides multiples of 32). Gives ids: cut (frames), W, H (math INT at output 1), nf (frames)."""
    g.add("src", node("VHS_LoadVideoPath", "@1 Source video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
                      frame_load_cap=0, skip_first_frames=0, select_every_nth=1))
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=secs))
    g.add("short", node("PrimitiveInt", "@4 Resolution (short side)", value=short))
    cap = f"min(a, b*{FPS}+1, {max_frames})" if max_frames else f"min(a, b*{FPS}+1)"
    math(g, "nf", f"floor(({cap}-1)/8)*8+1", "frames: 8n+1 within the clip and Length", a=["src", 1], b=["secs", 0])
    g.add("cut", node("ImageFromBatch", image=["src", 0], batch_index=0, length=["nf", 1]))
    g.add("size", node("GetImageSize", image=["cut", 0]))
    math(g, "W", "round(a*c/min(a,b)/32)*32", "width: short side to Resolution, x32", a=["size", 0], b=["size", 1], c=["short", 0])
    math(g, "H", "round(b*c/min(a,b)/32)*32", "height", a=["size", 0], b=["size", 1], c=["short", 0])
    g.add("rs", node("ImageResizeKJv2", image=["cut", 0], width=["W", 1], height=["H", 1], upscale_method="lanczos",
                     keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=32, device="cpu"))


def sample(g, model, positive, negative, latent, sampler="euler_ancestral", sched=None):
    g.add("noise", node("RandomNoise", "@8 Seed [noise_seed]", noise_seed=42))
    g.add("guider", node("CFGGuider", model=model, positive=positive, negative=negative, cfg=1.0))
    g.add("ksel", node("KSamplerSelect", sampler_name=sampler))
    if sched:
        g.add("sig", node("BasicScheduler", model=model, scheduler="simple", steps=sched, denoise=1.0))
    else:
        g.add("sig", node("ManualSigmas", sigmas=SIGMAS))
    g.add("run", node("SamplerCustomAdvanced", noise=["noise", 0], guider=["guider", 0], sampler=["ksel", 0],
                      sigmas=["sig", 0], latent_image=latent))
    g.add("sep", node("LTXVSeparateAVLatent", av_latent=["run", 0]))


def audio_latent(g, frames):
    g.add("alat", node("LTXVEmptyLatentAudio", frames_number=frames, frame_rate=FPS, batch_size=1, audio_vae=["avae", 0]))


def decode(g, samples, name, audio=True):
    g.add("vdec", node("VAEDecodeTiled", samples=samples, vae=["vvae", 0], tile_size=512, overlap=64, temporal_size=64, temporal_overlap=8))
    extra = {}
    if audio:
        g.add("adec", node("LTXVAudioVAEDecode", samples=["sep", 1], audio_vae=["avae", 0]))
        extra["audio"] = ["adec", 0]
    g.add("vid", node("CreateVideo", images=["vdec", 0], fps=FPS, **extra))
    g.add("save", node("SaveVideo", video=["vid", 0], filename_prefix=f"deck/{name}", format="auto", codec="auto"))


def ic_guide(g, latent_factor, image, frames):
    """An IC-LoRA guide on an empty latent the size of the resized source."""
    g.add("vlat", node("EmptyLTXVLatentVideo", width=["W", 1], height=["H", 1], length=frames, batch_size=1))
    g.add("guide", node("LTXAddVideoICLoRAGuide", positive=["cond", 0], negative=["cond", 1], vae=["vvae", 0], latent=["vlat", 0],
                        image=image, frame_idx=0, strength=1.0, latent_downscale_factor=latent_factor, crop="disabled",
                        use_tiled_encode=False, tile_size=256, tile_overlap=64, use_streaming=False, tile_frames=97))


def v2v(name, lora, strength=1.0, lora_title=None, prompt_title="@2 Prompt", prompt="", negative="", negative_title=None,
        max_frames=None, audio=False):
    """Source video → an IC-LoRA's take on it (restyle, alpha matte, clean plate)."""
    g = G()
    models(g)
    text(g, prompt_title, prompt, negative, negative_title)
    source(g, max_frames=max_frames)
    g.add("lora", node("LTXICLoRALoaderModelOnly", lora_title, model=["unet", 0], lora_name=LORA + lora, strength_model=strength))
    ic_guide(g, ["lora", 1], ["rs", 0], ["nf", 1])
    audio_latent(g, ["nf", 1])
    g.add("av", node("LTXVConcatAVLatent", video_latent=["guide", 2], audio_latent=["alat", 0]))
    sample(g, ["lora", 0], ["guide", 0], ["guide", 1], ["av", 0])
    g.add("crop", node("LTXVCropGuides", positive=["guide", 0], negative=["guide", 1], latent=["sep", 0]))
    decode(g, ["crop", 2], name, audio)
    return g


def ripple():
    """Ripple (FFAF edit, a community LoRA): the edited first frame, then the source, as one guide."""
    g = G()
    models(g, VVAE_CONV)
    text(g, "@2 Prompt", "Use the reference video for motion, timing, camera movement, composition, and unchanged scene content, "
                         "while consistently propagating the visual edit established in the first frame throughout the video.",
         "blurry, low resolution, ugly, garbled mess, compression artifacts, glitch, stop motion, still image, pixelated, oversaturated")
    source(g)
    g.add("first", node("LoadImage", "@1 First frame [image]", image=""))
    g.add("firstrs", node("ImageResizeKJv2", image=["first", 0], width=["W", 1], height=["H", 1], upscale_method="lanczos",
                          keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=32, device="cpu"))
    g.add("batch", node("BatchImagesNode", **{"images.image0": ["firstrs", 0], "images.image1": ["rs", 0]}))
    g.add("lora", node("LoraLoaderModelOnly", model=["unet", 0], lora_name=LORA + "LTX25_Ripple_v11.safetensors", strength_model=1.35))
    ic_guide(g, 1, ["batch", 0], ["nf", 1])
    audio_latent(g, ["nf", 1])
    g.add("av", node("LTXVConcatAVLatent", video_latent=["guide", 2], audio_latent=["alat", 0]))
    sample(g, ["lora", 0], ["guide", 0], ["guide", 1], ["av", 0], sampler="euler", sched=8)
    g.add("crop", node("LTXVCropGuides", positive=["guide", 0], negative=["guide", 1], latent=["sep", 0]))
    decode(g, ["crop", 2], "ltx-ripple", audio=False)
    return g


def t2v():
    """Text (and an optional start image) to video, with sound."""
    g = G()
    models(g)
    text(g)
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=5.0))
    g.add("W", node("PrimitiveInt", "@4 Width", value=1280))
    g.add("H", node("PrimitiveInt", "@5 Height", value=704))
    math(g, "nf", f"floor(a*{FPS}/8)*8+1", "frames: 8n+1", a=["secs", 0])
    g.add("vlat", node("EmptyLTXVLatentVideo", width=["W", 0], height=["H", 0], length=["nf", 1], batch_size=1))
    g.add("img", node("LoadImage", "@1 Start image [image]", image=""))
    rs = node("ImageResizeKJv2", "start image to the video size", image=["img", 0], width=["W", 0], height=["H", 0],
              upscale_method="lanczos", keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=32, device="cpu")
    rs["_meta"]["deck_drop"] = True
    g.add("imgrs", rs)
    pre = node("LTXVPreprocess", "start image as video-like", image=["imgrs", 0], img_compression=18)
    pre["_meta"]["deck_drop"] = True
    g.add("pre", pre)
    i2v = node("LTXVImgToVideoInplace", "start image (skipped when empty)", vae=["vvae", 0], image=["pre", 0], latent=["vlat", 0],
               strength=0.7, bypass=False)
    i2v["_meta"]["deck_passthrough"] = "latent"
    g.add("i2v", i2v)
    audio_latent(g, ["nf", 1])
    g.add("av", node("LTXVConcatAVLatent", video_latent=["i2v", 0], audio_latent=["alat", 0]))
    sample(g, ["unet", 0], ["cond", 0], ["cond", 1], ["av", 0])
    decode(g, ["sep", 0], "ltx-t2v", audio=True)
    return g


def tracks():
    """A start image and paths drawn on it (LTXVSparseTrackEditor control points, pixels of the resized image): things
    under a path's start move along it. IC-LoRA motion-track (an LTX-2.3 LoRA that works on 2.5)."""
    g = G()
    models(g)
    text(g)
    g.add("img", node("LoadImage", "@1 Start image [image]", image=""))
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=5.0))
    g.add("short", node("PrimitiveInt", "@4 Resolution (short side)", value=704))
    math(g, "nf", f"floor(a*{FPS}/8)*8+1", "frames: 8n+1", a=["secs", 0])
    g.add("size", node("GetImageSize", image=["img", 0]))
    math(g, "W", "round(a*c/min(a,b)/64)*64", "width: short side to Resolution, x64 (the LoRA guide is half size)", a=["size", 0], b=["size", 1], c=["short", 0])
    math(g, "H", "round(b*c/min(a,b)/64)*64", "height, x64", a=["size", 0], b=["size", 1], c=["short", 0])
    g.add("rs", node("ImageResizeKJv2", image=["img", 0], width=["W", 1], height=["H", 1], upscale_method="lanczos",
                     keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=64, device="cpu"))
    g.add("paths", node("LTXVSparseTrackEditor", "@6 Tracks [points_store]", image=["rs", 0], points_store="[]", coordinates="[]",
                        points_to_sample=["nf", 1]))
    g.add("draw", node("LTXVDrawTracks", tracks=["paths", 0], width=["W", 1], height=["H", 1]))
    g.add("lora", node("LTXICLoRALoaderModelOnly", model=["unet", 0],
                       lora_name=LORA + "ltx-2.3-22b-ic-lora-motion-track-control-ref0.5.safetensors", strength_model=1.0))
    g.add("vlat", node("EmptyLTXVLatentVideo", width=["W", 1], height=["H", 1], length=["nf", 1], batch_size=1))
    g.add("i2v", node("LTXVImgToVideoInplace", vae=["vvae", 0], image=["rs", 0], latent=["vlat", 0], strength=0.7, bypass=False))
    g.add("guide", node("LTXAddVideoICLoRAGuide", positive=["cond", 0], negative=["cond", 1], vae=["vvae", 0], latent=["i2v", 0],
                        image=["draw", 0], frame_idx=0, strength=1.0, latent_downscale_factor=["lora", 1], crop="disabled",
                        use_tiled_encode=False, tile_size=256, tile_overlap=64, use_streaming=False, tile_frames=97))
    audio_latent(g, ["nf", 1])
    g.add("av", node("LTXVConcatAVLatent", video_latent=["guide", 2], audio_latent=["alat", 0]))
    sample(g, ["lora", 0], ["guide", 0], ["guide", 1], ["av", 0])
    g.add("crop", node("LTXVCropGuides", positive=["guide", 0], negative=["guide", 1], latent=["sep", 0]))
    decode(g, ["crop", 2], "ltx-tracks", audio=True)
    return g


TEMPLATES = {
    "deck-ltx-t2v": t2v,
    "deck-ltx-ripple": ripple,
    "deck-ltx-tracks": tracks,
    "deck-ltx-v2v-lora": lambda: v2v("ltx-v2v-lora", "ltx-2.5-22b-ic-lora-colorization-0.9.safetensors",
                                      lora_title="@5 IC-LoRA [lora_name,strength_model]"),
    "deck-ltx-alpha": lambda: v2v("ltx-alpha", "ltx-2.5-22b-ic-lora-alpha-gen-0.9.safetensors", prompt_title=None, max_frames=145),
    "deck-ltx-cleanplate": lambda: v2v(
        "ltx-cleanplate", "ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors",
        prompt="An empty clean plate of the exact same location: identical background, environment, structures and lighting as the "
               "source video, with no people, no humans, no figures, and no body parts such as arms, hands or legs anywhere in the "
               "frame. Static photorealistic footage, natural light, high detail.",
        negative="person, people, human, figure, limb, arm, hand, leg, body part, shadow of a person, blurry, distorted",
        negative_title="@6 Negative prompt"),
}

if __name__ == "__main__":
    for name, make in TEMPLATES.items():
        (OUT / f"{name}.json").write_text(json.dumps(make(), indent=1) + "\n")
        print("wrote", name)
