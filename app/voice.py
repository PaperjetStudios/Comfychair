"""AI voice tools for the Sound tab, run by voice/worker.py in its own venv (see README, Sound tab):

  POST /api/voice/isolate     the speaking voice of a sound or clip alone (music, echo, noise taken out) -> media entry
  POST /api/voice/transcribe  what is said in it (faster-whisper) -> {text, language, segments}
  GET/POST/DELETE /api/voice/voices   saved voices: a short clean cut of someone speaking + what they say in it
  POST /api/voice/speak       new lines in saved voices (Qwen3-TTS cloning) -> one media entry per line

Each is a job (POST returns {job}; GET /api/clip/job/{id} reports progress, as the clip importer's do). The worker
needs the GPU, so ComfyUI is asked to unload its models first, and a run is refused while ComfyUI has work queued."""
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse

from . import audioedit, clipimport, config

router = APIRouter(prefix="/api/voice")
resolve_src = None   # main.py sets it: (src dict, tmp) -> (path, kind), as the Video tab finds clips
media_entry = None   # main.py sets it: (Path) -> the media library's JSON for a file

WORKER = config.BASE_DIR / "voice" / "worker.py"
VOICE_HOME = Path(os.environ.get("DECK_VOICE_HOME", config.BASE_DIR.parent / "comfydeck-voice"))
PY = Path(os.environ.get("DECK_VOICE_PY", VOICE_HOME / ".venv" / "bin" / "python"))
VOICES = config.DATA_DIR / "voices"
# the dialogue's other engines, each in its own install on the SATA drive (README, Sound tab, Voice tools)
ENGINES_HOME = Path(os.environ.get("DECK_VOICE_ENGINES", "/mnt/data/comfydeck-voice-engines"))
INDEX_HOME = Path(os.environ.get("DECK_INDEX_TTS", ENGINES_HOME / "index-tts"))
ENGINES = {   # engine: (its python, its script); qwen is worker.py's own speak
    "index": (INDEX_HOME / ".venv" / "bin" / "python", config.BASE_DIR / "voice" / "engine_index.py"),
    "fish": (Path(sys.executable), config.BASE_DIR / "voice" / "engine_fish.py"),
}
LINE_LUFS = -16   # every spoken line evened out to this loudness (cloned voices come out as quiet as their clip)
ID_RE = re.compile(r"^[a-f0-9]{12}$")
LANGS = ["Auto", "English", "Chinese", "Japanese", "Korean", "German", "French", "Russian", "Portuguese", "Spanish", "Italian"]
_gpu = threading.Lock()   # one worker at a time: they each want most of the card


def installed() -> bool:
    return PY.is_file() and WORKER.is_file()


def engine_ready(engine: str) -> bool:
    if engine == "qwen":
        return installed()
    if engine == "fish":
        return (ENGINES_HOME / "s2.cpp" / "build" / "s2").is_file() and (ENGINES_HOME / "models" / "s2" / "s2-pro-q8_0.gguf").is_file()
    py, script = ENGINES.get(engine, (None, None))
    return bool(py and py.is_file() and script.is_file() and (INDEX_HOME / "checkpoints" / "config.yaml").is_file())


@router.get("/status")
async def status():
    return {"installed": installed(), "languages": LANGS, "home": str(VOICE_HOME),
            "engines": {e: engine_ready(e) for e in ("qwen", "index", "fish")}}


def _need():
    if not installed():
        raise HTTPException(400, f"The voice tools aren't installed yet (no {PY}). See README, Sound tab, Voice tools.")


def _free_gpu():
    """Ask ComfyUI to unload its models so the worker has the card; refuse while ComfyUI is busy."""
    try:
        q = httpx.get(f"{config.COMFY_URL}/queue", timeout=5).json()
        n = len(q.get("queue_running", [])) + len(q.get("queue_pending", []))
        if n:
            raise RuntimeError(f"ComfyUI is busy ({n} queued): try again when the queue is empty")
        httpx.post(f"{config.COMFY_URL}/free", json={"unload_models": True, "free_memory": True}, timeout=10)
        time.sleep(1.5)
    except httpx.HTTPError:
        pass   # ComfyUI is off: the card is free anyway


