"""Upscale a finished MiniMax H3 clip with its own run's prompt, LoRAs and references (POST /api/h3/upscale).

The run's saved workflow is the starting point, so the second pass sees exactly what the first did: the same model
chain (LoRAs, turbo LoRA, attention patches), text, reference pictures and sounds, and seed. The finished clip is
encoded back into H3's video latent, made bigger by the MiniMax H3 latent upscaler
(Comfyui_Minimax_h3_latent_Upscaler), and sampled again from part-way (3 steps from sigma 0.90, as the pack's
examples do; Strength light or medium starts lower, at 0.63 or 0.80, which keeps faces and poses closer to the clip
and sharpens less). Its sound is the clip's own, so speech stays in sync. Reference-to-video conditioning doesn't depend
on the frame size, so it is reused; image-to-video's carries its keyframes at the frame size, so that node is run
again at the new size.
"""
import copy

UPSCALER = "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors"
LADDER = (0.6316, 0.3158, 0.0)   # the pack examples' second pass, below where it starts
STRENGTHS = {"light": 0.6316, "medium": 0.8, "strong": 0.9035}
SAMPLER = "euler"
SIZE_FREE = {"MiniMaxH3ReferenceToVideo"}   # conditioning that doesn't depend on the frame size
OUTPUTS = {"VHS_VideoCombine", "SaveVideo", "SaveImage", "PreviewImage", "SaveAnimatedWEBP", "SaveWEBM", "CreateVideo",
           "VAEDecode", "VAEDecodeAudio", "VAEDecodeTiled"}


def is_link(v) -> bool:
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str)


def h3_node(wf: dict) -> str | None:
    """The MiniMax H3 node that makes the run's conditioning and latent."""
    for nid, n in wf.items():
        c = n.get("class_type", "")
        if c.startswith("MiniMaxH3") and "width" in n.get("inputs", {}) and "vae" in n["inputs"]:
            return nid
    return None


def _sampler(wf: dict, h3: str) -> str:
    for nid, n in wf.items():
        if n.get("class_type") == "SamplerCustomAdvanced" and n["inputs"].get("latent_image") == [h3, 1]:
            return nid
    raise ValueError("This run's sampler isn't the usual one: it can't be upscaled here")


def _int(wf: dict, v) -> int | None:
    """A plain number, or one a PrimitiveInt feeds."""
    if isinstance(v, (int, float)):
        return int(v)
    if is_link(v) and wf.get(v[0], {}).get("class_type") in ("PrimitiveInt", "PrimitiveFloat"):
        return int(wf[v[0]]["inputs"]["value"])
    return None


def target_size(w: int, h: int, scale: float) -> tuple[int, int]:
    return max(64, round(w * scale / 32) * 32), max(64, round(h * scale / 32) * 32)


def sigmas(strength: float) -> str:
    """The second pass's schedule: from strength (the sigma it starts at) down the ladder to 0."""
    return ", ".join(f"{x:.4f}" for x in (strength, *(x for x in LADDER if x < strength - 0.01)))


def build(workflow: dict, video: str, width: int, height: int, scale: float = 1.5, prefix: str = "comfydeck/h3up",
          fps: float = 24, strength: float = STRENGTHS["strong"]) -> tuple[dict, tuple[int, int]]:
    """(the second-pass workflow, its frame size). video: the finished clip's path; width/height its frame size."""
    wf = copy.deepcopy(workflow)
    h3 = h3_node(wf)
    if not h3:
        raise ValueError("Only MiniMax H3 runs can be upscaled this way")
    s = wf[_sampler(wf, h3)]["inputs"]
    guider = wf[s["guider"][0]]
    if guider.get("class_type") != "BasicGuider":
        raise ValueError("This run's guider isn't the usual one: it can't be upscaled here")
    model, noise = guider["inputs"]["model"], s["noise"]
    vae = wf[h3]["inputs"]["vae"]
    W, H = target_size(width, height, scale)

    for nid in [k for k, n in wf.items() if n.get("class_type") in OUTPUTS]:   # the first pass's outputs
        del wf[nid]
    cond_src = h3
    if wf[h3]["class_type"] not in SIZE_FREE:   # its keyframes are encoded at the frame size: again, at the new one
        cond_src = "up_cond"
        wf[cond_src] = copy.deepcopy(wf[h3])
        wf[cond_src]["inputs"].update(width=W, height=H)
        wf[cond_src].setdefault("_meta", {})["title"] = "H3 conditioning at the upscaled size"

    add = {
        "up_src": ("VHS_LoadVideoPath", "The finished clip", dict(video=video, force_rate=0, custom_width=0, custom_height=0,
                                                                 frame_load_cap=0, skip_first_frames=0, select_every_nth=1)),
        "up_enc": ("VAEEncode", "Back into H3's latent", dict(pixels=["up_src", 0], vae=vae)),
        "up_scale": ("MinimaxH3LatentUpscaler3D", f"Latent upscale to {W}x{H}",
                     {"latent": ["up_enc", 0], "model_name": UPSCALER, "mode": "target dimensions", "mode.width": W,
                      "mode.height": H, "align": 32, "enable_temporal_chunking": False, "force_unload": True,
                      "device": "cuda", "precision": "bf16"}),
        # the sound part of the latent: the run's own empty one (the clip's real sound goes on at the end)
        "up_split": ("LTXVSeparateAVLatent", None, dict(av_latent=[cond_src, 1])),
        "up_av": ("LTXVConcatAVLatent", None, dict(video_latent=["up_scale", 0], audio_latent=["up_split", 1])),
        "up_sigmas": ("ManualSigmas", f"Second pass from {strength:.2f}", dict(sigmas=sigmas(strength))),
        "up_sampler": ("KSamplerSelect", None, dict(sampler_name=SAMPLER)),
        "up_guide": ("BasicGuider", None, dict(model=model, conditioning=[cond_src, 0])),
        "up_run": ("SamplerCustomAdvanced", None, dict(noise=noise, guider=["up_guide", 0], sampler=["up_sampler", 0],
                                                       sigmas=["up_sigmas", 0], latent_image=["up_av", 0])),
        "up_dec": ("VAEDecode", None, dict(samples=["up_run", 0], vae=vae)),
        "up_save": ("VHS_VideoCombine", None, dict(images=["up_dec", 0], audio=["up_src", 2], frame_rate=fps, loop_count=0,
                                                   filename_prefix=prefix, format="video/h264-mp4", pix_fmt="yuv420p",
                                                   crf=19, save_metadata=True, trim_to_audio=False, pingpong=False,
                                                   save_output=True)),
    }
    for nid, (cls, title, inputs) in add.items():
        wf[nid] = {"class_type": cls, "inputs": inputs, **({"_meta": {"title": title}} if title else {})}
    return wf, (W, H)
