"""Write the Sound tab's music template (templates/deck-ace-music.json). Sound effects come from
dev/make_ltx_templates.py (deck-ltx-t2a).

Run: python3 dev/make_sound_templates.py   (then ↻ templates in ComfyChair)

ACE-Step 1.5 turbo, after ComfyUI's own example (audio_ace_step_1_5_checkpoint): the all-in-one checkpoint
(Comfy-Org/ace_step_1.5_ComfyUI_files, checkpoints/ace_step_1.5_turbo_aio.safetensors, 9.3 GB), AuraFlow shift 3,
8 steps, CFG 1, a zeroed negative. The Sound tab finds the fields by input (tags, lyrics) and by "Length".
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "templates"
CKPT = "ace_step_1.5_turbo_aio.safetensors"


def node(cls, title=None, **inputs):
    n = {"class_type": cls, "inputs": inputs}
    if title:
        n["_meta"] = {"title": title}
    return n


def ace_music():
    """Style tags (and optional lyrics) to a song or an instrumental, saved as FLAC."""
    return {
        "ckpt": node("CheckpointLoaderSimple", "@9 Model [ckpt_name]", ckpt_name=CKPT),
        "secs": node("PrimitiveFloat", "@3 Length (seconds)", value=60.0),
        "enc": node("TextEncodeAceStepAudio1.5", "@1 Music [tags,lyrics,bpm,keyscale,language]", clip=["ckpt", 1],
                    tags="lo-fi hip hop, warm piano, soft drums, vinyl crackle, mellow", lyrics="", seed=0, bpm=90,
                    duration=["secs", 0], timesignature="4", language="en", keyscale="C major", generate_audio_codes=True,
                    cfg_scale=2.0, temperature=0.85, top_p=0.9, top_k=0, min_p=0.0),
        "neg": node("ConditioningZeroOut", conditioning=["enc", 0]),
        "shift": node("ModelSamplingAuraFlow", model=["ckpt", 0], shift=3.0),
        "lat": node("EmptyAceStep1.5LatentAudio", seconds=["secs", 0], batch_size=1),
        "run": node("KSampler", "@8 Seed [seed]", model=["shift", 0], positive=["enc", 0], negative=["neg", 0],
                    latent_image=["lat", 0], seed=42, steps=8, cfg=1.0, sampler_name="euler", scheduler="simple", denoise=1.0),
        "dec": node("VAEDecodeAudio", samples=["run", 0], vae=["ckpt", 2]),
        "save": node("SaveAudioAdvanced", audio=["dec", 0], filename_prefix="deck/ace-music", format="flac"),
    }


def mmaudio_foley():
    """A clip to its sound (foley, effects, ambience) with MMAudio large 44k v2: the clip's picture at 8 fps and
    25 fps (Deck MMAudio Sampler, comfy_nodes/deck_mmaudio), a prompt and a negative prompt to steer it. Trained on
    8 s; longer works but drifts. Saved as FLAC, as long as the clip (or Length)."""
    return {
        "src": node("VHS_LoadVideoPath", "@1 Source video [video]", video="", force_rate=0, custom_width=0, custom_height=384,
                    frame_load_cap=0, skip_first_frames=0, select_every_nth=1),
        "info": node("VHS_VideoInfoLoaded", video_info=["src", 3]),
        "secs": node("PrimitiveFloat", "@3 Length (seconds)", value=8.0),
        "prompt": node("PrimitiveStringMultiline", "@2 Prompt", value=""),
        "negp": node("PrimitiveStringMultiline", "@4 Negative prompt", value="music, speech, talking, singing"),
        "model": node("MMAudioModelLoader", mmaudio_model="mmaudio_large_44k_v2_fp16.safetensors", base_precision="fp16"),
        "feat": node("MMAudioFeatureUtilsLoader", vae_model="mmaudio_vae_44k_fp16.safetensors",
                     synchformer_model="mmaudio_synchformer_fp16.safetensors", clip_model="apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors",
                     mode="44k", precision="fp16"),
        "run": node("DeckMMAudioSampler", "@8 Seed [seed]", mmaudio_model=["model", 0], feature_utils=["feat", 0], images=["src", 0],
                    fps=["info", 0], duration=["secs", 0], steps=25, cfg=4.5, seed=42, prompt=["prompt", 0], negative_prompt=["negp", 0]),
        "save": node("SaveAudioAdvanced", audio=["run", 0], filename_prefix="deck/mmaudio-foley", format="flac"),
    }


TEMPLATES = {"deck-ace-music": ace_music, "deck-mmaudio-foley": mmaudio_foley}

if __name__ == "__main__":
    for name, make in TEMPLATES.items():
        (OUT / f"{name}.json").write_text(json.dumps(make(), indent=1) + "\n")
        print("wrote", name)
