"""Fish Audio S2 Pro for the Sound tab's dialogue, through s2.cpp (a native ggml build of it; the q8_0 GGUF is near
lossless and fits a 12 GB card). The model understands [tags] anywhere in a line ([whisper], [laugh], [sigh]…);
a line's delivery words go in front as one more tag. A saved voice is cloned from its clip and its transcript, so
voices without a transcript can't be used here (Listen fills it in).

    python engine_fish.py '<json>'   {"lines": [{"text", "ref": wav, "ref_text", "out": wav, "delivery"}]}

Same protocol as worker.py: "@progress p label" lines, then one JSON line {"ok": true, "lines": [{"out", "seconds"}]}.
Runs with ComfyDeck's own Python (it only needs httpx); s2.cpp runs as a local server for the whole dialogue, so the
model loads once. DECK_FISH_S2: the folder with s2.cpp/build/s2 and models/s2/ (s2-pro-q8_0.gguf, tokenizer.json).
"""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import httpx

HOME = Path(os.environ.get("DECK_FISH_S2", "/mnt/data/comfydeck-voice-engines"))
BIN = HOME / "s2.cpp" / "build" / "s2"
MODEL = HOME / "models" / "s2" / os.environ.get("DECK_FISH_MODEL", "s2-pro-q8_0.gguf")
PORT = int(os.environ.get("DECK_FISH_PORT", "3031"))


def progress(p: float, label: str):
    print(f"@progress {p:.3f} {label}", flush=True)


def text_for(ln: dict) -> str:
    delivery = (ln.get("delivery") or "").strip()
    return (f"[{delivery}] " if delivery else "") + ln["text"].strip()


def seconds(path: str) -> float:
    """A wav's length (s2.cpp writes 32-bit float wavs, which the wave module can't read)."""
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                       capture_output=True, text=True, timeout=30)
    try:
        return round(float(r.stdout.strip()), 2)
    except ValueError:
        return 0.0


def _up(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def speak(lines: list[dict]) -> dict:
    missing = [ln for ln in lines if not (ln.get("ref_text") or "").strip()]
    if missing:
        raise ValueError("Fish S2 needs what is said in each voice's clip: open the voice, tap Listen, and save it again")
    if not BIN.is_file() or not MODEL.is_file():
        raise FileNotFoundError(f"Fish S2 isn't installed ({BIN if not BIN.is_file() else MODEL} is missing)")
    progress(0.02, "Loading Fish S2")
    server = subprocess.Popen([str(BIN), "--model", str(MODEL), "--tokenizer", str(MODEL.parent / "tokenizer.json"),
                               "--cuda", "0", "--server", "-H", "127.0.0.1", "-P", str(PORT)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    try:
        t0 = time.time()
        while not _up(PORT):
            if server.poll() is not None:
                raise RuntimeError("s2.cpp stopped: " + (server.stderr.read() or "")[-400:])
            if time.time() - t0 > 180:
                raise TimeoutError("s2.cpp didn't start in 3 minutes")
            time.sleep(0.5)
        outs = []
        with httpx.Client(timeout=600) as http:
            for i, ln in enumerate(lines):
                progress(0.1 + 0.9 * i / len(lines), f"Line {i + 1} of {len(lines)}")
                with open(ln["ref"], "rb") as ref:
                    r = http.post(f"http://127.0.0.1:{PORT}/generate",
                                  data={"text": text_for(ln), "reference_text": ln["ref_text"]},
                                  files={"reference": (Path(ln["ref"]).name, ref, "audio/wav")})
                if r.status_code != 200:
                    raise RuntimeError(f"s2.cpp: {r.status_code} {r.text[:300]}")
                Path(ln["out"]).write_bytes(r.content)
                outs.append({"out": ln["out"], "seconds": seconds(ln["out"])})
    finally:
        server.terminate()
        try:
            server.wait(10)
        except subprocess.TimeoutExpired:
            server.kill()
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
