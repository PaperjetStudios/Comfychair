"""Write the VFX tab's Performance templates (character replacement, driving a still with a performance).

Run: python3 dev/make_perf_templates.py   (then ↻ templates in ComfyDeck)

Shares the graph helpers of make_ltx_templates.py. Field titles follow web/vfx.js ROLES (README "VFX templates").
"""
import json

from make_ltx_templates import FPS, OUT, G, math, node

# Viggle-Animate: a MiniMax-H3 ref2va finetune for character replacement (ComfyUI-Viggle-Animate-H3)
VIGGLE_UNET = "minimax_h3_ref2va_viggle_pruned_int8_convrot.safetensors"
VIGGLE_LORA = "viggle_animate_dmd_lora_r64.safetensors"
VIGGLE_COND = "fixed_embed_fwd_anyframe.safetensors"
H3_VAE = "minimax_h3_video_vae_int8_convrot.safetensors"
# upstream DMD schedule (shift 3): 4 points = 3 Euler updates; the VFX tab offers 6 and 8 too
VIGGLE_SIGMAS = "1.0, 0.8571428571428571, 0.6, 0.0"


def animate():
    """A driving clip and a still of a character: the clip's performer re-rendered as the character, with the clip's
    motion, camera, timing, background and light. Long clips run in overlapping 124-frame windows."""
    g = G()
    g.add("src", node("VHS_LoadVideoPath", "@1 Source video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
                      frame_load_cap=0, skip_first_frames=0, select_every_nth=1))
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=5.0))
    math(g, "nf", f"min(a, round(b*{FPS}))", "frames within the clip and Length", a=["src", 1], b=["secs", 0])
    g.add("cut", node("ImageFromBatch", image=["src", 0], batch_index=0, length=["nf", 1]))
    g.add("short", node("PrimitiveInt", "@4 Resolution (short side)", value=480))
    g.add("size", node("GetImageSize", image=["cut", 0]))
    math(g, "W", "round(a*c/min(a,b)/32)*32", "width: short side to Resolution, x32", a=["size", 0], b=["size", 1], c=["short", 0])
    math(g, "H", "round(b*c/min(a,b)/32)*32", "height", a=["size", 0], b=["size", 1], c=["short", 0])
    g.add("rs", node("ImageResizeKJv2", image=["cut", 0], width=["W", 1], height=["H", 1], upscale_method="lanczos",
                     keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=32, device="cpu"))
    g.add("img", node("LoadImage", "@11 Character [image]", image=""))
    g.add("tcond", node("ViggleTextCondLoader", text_cond=VIGGLE_COND))
    g.add("vae", node("VAELoader", vae_name=H3_VAE))
    g.add("unet", node("UNETLoader", unet_name=VIGGLE_UNET, weight_dtype="default"))
    g.add("lora", node("LoraLoaderModelOnly", model=["unet", 0], lora_name=VIGGLE_LORA, strength_model=1.0))
    g.add("shift", node("MiniMaxH3SigmaShift", model=["lora", 0], shift_video=3.0, shift_audio=3.0))
    g.add("cond", node("ViggleAnimateConditioningWindowed", cond_video=["rs", 0], ref_image=["img", 0], text_cond=["tcond", 0],
                       vae=["vae", 0], width=0, height=0, chunk_frames=124, overlap_frames=22, continuation="five_frame_anchor"))
    g.add("guider", node("BasicGuider", model=["shift", 0], conditioning=["cond", 1]))
    g.add("ksel", node("KSamplerSelect", sampler_name="euler"))
    g.add("sig", node("ManualSigmas", "@6 Steps [sigmas]", sigmas=VIGGLE_SIGMAS))
    g.add("run", node("ViggleChunkedSampler", "@8 Seed [seed]", guider=["guider", 0], sampler=["ksel", 0], sigmas=["sig", 0],
                      cond_set=["cond", 0], vae=["vae", 0], seed=42, rerender_chunk=0, rerender_seed=0))
    # the model's own audio is silent: keep the clip's sound, cut to Length
    g.add("aud", node("TrimAudioDuration", audio=["src", 2], start_index=0.0, duration=["secs", 0]))
    g.add("vid", node("CreateVideo", images=["run", 0], fps=FPS, audio=["aud", 0]))
    g.add("save", node("SaveVideo", video=["vid", 0], filename_prefix="deck/h3-animate", format="auto", codec="auto"))
    return g


