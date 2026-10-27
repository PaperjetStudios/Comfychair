"""Write the VFX tab's Performance templates (character replacement, driving a still with a performance).

Run: python3 dev/make_perf_templates.py   (then ↻ templates in ComfyDeck)

Shares the graph helpers of make_ltx_templates.py. Field titles follow web/vfx.js ROLES (README "VFX templates").
"""
import json

from make_ltx_templates import FPS, OUT, G, audio_latent, decode, math, models, node, sample, text

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


def pose_frames(g, image, face=True, hands=True, model="dwpose"):
    """The clip's body, hands and face landmarks on every frame, steadied over the clip, as an OpenPose-style picture
    (id posers). model "dwpose": DWPose (CPU, onnx). "sdpose": SDPose wholebody (GPU), on the people RT-DETR finds;
    it scores each point, and Min score drops the guesses."""
    on = lambda b: "enable" if b else "disable"
    if model == "sdpose":
        g.add("sdm", node("CheckpointLoaderSimple", ckpt_name="sdpose_wholebody_fp16.safetensors"))
        g.add("det", node("UNETLoader", unet_name="rt_detr_v4-x-hgnet_fp16.safetensors", weight_dtype="default"))
        g.add("boxes", node("RTDETR_detect", "@13 People [max_detections]", model=["det", 0], image=image, threshold=0.5,
                            class_name="person", max_detections=2))
        g.add("pose", node("SDPoseKeypointExtractor", model=["sdm", 0], vae=["sdm", 2], image=image, batch_size=16,
                           bboxes=["boxes", 0]))
        kps, size = ["pose", 0], image
    else:
        g.add("pose", node("DWPreprocessor", image=image, detect_hand=on(hands), detect_body="enable", detect_face=on(face),
                           resolution=512, bbox_detector="yolox_l.onnx", pose_estimator="dw-ll_ucoco_384.onnx",
                           scale_stick_for_xinsr_cn="disable"))
        kps, size = ["pose", 1], ["pose", 0]
    # each frame is looked at on its own, so the points shake: steadied over the clip (comfy_nodes/deck_posesmooth)
    g.add("steady", node("DeckPoseSmooth", "@12 Pose smoothing [smoothing,max_gap,min_score]", pose_keypoint=kps, image=size,
                         smoothing=2.0, max_gap=6, min_score=0.3, draw_hands=hands, draw_face=face))
    # DWPose answers at its own resolution (odd sizes happen): back to the clip's W x H
    g.add("posers", node("ImageResizeKJv2", image=["steady", 0], width=["W", 1], height=["H", 1], upscale_method="bilinear",
                         keep_proportion="stretch", pad_color="0, 0, 0", crop_position="center", divisible_by=2, device="cpu"))


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


def drive(model="dwpose"):
    """A still of a character acted out by the performer in a clip: DWPose (body, hands, face) from the clip drives
    H3's Fun ControlNet on a reference-to-video shot of the character. Built on deck-h3-ctrl2v (same models and
    settings), with the clip's own sound kept."""
    base = json.loads((OUT / "deck-h3-ctrl2v.json").read_text())
    g = G()
    keep = {"1", "2", "3", "4", "6", "9", "10", "11", "12", "13", "30", "50", "51"}
    for k in keep:
        g.add(k, base[k])
    h3_source(g)
    pose_frames(g, ["rs", 0], model=model)
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
    g["51"]["inputs"]["control_video"] = ["posers", 0]
    g["51"]["_meta"] = {"title": "@5 Control [strength,end_percent]"}
    g["51"]["inputs"]["end_percent"] = 0.6
    g.add("aud", node("TrimAudioDuration", audio=["src", 2], start_index=0.0, duration=["secs", 0]))
    g.add("vid", node("CreateVideo", images=["13", 0], fps=FPS, audio=["aud", 0]))
    g.add("save", node("SaveVideo", video=["vid", 0], filename_prefix="deck/h3-drive", format="auto", codec="auto"))
    return g


def pose_preview(model="dwpose"):
    """What a drive run will follow: the clip's pose (body, hands, face) as a video. DWPose runs on the CPU; SDPose
    (model "sdpose") on the GPU."""
    g = G()
    h3_source(g, short=512)
    pose_frames(g, ["rs", 0], model=model)
    g.add("vid", node("CreateVideo", images=["posers", 0], fps=FPS))
    g.add("save", node("SaveVideo", video=["vid", 0], filename_prefix="deck/pose", format="auto", codec="auto"))
    return g


