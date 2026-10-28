"""Write the VFX tab's LTX-2.5 templates (templates/deck-ltx-*.json) from shared pieces.

Run: python3 dev/make_ltx_templates.py   (then ↻ templates in ComfyChair)

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


def text(g, prompt_title="@2 Prompt", prompt=""):
    """The prompt, encoded once. Every graph samples at CFG 1, which never reads the negative, so the negative is the
    prompt zeroed out rather than a second pass through the 12B text encoder (about a minute on 12 GB)."""
    if prompt_title:
        g.add("prompt", node("PrimitiveStringMultiline", prompt_title, value=prompt))
        pos = ["prompt", 0]
    else:
        pos = prompt
    g.add("pos", node("CLIPTextEncode", text=pos, clip=["clip", 0]))
    g.add("neg", node("ConditioningZeroOut", conditioning=["pos", 0]))
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
    """The clip decoded by LTX's own tiled decoder: 4x4 tiles, 16 latent frames (128 frames) at a time with one
    latent frame of overlap. ComfyUI's VAEDecodeTiled cut the clip every 64 frames and blended the joins, so one
    frame in every 64 came out soft (frame 56 at 29 % of the clip's sharpness); this has no soft frames and decodes
    1920x1088 x 10 s inside 12 GB."""
    g.add("vdec", node("LTXVSpatioTemporalTiledVAEDecode", vae=["vvae", 0], latents=samples, spatial_tiles=4, spatial_overlap=1,
                       temporal_tile_length=16, temporal_overlap=1, last_frame_fix=False, working_device="auto", working_dtype="auto"))
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


def v2v(name, lora, strength=1.0, lora_title=None, prompt_title="@2 Prompt", prompt="", max_frames=None, audio=False):
    """Source video → an IC-LoRA's take on it (restyle, alpha matte, clean plate)."""
    g = G()
    models(g)
    text(g, prompt_title, prompt)
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
                         "while consistently propagating the visual edit established in the first frame throughout the video.")
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
    g.add("loras", node("LoraLoaderModelOnly", "@6 LoRAs", model=["unet", 0], lora_name="",
                        strength_model=1.0))   # (no default: the stack starts empty, and an empty stack is bypassed)
    model, pos, neg = voice(g, ["loras", 0], ["cond", 0], ["cond", 1])
    sample(g, model, pos, neg, ["av", 0])
    decode(g, ["sep", 0], "ltx-t2v", audio=True)
    return g


def sized_start(g, nid, title, mult=32, short=704):
    """@ image, its size giving the clip's: short side to Resolution, both sides multiples of mult. Gives ids nid (the
    picture), nid+"rs" (resized), nid+"pre" (made video-like, as LTX wants a conditioning frame), W and H (math INT at 1)."""
    g.add(nid, node("LoadImage", title, image=""))
    g.add("short", node("PrimitiveInt", "@4 Resolution (short side)", value=short))
    g.add(nid + "size", node("GetImageSize", image=[nid, 0]))
    math(g, "W", f"round(a*c/min(a,b)/{mult})*{mult}", f"width: short side to Resolution, x{mult}", a=[nid + "size", 0], b=[nid + "size", 1], c=["short", 0])
    math(g, "H", f"round(b*c/min(a,b)/{mult})*{mult}", "height", a=[nid + "size", 0], b=[nid + "size", 1], c=["short", 0])
    frame(g, nid, nid)


def frame(g, nid, image):
    """A picture resized to the clip (W, H) and made video-like: ids nid+"rs", nid+"pre"."""
    g.add(nid + "rs", node("ImageResizeKJv2", image=[image, 0], width=["W", 1], height=["H", 1], upscale_method="lanczos",
                           keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=32, device="cpu"))
    g.add(nid + "pre", node("LTXVPreprocess", image=[nid + "rs", 0], img_compression=18))