def _run(job: dict, task: dict, timeout=3600, py: Path = PY, script: Path = WORKER, hf: Path | None = None) -> dict:
    """One worker run: its "@progress p label" lines move the job; the last line is the JSON result. py / script: another
    engine's install and its script (same protocol); hf: where that one keeps its Hugging Face downloads."""
    # the CUDA libraries torch brought into the venv, for faster-whisper's ctranslate2 (it looks them up by name)
    libs = [str(p) for p in sorted((py.parent.parent / "lib").glob("python3*/site-packages/nvidia/*/lib"))]
    env = {**os.environ, "HF_HOME": str(hf or VOICE_HOME / "models" / "hf"), "DECK_VOICE_MODELS": str(VOICE_HOME / "models"),
           "DECK_INDEX_TTS": str(INDEX_HOME), "DECK_FISH_S2": str(ENGINES_HOME),
           "PYTHONUNBUFFERED": "1", "LD_LIBRARY_PATH": os.pathsep.join(libs + [os.environ.get("LD_LIBRARY_PATH", "")]).strip(os.pathsep)}
    with _gpu:
        _free_gpu()
        last, err = None, []
        with subprocess.Popen([str(py), "-I", str(script), json.dumps(task)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              text=True, env=env, cwd=str(VOICE_HOME if script == WORKER else ENGINES_HOME)) as proc:
            job["proc"] = proc
            drain = threading.Thread(target=lambda: err.extend(proc.stderr), daemon=True)
            drain.start()
            t0 = time.time()
            for line in proc.stdout:
                if line.startswith("@progress "):
                    _, p, *label = line.split(" ", 2)
                    try:
                        job["progress"] = min(0.99, float(p))
                    except ValueError:
                        pass
                    if label:
                        job["label"] = label[0].strip()
                elif line.strip().startswith("{"):
                    last = line
                if time.time() - t0 > timeout:
                    proc.kill()
            proc.wait()
            drain.join(5)
    if job["cancel"]:
        raise RuntimeError("Cancelled")
    try:
        res = json.loads(last or "")
    except json.JSONDecodeError:
        tail = "".join(err[-6:]).strip()
        raise RuntimeError(f"The voice worker stopped: {tail[-600:] or f'exit {proc.returncode}'}")
    if not res.get("ok"):
        raise RuntimeError(res.get("error") or "The voice worker failed")
    return res


def even_out(path: Path, lufs: float = LINE_LUFS) -> float:
    """A spoken line brought to the same loudness as the others, in place (two-pass loudnorm: it is measured first, so
    the gain is even over the line instead of riding it). Returns its length in seconds."""
    probe = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af",
                            f"loudnorm=I={lufs}:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"],
                           capture_output=True, text=True, timeout=300)
    m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", probe.stderr)
    tmp = path.with_suffix(".even.wav")
    af = f"loudnorm=I={lufs}:TP=-1.5:LRA=11"
    if m:
        st = json.loads(m.group(0))
        if st["input_i"] not in ("-inf", "inf"):
            af += (f":measured_I={st['input_i']}:measured_TP={st['input_tp']}:measured_LRA={st['input_lra']}"
                   f":measured_thresh={st['input_thresh']}:offset={st['target_offset']}:linear=true")
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path), "-af", af, "-ar", "48000", str(tmp)],
                       capture_output=True, timeout=300)
    if r.returncode == 0 and tmp.is_file():
        tmp.replace(path)
    tmp.unlink(missing_ok=True)
    return _seconds(path)


def _seconds(path: Path) -> float:
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True, timeout=30)
    try:
        return round(float(r.stdout.strip()), 2)
    except ValueError:
        return 0.0


def _media_path(name: str, ext: str) -> Path:
    safe = re.sub(r"[^\w.-]+", "_", Path(name or "voice").stem)[:60] or "voice"
    return config.MEDIA_DIR / f"{uuid.uuid4().hex[:8]}_{safe}{ext}"


async def _wav_of(body: dict, td: Path) -> Path:
    """The picked sound (source + trim) as a 48 kHz WAV for the worker."""
    path, kind = await resolve_src(body.get("source") or {}, td)
    if kind not in ("audio", "video"):
        raise HTTPException(400, "That has no sound")
    return path


@router.post("/isolate")
async def isolate(body: dict = Body(...)):
    """{source, trim?, steps: [vocals, dereverb, denoise], name?}: job -> media entry (FLAC) of the voice alone."""
    _need()
    path = await _wav_of(body, None)
    trim = body.get("trim") if isinstance(body.get("trim"), dict) else None
    steps = [s for s in (body.get("steps") or ["vocals", "dereverb", "denoise"]) if s in ("vocals", "dereverb", "denoise")]
    out = _media_path(body.get("name") or f"{path.stem}-voice", ".flac")

    def work(job):
        with tempfile.TemporaryDirectory() as td:
            src, raw = Path(td) / "in.wav", Path(td) / "voice.wav"
            job["label"] = "Reading the sound"
            audioedit.extract(path, src, trim)
            _run(job, {"op": "isolate", "src": str(src), "out": str(raw), "steps": steps})
            audioedit.extract(raw, out)
        return media_entry(out)

    return clipimport._start(work, "Taking the voice out")


@router.post("/transcribe")
async def transcribe(body: dict = Body(...)):
    """{source, trim?, language?}: job -> {text, language, segments}."""
    _need()
    path = await _wav_of(body, None)
    trim = body.get("trim") if isinstance(body.get("trim"), dict) else None

    def work(job):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "in.wav"
            audioedit.extract(path, src, trim)
            res = _run(job, {"op": "transcribe", "src": str(src), "language": body.get("language") or None})
        return {k: res[k] for k in ("text", "language", "segments")}

    return clipimport._start(work, "Listening")


# ---- saved voices: data/voices/<id>.json + <id>.wav ----
def _voice(vid: str) -> dict:
    if not ID_RE.match(vid or "") or not (VOICES / f"{vid}.json").is_file():
        raise HTTPException(404, "That voice is gone")
    return json.loads((VOICES / f"{vid}.json").read_text())


