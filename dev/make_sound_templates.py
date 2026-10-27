"""Write the Sound tab's music template (templates/deck-ace-music.json). Sound effects come from
dev/make_ltx_templates.py (deck-ltx-t2a).

Run: python3 dev/make_sound_templates.py   (then ↻ templates in ComfyDeck)

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


TEMPLATES = {"deck-ace-music": ace_music}

if __name__ == "__main__":
    for name, make in TEMPLATES.items():
        (OUT / f"{name}.json").write_text(json.dumps(make(), indent=1) + "\n")
        print("wrote", name)