def i2v(last=False):
    """A start picture (and, with last, an end picture) to a clip with sound, the size of the start picture. The last
    frame is a guide at the clip's end (LTXVAddGuide at -1), cropped off the latent before decoding."""
    g = G()
    models(g)
    text(g)
    sized_start(g, "first", "@1 Start image [image]")
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=5.0))
    math(g, "nf", f"floor(a*{FPS}/8)*8+1", "frames: 8n+1", a=["secs", 0])
    g.add("vlat", node("EmptyLTXVLatentVideo", width=["W", 1], height=["H", 1], length=["nf", 1], batch_size=1))
    g.add("i2v", node("LTXVImgToVideoInplace", vae=["vvae", 0], image=["firstpre", 0], latent=["vlat", 0], strength=1.0, bypass=False))
    pos, neg, lat = ["cond", 0], ["cond", 1], ["i2v", 0]
    if last:
        g.add("last", node("LoadImage", "@2 End image [image]", image=""))
        frame(g, "last", "last")
        g.add("guide", node("LTXVAddGuide", "@2 End image [strength]", positive=pos, negative=neg, vae=["vvae", 0], latent=lat,
                            image=["lastpre", 0], frame_idx=-1, strength=1.0))
        pos, neg, lat = ["guide", 0], ["guide", 1], ["guide", 2]
    audio_latent(g, ["nf", 1])
    g.add("av", node("LTXVConcatAVLatent", video_latent=lat, audio_latent=["alat", 0]))
    g.add("loras", node("LoraLoaderModelOnly", "@6 LoRAs", model=["unet", 0], lora_name="", strength_model=1.0))
    model, vpos, vneg = voice(g, ["loras", 0], pos, neg)
    sample(g, model, vpos, vneg, ["av", 0])
    if last:
        g.add("crop", node("LTXVCropGuides", positive=["guide", 0], negative=["guide", 1], latent=["sep", 0]))
        decode(g, ["crop", 2], "ltx-flf2v", audio=True)
    else:
        decode(g, ["sep", 0], "ltx-i2v", audio=True)
    return g


def ctrl2v():
    """Control union: a depth, pose or edge clip (the 3D tab's renders, VFX Depth map or Pose preview, or any clip of
    them) leads the motion and layout through the union-control IC-LoRA (an LTX-2.3 LoRA; ref0.5, so the guide is half
    size and both sides are x64), with an optional start picture for the look. New sound from the prompt."""
    g = G()
    models(g)
    text(g)
    g.add("src", node("VHS_LoadVideoPath", "@1 Control video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
                      frame_load_cap=0, skip_first_frames=0, select_every_nth=1))
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=5.0))
    math(g, "nf", f"floor((min(a, b*{FPS}+1)-1)/8)*8+1", "frames: 8n+1 within the clip and Length", a=["src", 1], b=["secs", 0])
    g.add("cut", node("ImageFromBatch", image=["src", 0], batch_index=0, length=["nf", 1]))
    g.add("short", node("PrimitiveInt", "@4 Resolution (short side)", value=576))
    g.add("size", node("GetImageSize", image=["cut", 0]))
    math(g, "W", "round(a*c/min(a,b)/64)*64", "width: short side to Resolution, x64 (the LoRA guide is half size)", a=["size", 0], b=["size", 1], c=["short", 0])
    math(g, "H", "round(b*c/min(a,b)/64)*64", "height, x64", a=["size", 0], b=["size", 1], c=["short", 0])
    g.add("rs", node("ImageResizeKJv2", image=["cut", 0], width=["W", 1], height=["H", 1], upscale_method="lanczos",
                     keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=64, device="cpu"))
    g.add("lora", node("LTXICLoRALoaderModelOnly", model=["unet", 0],
                       lora_name="ltx2.3/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors", strength_model=1.0))
    g.add("vlat", node("EmptyLTXVLatentVideo", width=["W", 1], height=["H", 1], length=["nf", 1], batch_size=1))
    g.add("img", node("LoadImage", "@11 Start image [image]", image=""))
    rs = node("ImageResizeKJv2", "start image to the video size", image=["img", 0], width=["W", 1], height=["H", 1],
              upscale_method="lanczos", keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=64, device="cpu")
    rs["_meta"]["deck_drop"] = True
    g.add("imgrs", rs)
    st = node("LTXVImgToVideoInplace", "start image (skipped when empty)", vae=["vvae", 0], image=["imgrs", 0], latent=["vlat", 0],
              strength=1.0, bypass=False)
    st["_meta"]["deck_passthrough"] = "latent"
    g.add("i2v", st)
    g.add("guide", node("LTXAddVideoICLoRAGuide", "@5 Control [strength]", positive=["cond", 0], negative=["cond", 1], vae=["vvae", 0],
                        latent=["i2v", 0], image=["rs", 0], frame_idx=0, strength=1.0, latent_downscale_factor=["lora", 1],
                        crop="disabled", use_tiled_encode=False, tile_size=256, tile_overlap=64, use_streaming=False, tile_frames=97))
    audio_latent(g, ["nf", 1])
    g.add("av", node("LTXVConcatAVLatent", video_latent=["guide", 2], audio_latent=["alat", 0]))
    sample(g, ["lora", 0], ["guide", 0], ["guide", 1], ["av", 0])
    g.add("crop", node("LTXVCropGuides", positive=["guide", 0], negative=["guide", 1], latent=["sep", 0]))
    decode(g, ["crop", 2], "ltx-ctrl2v", audio=True)
    return g