def ltx_drive(model="dwpose"):
    """LTX-2.5 take on Drive a still: the character image is the first frame, and the clip's DWPose (body, hands, face)
    guides the motion through the union-control IC-LoRA (an LTX-2.3 LoRA; ref0.5, so the guide is half size and
    both sides are x64). Single stage at the chosen resolution, with new sound from the prompt."""
    g = G()
    models(g)
    text(g)
    g.add("src", node("VHS_LoadVideoPath", "@1 Source video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
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
    pose_frames(g, ["rs", 0], model=model)
    g.add("img", node("LoadImage", "@11 Character [image]", image=""))
    g.add("imgrs", node("ImageResizeKJv2", image=["img", 0], width=["W", 1], height=["H", 1], upscale_method="lanczos",
                        keep_proportion="crop", pad_color="0, 0, 0", crop_position="center", divisible_by=64, device="cpu"))
    g.add("lora", node("LTXICLoRALoaderModelOnly", model=["unet", 0],
                       lora_name="ltx2.3/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors", strength_model=1.0))
    g.add("vlat", node("EmptyLTXVLatentVideo", width=["W", 1], height=["H", 1], length=["nf", 1], batch_size=1))
    g.add("i2v", node("LTXVImgToVideoInplace", vae=["vvae", 0], image=["imgrs", 0], latent=["vlat", 0], strength=1.0, bypass=False))
    g.add("guide", node("LTXAddVideoICLoRAGuide", "@5 Control [strength]", positive=["cond", 0], negative=["cond", 1], vae=["vvae", 0],
                        latent=["i2v", 0], image=["posers", 0], frame_idx=0, strength=1.0, latent_downscale_factor=["lora", 1],
                        crop="disabled", use_tiled_encode=False, tile_size=256, tile_overlap=64, use_streaming=False, tile_frames=97))
    audio_latent(g, ["nf", 1])
    g.add("av", node("LTXVConcatAVLatent", video_latent=["guide", 2], audio_latent=["alat", 0]))
    sample(g, ["lora", 0], ["guide", 0], ["guide", 1], ["av", 0])
    g.add("crop", node("LTXVCropGuides", positive=["guide", 0], negative=["guide", 1], latent=["sep", 0]))
    decode(g, ["crop", 2], "ltx-drive", audio=True)
    return g


def face_mask(g, nid, image):
    """A mask of the face points DWPose finds (face only), at the image's own size."""
    g.add(nid + "pose", node("DWPreprocessor", image=image, detect_hand="disable", detect_body="disable", detect_face="enable",
                             resolution=512, bbox_detector="yolox_l.onnx", pose_estimator="dw-ll_ucoco_384.onnx",
                             scale_stick_for_xinsr_cn="disable"))
    g.add(nid + "size", node("GetImageSize", image=image))
    g.add(nid + "rs", node("ImageResizeKJv2", image=[nid + "pose", 0], width=[nid + "size", 0], height=[nid + "size", 1],
                           upscale_method="nearest-exact", keep_proportion="stretch", pad_color="0, 0, 0", crop_position="center",
                           divisible_by=1, device="cpu"))
    g.add(nid, node("ImageToMask", image=[nid + "rs", 0], channel="red"))


def faceswap():
    """Only the face: Deck Face Crop follows the face through the clip (DWPose face points), Viggle-Animate re-renders
    that square as the character's face, and Deck Face Uncrop blends it back into the full-size frame. Body, hair
    past the oval, clothes and background stay the original footage."""
    g = G()
    g.add("src", node("VHS_LoadVideoPath", "@1 Source video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
                      frame_load_cap=0, skip_first_frames=0, select_every_nth=1))
    g.add("secs", node("PrimitiveFloat", "@3 Length (seconds)", value=5.0))
    math(g, "nf", f"min(a, round(b*{FPS}))", "frames within the clip and Length", a=["src", 1], b=["secs", 0])
    g.add("cut", node("ImageFromBatch", image=["src", 0], batch_index=0, length=["nf", 1]))
    g.add("short", node("PrimitiveInt", "@4 Resolution (short side)", value=512))
    g.add("scale", node("PrimitiveFloat", "@5 Face area", value=1.8))
    face_mask(g, "fmask", ["cut", 0])
    g.add("crop", node("DeckFaceCrop", images=["cut", 0], mask=["fmask", 0], scale=["scale", 0], size=["short", 0], smooth=0.6))
    g.add("img", node("LoadImage", "@11 Character [image]", image=""))
    face_mask(g, "cmask", ["img", 0])
    g.add("cface", node("DeckFaceCrop", images=["img", 0], mask=["cmask", 0], scale=["scale", 0], size=["short", 0], smooth=0.0))
    g.add("tcond", node("ViggleTextCondLoader", text_cond=VIGGLE_COND))
    g.add("vae", node("VAELoader", vae_name=H3_VAE))
    g.add("unet", node("UNETLoader", unet_name=VIGGLE_UNET, weight_dtype="default"))
    g.add("lora", node("LoraLoaderModelOnly", model=["unet", 0], lora_name=VIGGLE_LORA, strength_model=1.0))
    g.add("shift", node("MiniMaxH3SigmaShift", model=["lora", 0], shift_video=3.0, shift_audio=3.0))
    g.add("cond", node("ViggleAnimateConditioningWindowed", cond_video=["crop", 0], ref_image=["cface", 0], text_cond=["tcond", 0],
                       vae=["vae", 0], width=0, height=0, chunk_frames=124, overlap_frames=22, continuation="five_frame_anchor"))
    g.add("guider", node("BasicGuider", model=["shift", 0], conditioning=["cond", 1]))
    g.add("ksel", node("KSamplerSelect", sampler_name="euler"))
    g.add("sig", node("ManualSigmas", "@6 Steps [sigmas]", sigmas=VIGGLE_SIGMAS))
    g.add("run", node("ViggleChunkedSampler", "@8 Seed [seed]", guider=["guider", 0], sampler=["ksel", 0], sigmas=["sig", 0],
                      cond_set=["cond", 0], vae=["vae", 0], seed=42, rerender_chunk=0, rerender_seed=0))
    g.add("paste", node("DeckFaceUncrop", "@7 Blend [shape,grow,feather,chin]", images=["cut", 0], crops=["run", 0],
                        crop_info=["crop", 1], feather=0.25, shape="face", grow=1.05, chin=0.82))
    g.add("aud", node("TrimAudioDuration", audio=["src", 2], start_index=0.0, duration=["secs", 0]))
    g.add("vid", node("CreateVideo", images=["paste", 0], fps=FPS, audio=["aud", 0]))
    g.add("save", node("SaveVideo", video=["vid", 0], filename_prefix="deck/h3-faceswap", format="auto", codec="auto"))
    return g


def mocap():
    """Video mocap for the 3D tab: SAM 3D Body reads the person's 3D pose on every frame (RT-DETR finds them first),
    smoothed over time, and Deck Save Body Motion writes it as the 22-joint motion file a figure takes
    (web/scene-motion.js, From video…)."""
    g = G()
    g.add("src", node("VHS_LoadVideoPath", "@1 Source video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
                      frame_load_cap=0, skip_first_frames=0, select_every_nth=1))
    g.add("secs", node("PrimitiveFloat", "@2 Length (seconds) [value]", value=10.0))
    math(g, "nf", f"max(1, min(a, round(b*{FPS})))", "frames within the clip and Length", a=["src", 1], b=["secs", 0])
    g.add("cut", node("ImageFromBatch", image=["src", 0], batch_index=0, length=["nf", 1]))
    g.add("det", node("UNETLoader", unet_name="rt_detr_v4-x-hgnet_fp16.safetensors", weight_dtype="default"))
    g.add("boxes", node("RTDETR_detect", "@3 People [max_detections]", model=["det", 0], image=["cut", 0], threshold=0.5,
                        class_name="person", max_detections=1))
    g.add("body", node("SAM3DBody_Loader", model_file="sam_3d_body_dinov3_bf16.safetensors"))
    g.add("pose", node("SAM3DBody_Predict", sam3d_body_model=["body", 0], image=["cut", 0], bboxes=["boxes", 0],
                       run_hand_refinement=False, fov=0.0, batch_size=32))
    g.add("smooth", node("SAM3DBody_Smooth", "@4 Smoothing [strength,window]", mhr_pose_data=["pose", 0], strength=1.0,
                         method="gaussian", window=7, rotation_threshold_degrees=30.0))
    g.add("save", node("DeckSaveBodyMotion", mhr_pose_data=["smooth", 0], fps=float(FPS), person=0, filename_prefix="deck/mocap"))
    return g


TEMPLATES = {
    "deck-h3-animate": animate,
    "deck-h3-drive": drive,
    "deck-h3-drive-sd": lambda: drive("sdpose"),
    "deck-pose-video": pose_preview,
    "deck-mocap": mocap,
    "deck-pose-sdpose": lambda: pose_preview("sdpose"),
    "deck-ltx-drive": ltx_drive,
    "deck-ltx-drive-sd": lambda: ltx_drive("sdpose"),
    "deck-h3-faceswap": faceswap,
}

if __name__ == "__main__":
    for name, make in TEMPLATES.items():
        (OUT / f"{name}.json").write_text(json.dumps(make(), indent=1) + "\n")
        print("wrote", name)