def pose_frames(g, image, face=True, hands=True):
    """DWPose (CPU, onnx) on every frame: body, hands and face landmarks as an OpenPose-style picture."""
    on = lambda b: "enable" if b else "disable"
    g.add("pose", node("DWPreprocessor", image=image, detect_hand=on(hands), detect_body="enable", detect_face=on(face),
                       resolution=512, bbox_detector="yolox_l.onnx", pose_estimator="dw-ll_ucoco_384.onnx",
                       scale_stick_for_xinsr_cn="disable"))


def h3_source(g, short=448):
    """@1 Source video cut to the H3 frame grid (17k+5, within the clip and Length) and resized so the short side is
    Resolution (x32). Gives ids: cut (frames), nf (frames at output 1), W, H (math INT at output 1), rs."""
    g.add("src", node("VHS_LoadVideoPath", "@1 Source video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
                      frame_load_cap=0, skip_first_frames=0, select_every_nth=1))
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=5.0))
    math(g, "nf", f"5 + floor((max(5, min(a, round(b*{FPS}))) - 5)/17)*17", "frames: 17k+5 within the clip and Length",
         a=["src", 1], b=["secs", 0])
    g.add("cut", node("ImageFromBatch", image=["src", 0], batch_index=0, length=["nf", 1]))
    g.add("short", node("PrimitiveInt", "@4 Resolution (short side)", value=short))
    g.add("size", node("GetImageSize", image=["cut", 0]))
    math(g, "W", "round(a*c/min(a,b)/32)*32", "width: short side to Resolution, x32", a=["size", 0], b=["size", 1], c=["short", 0])
    math(g, "H", "round(b*c/min(a,b)/32)*32", "height", a=["size", 0], b=["size", 1], c=["short", 0])
    g.add("rs", node("ImageResizeKJv2", image=["cut", 0], width=["W", 1], height=["H", 1], upscale_method="lanczos",
                     keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=32, device="cpu"))


def drive():
    """A still of a character acted out by the performer in a clip: DWPose (body, hands, face) from the clip drives
    H3's Fun ControlNet on a reference-to-video shot of the character. Built on deck-h3-ctrl2v (same models and
    settings), with the clip's own sound kept."""
    base = json.loads((OUT / "deck-h3-ctrl2v.json").read_text())
    g = G()
    keep = {"1", "2", "3", "4", "6", "9", "10", "11", "12", "13", "30", "50", "51"}
    for k in keep:
        g.add(k, base[k])
    h3_source(g)
    pose_frames(g, ["rs", 0])
    g.add("8", node("RandomNoise", "@8 Seed", noise_seed=0))
    g.add("prompt", node("PrimitiveStringMultiline", "@2 Prompt", value="<Subject 1> is the person shown in <Picture 1>. "
                         "They speak and move exactly as in the control video, with the same expressions. Natural light, cinematic."))
    g.add("img", node("LoadImage", "@11 Character [image]", image=""))
    shot = base["7"]
    shot["_meta"] = {"title": "Shot"}
    shot["inputs"] = {k: v for k, v in shot["inputs"].items() if not k.startswith("ref_images.")}
    shot["inputs"].update({"prompt": ["prompt", 0], "width": ["W", 1], "height": ["H", 1], "length": ["nf", 1],
                           "ref_images.ref_image_0": ["img", 0]})
    g.add("7", shot)
    g["51"]["inputs"]["control_video"] = ["pose", 0]
    g["51"]["_meta"] = {"title": "@5 Control [strength,end_percent]"}
    g["51"]["inputs"]["end_percent"] = 0.6
    g.add("aud", node("TrimAudioDuration", audio=["src", 2], start_index=0.0, duration=["secs", 0]))
    g.add("vid", node("CreateVideo", images=["13", 0], fps=FPS, audio=["aud", 0]))
    g.add("save", node("SaveVideo", video=["vid", 0], filename_prefix="deck/h3-drive", format="auto", codec="auto"))
    return g


def pose_preview():
    """What a drive run will follow: the clip's DWPose (body, hands, face) as a video. CPU only."""
    g = G()
    h3_source(g, short=512)
    pose_frames(g, ["rs", 0])
    g.add("vid", node("CreateVideo", images=["pose", 0], fps=FPS))
    g.add("save", node("SaveVideo", video=["vid", 0], filename_prefix="deck/pose", format="auto", codec="auto"))
    return g


TEMPLATES = {
    "deck-h3-animate": animate,
    "deck-h3-drive": drive,
    "deck-pose-video": pose_preview,
}

if __name__ == "__main__":
    for name, make in TEMPLATES.items():
        (OUT / f"{name}.json").write_text(json.dumps(make(), indent=1) + "\n")
        print("wrote", name)