def voice(g, model, positive, negative):
    """@7 Voice: an optional sound of someone speaking (~5 s) whose voice the clip's speech takes on
    (LTXVReferenceAudio). Left empty, the node is skipped and model/positive/negative pass straight on."""
    g.add("vref", node("VHS_LoadAudio", "@7 Voice [audio_file]", audio_file="", seek_seconds=0, duration=0))
    v = node("LTXVReferenceAudio", "@7 Voice [identity_guidance_scale]", model=model, positive=positive, negative=negative,
             reference_audio=["vref", 0], audio_vae=["avae", 0], identity_guidance_scale=3.0, start_percent=0.0, end_percent=1.0)
    v["_meta"]["deck_passthrough"] = ["model", "positive", "negative"]
    g.add("voice", v)
    return ["voice", 0], ["voice", 1], ["voice", 2]


def a2v():
    """A sound (speech, music) and a prompt, optionally a start image, to a clip that moves to the sound: lips,
    beats and timing follow it. The sound is encoded and frozen (kept as it is) while the picture is made, and
    the clip keeps the original sound. Length: the sound's, up to @3 Length."""
    g = G()
    models(g)
    text(g)
    g.add("snd", node("VHS_LoadAudio", "@1 Sound [audio_file]", audio_file="", seek_seconds=0, duration=0))
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=10.0))
    g.add("W", node("PrimitiveInt", "@4 Width", value=1280))
    g.add("H", node("PrimitiveInt", "@5 Height", value=704))
    # 8n+1 frames no longer than the sound (so the encoded sound covers every frame) or Length
    math(g, "nf", f"max(9, floor((min(a, b)*{FPS}-1)/8)*8+1)", "frames: 8n+1 within the sound and Length", a=["snd", 1], b=["secs", 0])
    math(g, "dur", f"a/{FPS}", "the clip's length in seconds", a=["nf", 1])
    g.add("cut", node("TrimAudioDuration", audio=["snd", 0], start_index=0.0, duration=["dur", 0]))
    g.add("vlat", node("EmptyLTXVLatentVideo", width=["W", 0], height=["H", 0], length=["nf", 1], batch_size=1))
    g.add("img", node("LoadImage", "@2 Start image [image]", image=""))
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
    g.add("aenc", node("LTXVAudioVAEEncode", audio=["cut", 0], audio_vae=["avae", 0]))
    g.add("alat", node("LTXVFreezeLatent", "the sound stays as it is", latent=["aenc", 0]))
    g.add("av", node("LTXVConcatAVLatent", video_latent=["i2v", 0], audio_latent=["alat", 0]))
    g.add("loras", node("LoraLoaderModelOnly", "@6 LoRAs", model=["unet", 0], lora_name="", strength_model=1.0))
    sample(g, ["loras", 0], ["cond", 0], ["cond", 1], ["av", 0])
    g.add("vdec", node("LTXVSpatioTemporalTiledVAEDecode", vae=["vvae", 0], latents=["sep", 0], spatial_tiles=4, spatial_overlap=1,
                       temporal_tile_length=16, temporal_overlap=1, last_frame_fix=False, working_device="auto", working_dtype="auto"))   # (see decode)
    g.add("vid", node("CreateVideo", images=["vdec", 0], fps=FPS, audio=["cut", 0]))
    g.add("save", node("SaveVideo", video=["vid", 0], filename_prefix="deck/ltx-a2v", format="auto", codec="auto"))
    return g


