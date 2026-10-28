"""ComfyChair's voice worker: runs in its own venv (DECK_VOICE_PY, default ~/Programs/comfydeck-voice/.venv),
so its torch and models never touch ComfyUI's. app/voice.py starts one run per job:

    python worker.py '<json>'      (prints progress lines "@progress 0.42 label", then one JSON result line)

{"op": "isolate", "src": wav, "out": wav, "steps": ["vocals", "dereverb", "denoise"]}
    The speaking voice alone: RoFormer passes from python-audio-separator (UVR models), each on the last one's output.
{"op": "transcribe", "src": wav, "language": null}
    faster-whisper: {"text", "language", "segments": [{start, end, text}]}.
{"op": "speak", "lines": [{"text", "ref": wav, "ref_text", "language", "out": wav}]}
    Qwen3-TTS (1.7B Base) voice cloning, one file per line, the model loaded once. It takes no delivery: [tags] are
    dropped. IndexTTS-2 and Fish S2, which do, are engine_index.py and engine_fish.py, in installs of their own.
"""
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

MODELS = Path(os.environ.get("DECK_VOICE_MODELS", Path(__file__).resolve().parent.parent.parent / "comfydeck-voice" / "models"))
# (separation model, the stem to keep: the first output whose name has one of these words)
STEPS = {
    "vocals": ("model_bs_roformer_ep_317_sdr_12.9755.ckpt", ["(vocals)"]),
    "dereverb": ("dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt", ["(noreverb)", "(no reverb)", "(dry)"]),
    "denoise": ("denoise_mel_band_roformer_aufr33_sdr_27.9959.ckpt", ["(dry)", "(no noise)", "(clean)"]),
}
TTS_MODEL = os.environ.get("DECK_TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
WHISPER_MODEL = os.environ.get("DECK_WHISPER_MODEL", "large-v3-turbo")


def progress(p: float, label: str):
    print(f"@progress {p:.3f} {label}", flush=True)


def _release():
    """Hand the card back between models."""
    import gc
    gc.collect()
    try:
        import torch
        torch.cuda.empty_cache()
    except ImportError:
        pass


def isolate(src: str, out: str, steps: list[str]) -> dict:
    from audio_separator.separator import Separator
    steps = [s for s in steps if s in STEPS] or ["vocals"]
    cur = src
    with tempfile.TemporaryDirectory() as td:
        for i, step in enumerate(steps):
            model, keep = STEPS[step]
            progress(i / len(steps), {"vocals": "Taking the voice out", "dereverb": "Taking the echo out",
                                      "denoise": "Taking the noise out"}[step])
            sep = Separator(output_dir=td, model_file_dir=str(MODELS / "audio_separator"), output_format="WAV",
                            log_level=40)
            sep.load_model(model_filename=model)
            files = [Path(td) / Path(f).name for f in sep.separate(cur)]
            pick = next((f for w in keep for f in files if w in f.name.lower()), None)
            if not pick:
                raise RuntimeError(f"{step}: no {keep[0]} stem among {[f.name for f in files]}")
            nxt = Path(td) / f"step{i}.wav"
            pick.replace(nxt)
            for f in files:
                f.unlink(missing_ok=True)
            cur = str(nxt)
            del sep
            _release()
        shutil.copyfile(cur, out)
    progress(1, "Done")
    return {"out": out, "steps": steps}


def transcribe(src: str, language=None) -> dict:
    from faster_whisper import WhisperModel
    progress(0.1, "Listening")
    try:
        model = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16", download_root=str(MODELS / "whisper"))
        segs, info = model.transcribe(src, language=language or None, vad_filter=True)
        segs = list(segs)
    except RuntimeError as e:   # no usable CUDA libraries for ctranslate2: slower, but it works
        print(f"whisper on the CPU ({e})", file=sys.stderr)
        model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", download_root=str(MODELS / "whisper"))
        segs, info = model.transcribe(src, language=language or None, vad_filter=True)
    segments = [{"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()} for s in segs]
    progress(1, "Done")
    return {"text": " ".join(s["text"] for s in segments).strip(), "language": info.language, "segments": segments}


def plain(text: str) -> str:
    """The line without Fish S2's [tags], which Qwen would read out; its delivery words are ignored here."""
    import re
    return re.sub(r"\s{2,}", " ", re.sub(r"\[[^\]]*\]", " ", text)).strip() or text


def speak(lines: list[dict]) -> dict:
    import soundfile as sf
    import torch
    from qwen_tts import Qwen3TTSModel
    progress(0.02, "Loading the voice model")
    model = Qwen3TTSModel.from_pretrained(TTS_MODEL, device_map="cuda:0", dtype=torch.bfloat16)
    outs = []
    prompts = {}   # one cloned-voice prompt per reference, reused for its lines
    for i, ln in enumerate(lines):
        progress(0.05 + 0.95 * i / len(lines), f"Line {i + 1} of {len(lines)}")
        key = (ln["ref"], ln.get("ref_text") or "")
        if key not in prompts and hasattr(model, "create_voice_clone_prompt"):
            prompts[key] = model.create_voice_clone_prompt(ref_audio=ln["ref"], ref_text=ln.get("ref_text") or None,
                                                           x_vector_only_mode=not ln.get("ref_text"))
        if key in prompts:
            wavs, sr = model.generate_voice_clone(text=plain(ln["text"]), language=ln.get("language") or "Auto",
                                                  voice_clone_prompt=prompts[key])
        else:
            wavs, sr = model.generate_voice_clone(text=plain(ln["text"]), language=ln.get("language") or "Auto",
                                                  ref_audio=ln["ref"], ref_text=ln.get("ref_text") or None)
        sf.write(ln["out"], wavs[0], sr)
        outs.append({"out": ln["out"], "seconds": round(len(wavs[0]) / sr, 2)})
    progress(1, "Done")
    return {"lines": outs}


def main():
    job = json.loads(sys.argv[1])
    op = job.pop("op")
    try:
        res = {"isolate": isolate, "transcribe": transcribe, "speak": speak}[op](**job)
        print(json.dumps({"ok": True, **res}), flush=True)
    except Exception as e:   # reported to the user as the job's error
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
