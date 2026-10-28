"""ComfyChair: MMAudio from a clip, with the picture taken at the rates the model was trained on.

kijai's MMAudio Sampler (ComfyUI-MMAudio) takes one frame batch for both of MMAudio's inputs: the picture features
at 8 fps and the sync features at 25 fps. Fed a 24 or 25 fps clip, the picture side gets only its first third (the
first 2.5 s of an 8 s clip). Deck MMAudio Sampler is the same sampler, but it picks each input's frames by time from
a clip at its own frame rate. It uses the pack's own model code (found among the loaded nodes), so the pack itself
stays untouched.
"""
import sys

import torch
from torchvision.transforms import v2

import comfy.model_management as mm

CLIP_SIZE, CLIP_FPS, SYNC_SIZE, SYNC_FPS = 384, 8.0, 224, 25.0


def _pack():
    """The loaded ComfyUI-MMAudio nodes module (its generate and FlowMatching)."""
    for m in list(sys.modules.values()):
        maps = getattr(m, "NODE_CLASS_MAPPINGS", None)
        if isinstance(maps, dict) and "MMAudioSampler" in maps and hasattr(m, "generate"):
            return m
    raise RuntimeError("Deck MMAudio Sampler needs the ComfyUI-MMAudio nodes (kijai) installed and loaded")


def _at(frames, fps, rate, secs):
    """The frames at times 0, 1/rate, 2/rate … before secs, from a clip at fps (nearest frame)."""
    n = int(rate * secs)
    idx = torch.clamp((torch.arange(n) * fps / rate).round().long(), max=frames.shape[0] - 1)
    return frames[idx]


class DeckMMAudioSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "mmaudio_model": ("MMAUDIO_MODEL",),
            "feature_utils": ("MMAUDIO_FEATUREUTILS",),
            "images": ("IMAGE", {"tooltip": "The clip's frames, at its own frame rate (fps)."}),
            "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0, "step": 0.001}),
            "duration": ("FLOAT", {"default": 8.0, "min": 0.5, "max": 60.0, "step": 0.01,
                                   "tooltip": "Seconds of sound; never longer than the clip. MMAudio was trained on 8 s."}),
            "steps": ("INT", {"default": 25, "min": 1, "max": 200}),
            "cfg": ("FLOAT", {"default": 4.5, "min": 0.0, "max": 20.0, "step": 0.1}),
            "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff}),
            "prompt": ("STRING", {"default": "", "multiline": True}),
            "negative_prompt": ("STRING", {"default": "", "multiline": True}),
        }}

    RETURN_TYPES = ("AUDIO",)
    FUNCTION = "sample"
    CATEGORY = "ComfyChair"

    def sample(self, mmaudio_model, feature_utils, images, fps, duration, steps, cfg, seed, prompt, negative_prompt):
        P = _pack()
        device, offload = mm.get_torch_device(), mm.unet_offload_device()
        secs = min(duration, images.shape[0] / fps)
        clip_tf = v2.Compose([v2.Resize((CLIP_SIZE, CLIP_SIZE), interpolation=v2.InterpolationMode.BICUBIC, antialias=True)])
        sync_tf = v2.Compose([v2.Resize(SYNC_SIZE, interpolation=v2.InterpolationMode.BICUBIC, antialias=True), v2.CenterCrop(SYNC_SIZE),
                              v2.Normalize(mean=[0.5] * 3, std=[0.5] * 3)])
        clip = clip_tf(_at(images, fps, CLIP_FPS, secs).movedim(-1, 1).float()).clamp(0, 1)
        sync = sync_tf(_at(images, fps, SYNC_FPS, secs).movedim(-1, 1).float())
        secs = min(clip.shape[0] / CLIP_FPS, sync.shape[0] / SYNC_FPS)
        cfgq = mmaudio_model.seq_cfg
        cfgq.duration = secs
        mmaudio_model.update_seq_lengths(cfgq.latent_seq_len, cfgq.clip_seq_len, cfgq.sync_seq_len)
        rng = torch.Generator(device=device)
        rng.manual_seed(seed)
        feature_utils.to(device)
        mmaudio_model.to(device)
        try:
            audio = P.generate(clip[None].to(device), sync[None].to(device), [prompt], negative_text=[negative_prompt],
                               feature_utils=feature_utils, net=mmaudio_model, fm=P.FlowMatching(min_sigma=0, inference_mode="euler", num_steps=steps),
                               rng=rng, cfg_strength=cfg)
        finally:
            mmaudio_model.to(offload)
            feature_utils.to(offload)
            mm.soft_empty_cache()
        return ({"waveform": audio.float().cpu(), "sample_rate": 44100},)


NODE_CLASS_MAPPINGS = {"DeckMMAudioSampler": DeckMMAudioSampler}
NODE_DISPLAY_NAME_MAPPINGS = {"DeckMMAudioSampler": "Deck MMAudio Sampler"}