def t2a():
    """Text to sound: effects, ambience, foley, speech, from LTX-2.5 run audio-only (no picture, so it's quick).
    Saved as an MP3."""
    g = G()
    models(g)
    text(g, "@1 Prompt", "")
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=8.0))
    math(g, "nf", f"floor(a*{FPS}/8)*8+1", "frames: 8n+1", a=["secs", 0])
    g.add("loras", node("LoraLoaderModelOnly", "@6 LoRAs", model=["unet", 0], lora_name="", strength_model=1.0))
    g.add("aonly", node("LTXVAudioOnlyModel", model=["loras", 0]))
    g.add("vlat", node("LTXVAudioOnlyEmptyVideoLatent"))
    audio_latent(g, ["nf", 1])
    g.add("av", node("LTXVConcatAVLatent", video_latent=["vlat", 0], audio_latent=["alat", 0]))
    sample(g, ["aonly", 0], ["cond", 0], ["cond", 1], ["av", 0])
    g.add("adec", node("LTXVAudioVAEDecode", samples=["sep", 1], audio_vae=["avae", 0]))
    g.add("save", node("SaveAudioMP3", audio=["adec", 0], filename_prefix="deck/ltx-t2a", quality="V0"))
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


def sized_image(g, nid, image, mult=64):
    """An image resized so its short side is @4 Resolution, both sides multiples of mult. W, H: math INT at output 1."""
    g.add("short", node("PrimitiveInt", "@4 Resolution (short side)", value=704 if mult == 32 else 576))
    g.add("isize", node("GetImageSize", image=image))
    math(g, "W", f"round(a*c/min(a,b)/{mult})*{mult}", f"width: short side to Resolution, x{mult}", a=["isize", 0], b=["isize", 1], c=["short", 0])
    math(g, "H", f"round(b*c/min(a,b)/{mult})*{mult}", f"height, x{mult}", a=["isize", 0], b=["isize", 1], c=["short", 0])
    g.add(nid, node("ImageResizeKJv2", image=image, width=["W", 1], height=["H", 1], upscale_method="lanczos",
                    keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=mult, device="cpu"))


def ingredients():
    """One reference sheet (people, props, place laid out) held as the guide for every frame."""
    g = G()
    models(g)
    text(g)
    g.add("img", node("LoadImage", "@1 Ingredients sheet [image]", image=""))
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=5.0))
    math(g, "nf", f"floor(a*{FPS}/8)*8+1", "frames: 8n+1", a=["secs", 0])
    sized_image(g, "rs", ["img", 0])
    g.add("sheet", node("RepeatImageBatch", "the sheet on every frame", image=["rs", 0], amount=["nf", 1]))
    g.add("lora", node("LTXICLoRALoaderModelOnly", model=["unet", 0], lora_name=LORA + "ltx-2.5-22b-ic-lora-ingredients-0.9.safetensors",
                       strength_model=1.3))
    ic_guide(g, ["lora", 1], ["sheet", 0], ["nf", 1])
    audio_latent(g, ["nf", 1])
    g.add("av", node("LTXVConcatAVLatent", video_latent=["guide", 2], audio_latent=["alat", 0]))
    sample(g, ["lora", 0], ["guide", 0], ["guide", 1], ["av", 0], sampler="euler_ancestral_cfg_pp")
    g.add("crop", node("LTXVCropGuides", positive=["guide", 0], negative=["guide", 1], latent=["sep", 0]))
    decode(g, ["crop", 2], "ltx-ingredients", audio=True)
    return g