def _public(v: dict) -> dict:
    return {**v, "url": f"/api/voice/voices/{v['id']}/audio"}


@router.get("/voices")
async def voices():
    VOICES.mkdir(parents=True, exist_ok=True)
    rows = [json.loads(p.read_text()) for p in VOICES.glob("*.json")]
    return [_public(v) for v in sorted(rows, key=lambda v: v.get("created", 0), reverse=True)]


@router.post("/voices")
async def voice_save(body: dict = Body(...)):
    """{name, source, trim, ref_text, language, consent: true}: a voice to speak with (2-30 s of one person speaking, 5-15 is best)."""
    if not body.get("consent"):
        raise HTTPException(400, "Confirm that you may use this voice (yours, or the speaker said yes)")
    name = str(body.get("name") or "").strip()[:60]
    if not name:
        raise HTTPException(400, "Give the voice a name")
    path = await _wav_of(body, None)
    VOICES.mkdir(parents=True, exist_ok=True)
    vid = uuid.uuid4().hex[:12]
    wav = VOICES / f"{vid}.wav"
    try:
        info = audioedit.extract(path, wav, body.get("trim") if isinstance(body.get("trim"), dict) else None)
    except (ValueError, RuntimeError, subprocess.SubprocessError) as e:
        raise HTTPException(400, f"Couldn't cut that sound: {e}")
    if not 2 <= info["duration"] <= 30:
        wav.unlink(missing_ok=True)
        raise HTTPException(400, f"Use 2 to 30 seconds of speech, 5 to 15 is best (that is {info['duration']:.1f} s): set Start and Length")
    v = {"id": vid, "name": name, "ref_text": str(body.get("ref_text") or "").strip()[:2000],
         "language": body.get("language") or "Auto", "seconds": round(info["duration"], 2), "created": time.time(),
         "source": body.get("source")}
    (VOICES / f"{vid}.json").write_text(json.dumps(v, indent=1))
    return _public(v)


@router.patch("/voices/{vid}")
async def voice_edit(vid: str, body: dict = Body(...)):
    v = _voice(vid)
    for k in ("name", "ref_text", "language"):
        if isinstance(body.get(k), str):
            v[k] = body[k].strip()[:2000 if k == "ref_text" else 60]
    (VOICES / f"{vid}.json").write_text(json.dumps(v, indent=1))
    return _public(v)


@router.delete("/voices/{vid}")
async def voice_delete(vid: str):
    _voice(vid)
    (VOICES / f"{vid}.json").unlink(missing_ok=True)
    (VOICES / f"{vid}.wav").unlink(missing_ok=True)
    return {"ok": True}


@router.get("/voices/{vid}/audio")
async def voice_audio(vid: str):
    _voice(vid)
    return FileResponse(VOICES / f"{vid}.wav", media_type="audio/wav")


@router.post("/speak")
async def speak(body: dict = Body(...)):
    """{lines: [{voice (id), text, language?, delivery?, intensity?}], engine?, name?}: job -> {lines: [media entry + seconds]} in order."""
    _need()
    lines = [ln for ln in body.get("lines") or [] if str(ln.get("text") or "").strip()]
    if not lines:
        raise HTTPException(400, "Write a line first")
    if len(lines) > 60:
        raise HTTPException(400, "Up to 60 lines at a time")
    task, outs = [], []
    stem = body.get("name") or "line"
    for i, ln in enumerate(lines):
        v = _voice(str(ln.get("voice") or ""))
        out = _media_path(f"{stem}-{i + 1:02d}-{v['name']}", ".wav")
        outs.append(out)
        task.append({"text": str(ln["text"]).strip()[:1500], "ref": str(VOICES / f"{v['id']}.wav"), "ref_text": v.get("ref_text") or "",
                     "language": ln.get("language") or v.get("language") or "Auto", "out": str(out),
                     "delivery": ln.get("delivery"), "intensity": ln.get("intensity")})
    engine = str(body.get("engine") or "qwen")
    if engine not in ("qwen", *ENGINES):
        raise HTTPException(400, f"Unknown voice engine {engine}")
    if not engine_ready(engine):
        raise HTTPException(400, {"index": "IndexTTS-2", "fish": "Fish S2"}.get(engine, engine) + " isn't installed yet "
                                 "(README, Sound tab, Voice tools)")

    def work(job):
        try:
            if engine == "qwen":
                res = _run(job, {"op": "speak", "lines": task})
            else:
                py, script = ENGINES[engine]
                res = _run(job, {"lines": task}, py=py, script=script, hf=ENGINES_HOME / ".hf")
            for r in res["lines"]:
                job["label"] = "Evening out the loudness"
                r["seconds"] = even_out(Path(r["out"]))
        except Exception:
            for o in outs:
                o.unlink(missing_ok=True)
            raise
        return {"lines": [{**media_entry(Path(r["out"])), "seconds": r["seconds"]} for r in res["lines"]]}

    return clipimport._start(work, "Speaking")
