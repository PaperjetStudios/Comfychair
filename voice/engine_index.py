"""IndexTTS-2 for the Sound tab's dialogue: a saved voice speaks each line, in the way its delivery words say
("whispering, scared"). Runs in IndexTTS-2's own venv (DECK_INDEX_TTS: the cloned index-tts repo, its .venv and
checkpoints/); app/voice.py starts it with the same protocol as worker.py:

    python engine_index.py '<json>'   {"lines": [{"text", "ref": wav, "out": wav, "delivery", "intensity"}]}

prints "@progress p label" lines, then one JSON line {"ok": true, "lines": [{"out", "seconds"}]}.
Inline [tags] are for Fish S2: they are dropped here, since IndexTTS-2 would read them out.
"""
import json
import os
import re
import sys
from pathlib import Path

HOME = Path(os.environ.get("DECK_INDEX_TTS", "/mnt/data/comfydeck-voice-engines/index-tts"))


def progress(p: float, label: str):
    print(f"@progress {p:.3f} {label}", flush=True)


def plain(text: str) -> str:
    return re.sub(r"\s{2,}", " ", re.sub(r"\[[^\]]*\]", " ", text)).strip()


def speak(lines: list[dict]) -> dict:
    import soundfile as sf
    sys.path.insert(0, str(HOME))
    os.chdir(HOME)   # its configs name files relative to the repo
    from indextts.infer_v2 import IndexTTS2
    progress(0.02, "Loading IndexTTS-2")
    tts = IndexTTS2(cfg_path=str(HOME / "checkpoints" / "config.yaml"), model_dir=str(HOME / "checkpoints"),
                    use_fp16=True, use_cuda_kernel=False, use_deepspeed=False)
    outs = []
    for i, ln in enumerate(lines):
        progress(0.1 + 0.9 * i / len(lines), f"Line {i + 1} of {len(lines)}")
        delivery = (ln.get("delivery") or "").strip()
        kw = {}
        if delivery:   # the delivery words, read by its emotion model, at the line's strength
            kw = dict(use_emo_text=True, emo_text=delivery, emo_alpha=float(ln.get("intensity") or 0.7))
        tts.infer(spk_audio_prompt=ln["ref"], text=plain(ln["text"]) or ln["text"], output_path=ln["out"], verbose=False, **kw)
        info = sf.info(ln["out"])
        outs.append({"out": ln["out"], "seconds": round(info.frames / info.samplerate, 2)})
    progress(1, "Done")
    return {"lines": outs}


def main():
    job = json.loads(sys.argv[1])
    try:
        print(json.dumps({"ok": True, **speak(job["lines"])}), flush=True)
    except Exception as e:   # reported to the user as the job's error
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