def layout():
    """A rough layout clip (a 3D tab render, a playblast) and a still that sets the look: the clip's camera and
    placement, the still's palette, light and materials. Single stage at the chosen resolution."""
    g = G()
    models(g)
    text(g)
    g.add("src", node("VHS_LoadVideoPath", "@1 Layout video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
                      frame_load_cap=0, skip_first_frames=0, select_every_nth=1))
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=5.0))
    math(g, "nf", f"floor((min(a, b*{FPS}+1)-1)/8)*8+1", "frames: 8n+1 within the clip and Length", a=["src", 1], b=["secs", 0])
    g.add("cut", node("ImageFromBatch", image=["src", 0], batch_index=0, length=["nf", 1]))
    sized_image(g, "rs", ["cut", 0])
    g.add("look", node("LoadImage", "@2 First frame [image]", image=""))
    g.add("lookrs", node("ImageResizeKJv2", image=["look", 0], width=["W", 1], height=["H", 1], upscale_method="lanczos",
                         keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=64, device="cpu"))
    g.add("lora", node("LTXICLoRALoaderModelOnly", model=["unet", 0], lora_name=LORA + "ltx-2.5-22b-ic-lora-layout-to-render-1.0.safetensors",
                       strength_model=1.0))
    g.add("vlat", node("EmptyLTXVLatentVideo", width=["W", 1], height=["H", 1], length=["nf", 1], batch_size=1))
    g.add("i2v", node("LTXVImgToVideoInplace", vae=["vvae", 0], image=["lookrs", 0], latent=["vlat", 0], strength=1.0, bypass=False))
    g.add("guide", node("LTXAddVideoICLoRAGuide", positive=["cond", 0], negative=["cond", 1], vae=["vvae", 0], latent=["i2v", 0],
                        image=["rs", 0], frame_idx=0, strength=1.0, latent_downscale_factor=["lora", 1], crop="disabled",
                        use_tiled_encode=False, tile_size=256, tile_overlap=64, use_streaming=False, tile_frames=97))
    audio_latent(g, ["nf", 1])
    g.add("av", node("LTXVConcatAVLatent", video_latent=["guide", 2], audio_latent=["alat", 0]))
    sample(g, ["lora", 0], ["guide", 0], ["guide", 1], ["av", 0])
    g.add("crop", node("LTXVCropGuides", positive=["guide", 0], negative=["guide", 1], latent=["sep", 0]))
    decode(g, ["crop", 2], "ltx-layout", audio=False)
    return g


def upscale():
    """Detail at a larger size: tiled fusion (overlapping tiles fused every step) with the refine-details IC-LoRA."""
    g = G()
    models(g)
    text(g, "@2 Prompt", "Sharp, detailed, high quality footage, natural light, fine texture.")
    g.add("src", node("VHS_LoadVideoPath", "@1 Source video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
                      frame_load_cap=0, skip_first_frames=0, select_every_nth=1))
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=5.0))
    math(g, "nf", f"floor((min(a, b*{FPS}+1)-1)/8)*8+1", "frames: 8n+1 within the clip and Length", a=["src", 1], b=["secs", 0])
    g.add("cut", node("ImageFromBatch", image=["src", 0], batch_index=0, length=["nf", 1]))
    g.add("tiles", node("LTXVGetTilingSizes", "@5 Output size [output_size]", image=["cut", 0], width=1920, height=1080, frame_count=["nf", 1],
                        tile_size="HD", initial_canvas_size="FullHD", output_size="FullHD"))
    g.add("vlat", node("EmptyLTXVLatentVideo", width=["tiles", 4], height=["tiles", 5], length=["nf", 1], batch_size=1))
    g.add("big", node("ImageScale", image=["cut", 0], upscale_method="lanczos", width=["tiles", 4], height=["tiles", 5], crop="disabled"))
    g.add("lora", node("LTXICLoRALoaderModelOnly", model=["unet", 0], lora_name=LORA + "ltx-2.5-22b-ic-lora-refine-details-1.0.safetensors",
                       strength_model=1.0))
    g.add("guide", node("LTXAddVideoICLoRAGuide", positive=["cond", 0], negative=["cond", 1], vae=["vvae", 0], latent=["vlat", 0],
                        image=["big", 0], frame_idx=0, strength=1.0, latent_downscale_factor=["lora", 1], crop="disabled",
                        use_tiled_encode=False, tile_size=256, tile_overlap=64, use_streaming=True, tile_frames=["tiles", 7]))
    g.add("ksel", node("KSamplerSelect", sampler_name="euler"))
    g.add("sig", node("ManualSigmas", sigmas=SIGMAS))
    g.add("run", node("LTXVTiledFusionSampler", "@8 Seed [seed]", model=["lora", 0], positive=["guide", 0], negative=["guide", 1],
                      latents=["guide", 2], sigmas=["sig", 0], sampler=["ksel", 0], vae=["vvae", 0], seed=42, cfg=1.0,
                      tile_width=["tiles", 2], tile_height=["tiles", 3], overlap_frac=["tiles", 6], blend_var=0.05, grid_cycle=1,
                      tile_frames=["tiles", 7], canvas_device="auto"))
    decode(g, ["run", 0], "ltx-upscale", audio=False)
    return g


