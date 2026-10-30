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
import re

UPSCALER = "minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors"
LADDER = (0.6316, 0.3158, 0.0)   # the pack examples' second pass, below where it starts
STRENGTHS = {"light": 0.6316, "medium": 0.8, "strong": 0.9035}
# Open-H3-Regenerate's second pass (RESEARCH-h3-regenerate.md): NVIDIA's 2-step schedule, and Enhanced's 3 steps from
# 0.8 on the refiner's shift-6 grid (rdh9616 ComfyUI-Open-H3-Regenerate shifted_grid(0.8, 3), the h3-studio test).
# The refiner LoRA is trained for exactly this pass, so it needs far fewer steps than the plain upscaler.
REGEN_SIGMAS = {"standard": (0.7, 0.494118, 0.0), "enhanced": (0.8, 0.685714, 0.48, 0.0)}
TURBO_RE = re.compile(r"turbo|lightx2v|distill|\d+[-_ ]?steps?", re.I)
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


def regen_sigmas(quality: str = "standard") -> str:
    """Open-H3-Regenerate's own schedule (Standard 2 steps or Enhanced from 0.8), never the upscaler's ladder."""
    return ", ".join(f"{x:.4f}" for x in REGEN_SIGMAS.get(quality, REGEN_SIGMAS["standard"]))


def fit_1080p(width: int, height: int) -> tuple[int, int]:
    """The largest 32-aligned frame within 1920x1080 with the clip's aspect (the Regenerate 1080P preset)."""
    k = min(1920 / max(1, width), 1080 / max(1, height), 2.5)
    return max(64, round(width * k / 32) * 32), max(64, round(height * k / 32) * 32)


def regen_loras(oi: dict | None) -> list[dict]:
    """The Open-H3-Regenerate LoRAs ComfyUI can load, and whether each has Turbo inside (a merged file, so the
    run's own turbo LoRA must come out; Kijai's refiner-only file keeps it)."""
    spec = (((oi or {}).get("LoraLoaderModelOnly") or {}).get("input") or {}).get("required") or {}
    names = (spec.get("lora_name") or [[], {}])[0]
    out = []
    for n in names:
        low = str(n).lower()
        if "regenerate" not in low:
            continue
        out.append({"name": n, "has_turbo": has_turbo(n)})
    return out


def has_turbo(name: str) -> bool:
    """A Regenerate LoRA with Turbo merged in (not Kijai's refiner-only file)."""
    low = str(name).lower()
    return not ("refiner" in low or "rank_384" in low)


def _chain(wf: dict, link) -> list[str]:
    """The LoRA nodes feeding a model link, nearest first."""
    out = []
    while is_link(link):
        node = wf.get(link[0])
        if not node:
            break
        out.append(link[0])
        link = node.get("inputs", {}).get("model")
    return out


def drop_turbo(wf: dict, link) -> None:
    """Take turbo/lightning LoRAs out of the model chain: whatever used their model takes their own input instead.
    A refiner that has Turbo merged in must not run on top of the run's turbo LoRA (it would double the distill)."""
    for nid in _chain(wf, link):
        node = wf.get(nid)
        if not node or node.get("class_type") not in ("LoraLoaderModelOnly", "LoraLoader"):
            continue
        if not TURBO_RE.search(str(node["inputs"].get("lora_name", ""))):
            continue
        if any(is_link(v) and v[0] == nid and v[1] == 1 for o in wf.values() for v in o.get("inputs", {}).values()):
            continue   # its clip output is in use: leave the node alone
        inner = node["inputs"].get("model")
        for o in wf.values():
            for k, v in list(o.get("inputs", {}).items()):
                if is_link(v) and v[0] == nid and v[1] == 0:
                    o["inputs"][k] = inner
        del wf[nid]


def drop_turbo_under_regen(wf: dict) -> dict:
    """Any template's run (Refine, Finish with H3): a Regenerate LoRA that has Turbo inside takes the turbo LoRAs
    beneath it out of the chain, as build() does for the upscale pass."""
    for node in list(wf.values()):
        name = str(node.get("inputs", {}).get("lora_name", ""))
        if node.get("class_type") in ("LoraLoaderModelOnly", "LoraLoader") and "regenerate" in name.lower() and has_turbo(name):
            drop_turbo(wf, node["inputs"].get("model"))
    return wf


def build(workflow: dict, video: str, width: int, height: int, scale: float = 1.5, prefix: str = "comfydeck/h3up",
          fps: float = 24, strength: float = STRENGTHS["strong"], regen: dict | None = None,
          size: tuple[int, int] | None = None) -> tuple[dict, tuple[int, int]]:
    """(the second-pass workflow, its frame size). video: the finished clip's path; width/height its frame size.
    regen: {lora, has_turbo, quality} runs Open-H3-Regenerate's refiner instead of the plain upscaler's ladder;
    size: an exact target (the 1080P preset), else the frame is scaled by `scale`."""
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
    W, H = size or target_size(width, height, scale)
    if regen and not regen.get("lora"):
        raise ValueError("Regenerate needs a refiner LoRA")
    if regen and regen.get("has_turbo"):   # the merge has Turbo inside: the run's own would double it
        drop_turbo(wf, model)
        model = guider["inputs"]["model"]

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
        "up_sigmas": ("ManualSigmas",
                      f"Regenerate from {REGEN_SIGMAS.get(regen.get('quality'), REGEN_SIGMAS['standard'])[0]:.2f}"
                      if regen else f"Second pass from {strength:.2f}",
                      dict(sigmas=regen_sigmas(regen.get("quality")) if regen else sigmas(strength))),
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
    if regen:   # the refiner LoRA goes last in the model chain, so it sees the run's own LoRAs
        add["up_lora"] = ("LoraLoaderModelOnly", "Open-H3-Regenerate refiner",
                          dict(model=model, lora_name=regen["lora"], strength_model=float(regen.get("strength") or 1.0)))
        add["up_guide"] = ("BasicGuider", None, dict(model=["up_lora", 0], conditioning=[cond_src, 0]))
    for nid, (cls, title, inputs) in add.items():
        wf[nid] = {"class_type": cls, "inputs": inputs, **({"_meta": {"title": title}} if title else {})}
    return wf, (W, H)