def sam3_mask():
    """A clip to a mask clip (white = the thing) with SAM3: described in text, or clicked on one frame (points in
    pixels of the clip), followed both ways from that frame."""
    g = G()
    g.add("src", node("VHS_LoadVideoPath", "@1 Source video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
                      frame_load_cap=0, skip_first_frames=0, select_every_nth=1))
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=5.0))
    math(g, "nf", f"min(a, round(b*{FPS}))", "frames within the clip and Length", a=["src", 1], b=["secs", 0])
    g.add("cut", node("ImageFromBatch", image=["src", 0], batch_index=0, length=["nf", 1]))
    g.add("pf", node("PrimitiveInt", "@6 Points frame", value=0))
    g.add("pframe", node("ImageFromBatch", image=["cut", 0], batch_index=["pf", 0], length=1))
    g.add("pts", node("SAM3PointCollector", "@5 Points [coordinates,neg_coordinates]", image=["pframe", 0], points_store="{}",
                      coordinates="[]", neg_coordinates="[]"))
    g.add("model", node("LoadSAM3Model", precision="auto", compile=False))
    g.add("seg", node("SAM3VideoSegmentation", "@2 Prompt [prompt_mode,text_prompt]", video_frames=["cut", 0], prompt_mode="text",
                      text_prompt="person", positive_points=["pts", 0], negative_points=["pts", 1], frame_idx=["pf", 0], score_threshold=0.3))
    g.add("prop", node("SAM3Propagate", sam3_model_config=["model", 0], video_state=["seg", 0], start_frame=0, end_frame=-1, direction="both"))
    g.add("out", node("SAM3VideoOutput", masks=["prop", 0], video_state=["prop", 2], scores=["prop", 1], obj_id=-1, plot_all_masks=True))
    g.add("img", node("MaskToImage", mask=["out", 0]))
    g.add("vid", node("CreateVideo", images=["img", 0], fps=FPS))
    g.add("save", node("SaveVideo", video=["vid", 0], filename_prefix="deck/sam3-mask", format="auto", codec="auto"))
    return g


def inpaint():
    """Replace what a mask clip covers (white) with what the prompt says; the rest of the picture is kept and blended
    back. The in/outpainting IC-LoRA (LTX-2.3) on a green-filled guide, single stage at the chosen resolution."""
    g = G()
    models(g)
    text(g)
    g.add("src", node("VHS_LoadVideoPath", "@1 Source video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
                      frame_load_cap=0, skip_first_frames=0, select_every_nth=1))
    g.add("msk", node("VHS_LoadVideoPath", "@5 Mask video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
                      frame_load_cap=0, skip_first_frames=0, select_every_nth=1))
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=5.0))
    math(g, "nf", f"floor((min(a, c, b*{FPS}+1)-1)/8)*8+1", "frames: 8n+1 within both clips and Length",
         a=["src", 1], b=["secs", 0], c=["msk", 1])
    g.add("cut", node("ImageFromBatch", image=["src", 0], batch_index=0, length=["nf", 1]))
    sized_image(g, "rs", ["cut", 0])
    g.add("mcut", node("ImageFromBatch", image=["msk", 0], batch_index=0, length=["nf", 1]))
    g.add("mrs", node("ImageResizeKJv2", image=["mcut", 0], width=["W", 1], height=["H", 1], upscale_method="area",
                      keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=64, device="cpu"))
    g.add("mask", node("ImageToMask", image=["mrs", 0], channel="red"))
    g.add("grow", node("PrimitiveInt", "@7 Grow mask (px)", value=15))
    g.add("dil", node("LTXVDilateVideoMask", mask=["mask", 0], spatial_radius=["grow", 0], temporal_radius=0))
    g.add("green", node("LTXVInpaintPreprocess", images=["rs", 0], mask=["dil", 0]))
    g.add("lora", node("LTXICLoRALoaderModelOnly", model=["unet", 0], lora_name=LORA + "ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors",
                       strength_model=1.0))
    g.add("vlat", node("EmptyLTXVLatentVideo", width=["W", 1], height=["H", 1], length=["nf", 1], batch_size=1))
    # an optional first frame as it should come out (Extend frame: the clip on its canvas with the new parts already
    # painted, e.g. by an image edit with reference pictures): LTX carries it on into the masked areas
    g.add("first", node("LoadImage", "@8 Start frame [image]", image=""))
    rs = node("ImageResizeKJv2", "start frame to the video size", image=["first", 0], width=["W", 1], height=["H", 1],
              upscale_method="lanczos", keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=64, device="cpu")
    rs["_meta"]["deck_drop"] = True
    g.add("firstrs", rs)
    pre = node("LTXVPreprocess", "start frame as video-like", image=["firstrs", 0], img_compression=18)
    pre["_meta"]["deck_drop"] = True
    g.add("firstpre", pre)
    st = node("LTXVImgToVideoInplace", "start frame (skipped when empty)", vae=["vvae", 0], image=["firstpre", 0], latent=["vlat", 0],
              strength=1.0, bypass=False)
    st["_meta"]["deck_passthrough"] = "latent"
    g.add("i2v", st)
    g.add("guide", node("LTXAddVideoICLoRAGuideAdvanced", positive=["cond", 0], negative=["cond", 1], vae=["vvae", 0], latent=["i2v", 0],
                        image=["green", 0], frame_idx=0, strength=1.0, latent_downscale_factor=1, crop="disabled", use_tiled_encode=False,
                        tile_size=256, tile_overlap=64, attention_strength=1.0, use_streaming=False, tile_frames=97))
    audio_latent(g, ["nf", 1])
    g.add("av", node("LTXVConcatAVLatent", video_latent=["guide", 2], audio_latent=["alat", 0]))
    sample(g, ["lora", 0], ["guide", 0], ["guide", 1], ["av", 0])
    g.add("crop", node("LTXVCropGuides", positive=["guide", 0], negative=["guide", 1], latent=["sep", 0]))
    g.add("vdec", node("LTXVSpatioTemporalTiledVAEDecode", vae=["vvae", 0], latents=["crop", 2], spatial_tiles=4, spatial_overlap=1,
                       temporal_tile_length=16, temporal_overlap=1, last_frame_fix=False, working_device="auto", working_dtype="auto"))   # (see decode)
    g.add("blend", node("LTXVLaplacianPyramidBlend", image_a=["vdec", 0], image_b=["green", 0], mask=["dil", 0], trim_to_shortest=True,
                        mask_low_res_dilation=5))
    math(g, "asecs", f"a/{FPS}", "the result's length, for its sound", a=["nf", 1])
    g.add("aud", node("TrimAudioDuration", audio=["src", 2], start_index=0.0, duration=["asecs", 0]))   # the clip's own sound, kept
    g.add("vid", node("CreateVideo", images=["blend", 0], fps=FPS, audio=["aud", 0]))
    g.add("save", node("SaveVideo", video=["vid", 0], filename_prefix="deck/ltx-inpaint", format="auto", codec="auto"))
    return g


TEMPLATES = {
    "deck-ltx-t2v": t2v,
    "deck-ltx-i2v": i2v,
    "deck-ltx-flf2v": lambda: i2v(last=True),
    "deck-ltx-ctrl2v": ctrl2v,
    "deck-ltx-a2v": a2v,
    "deck-ltx-t2a": t2a,
    "deck-ltx-ripple": ripple,
    "deck-ltx-tracks": tracks,
    "deck-ltx-ingredients": ingredients,
    "deck-ltx-layout": layout,
    "deck-ltx-upscale": upscale,
    "deck-sam3-video-mask": sam3_mask,
    "deck-ltx-inpaint": inpaint,
    "deck-ltx-v2v-lora": lambda: v2v("ltx-v2v-lora", "ltx-2.5-22b-ic-lora-colorization-0.9.safetensors",
                                      lora_title="@5 IC-LoRA [lora_name,strength_model]"),
    "deck-ltx-alpha": lambda: v2v("ltx-alpha", "ltx-2.5-22b-ic-lora-alpha-gen-0.9.safetensors", prompt_title=None, max_frames=145),
    "deck-ltx-cleanplate": lambda: v2v(
        "ltx-cleanplate", "ltx-2.5-22b-ic-lora-clean-plate-1.0.safetensors",
        prompt="An empty clean plate of the exact same location: identical background, environment, structures and lighting as the "
               "source video, with no people, no humans, no figures, and no body parts such as arms, hands or legs anywhere in the "
               "frame. Static photorealistic footage, natural light, high detail."),
}

if __name__ == "__main__":
    for name, make in TEMPLATES.items():
        (OUT / f"{name}.json").write_text(json.dumps(make(), indent=1) + "\n")
        print("wrote", name)
