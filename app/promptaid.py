"""Prompt helper: a small local language model that rewrites a rough prompt for the open template's model family
(Improve, Expand idea) and writes a prompt from a picture (Describe, Describe only the style).

It runs through Ollama (https://ollama.com) with a vision model (default qwen3.5:4b). When Ollama isn't running but
its program is installed, ComfyChair starts `ollama serve` itself, as a background process of its own.

The GPU is shared with ComfyUI: a run on the graphics card takes the voice tools' lock (voice._gpu), refuses while
ComfyUI has work queued, asks ComfyUI to unload its models only when the card hasn't room, and tells Ollama to unload
the model as soon as it has answered (keep_alive 0), so ComfyUI gets the card back. "auto" uses the processor instead
when ComfyUI is busy or a voice job holds the card (slower: about 45 s for three variants instead of about 6 s)."""
import base64
import io
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, Body, HTTPException
from fastapi.concurrency import run_in_threadpool

from . import config, voice

log = logging.getLogger("comfydeck.promptaid")
router = APIRouter(prefix="/api/prompt")
read_input = None   # main.py sets it: async (input name) -> the image's bytes (input_bytes)

OLLAMA_URL = os.environ.get("DECK_OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL = os.environ.get("DECK_PROMPT_MODEL", "qwen3.5:4b")
NEED_MB = int(os.environ.get("DECK_PROMPT_VRAM_MB", "5500"))   # what the model needs on the card (weights + context)
GPU_TIMEOUT, CPU_TIMEOUT = 120, 420
_start_lock = threading.Lock()
_started: subprocess.Popen | None = None


def ollama_bin() -> str | None:
    b = os.environ.get("DECK_OLLAMA_BIN") or shutil.which("ollama")
    if not b and (Path.home() / ".local" / "bin" / "ollama").exists():
        b = str(Path.home() / ".local" / "bin" / "ollama")
    return b


def _up() -> bool:
    try:
        return httpx.get(f"{OLLAMA_URL}/api/tags", timeout=2).status_code == 200
    except httpx.HTTPError:
        return False


def ensure_server():
    """Ollama answering, or a clear error. Starts `ollama serve` when it's installed but not running (local URL only)."""
    global _started
    if _up():
        return
    with _start_lock:
        if _up():
            return
        b = ollama_bin()
        local = re.match(r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$", OLLAMA_URL)
        if not b or not local:
            raise HTTPException(503, f"The prompt helper needs Ollama: it isn't running at {OLLAMA_URL}"
                                     + ("" if b else " and isn't installed (see README, Prompt helper)"))
        logf = config.DATA_DIR / "tmp" / "ollama.log"
        logf.parent.mkdir(parents=True, exist_ok=True)
        host = OLLAMA_URL.split("://", 1)[1]
        env = {**os.environ, "OLLAMA_HOST": host, "OLLAMA_NO_CLOUD": "true"}
        with open(logf, "ab") as out:
            _started = subprocess.Popen([b, "serve"], stdout=out, stderr=out, stdin=subprocess.DEVNULL, env=env,
                                        start_new_session=True)   # (outlives a restart of ComfyChair; that's fine)
        for _ in range(40):
            time.sleep(0.5)
            if _up():
                return
            if _started.poll() is not None:
                break
        raise HTTPException(503, f"Ollama didn't start (see {logf})")


def models() -> list[dict]:
    r = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=5)
    r.raise_for_status()
    return r.json().get("models", [])


@router.get("/status")
def status():
    """{ready, installed, running, model, has_model, vision, error}: what the buttons need to know."""
    out = {"installed": bool(ollama_bin()) or _up(), "running": _up(), "model": MODEL, "has_model": False,
           "vision": False, "ready": False, "error": None}
    if not out["running"]:
        out["ready"] = out["installed"]   # (it starts on first use)
        out["has_model"] = out["installed"] and (Path.home() / ".ollama" / "models" / "manifests" / "registry.ollama.ai"
                                                 / "library" / MODEL.split(":")[0] / (MODEL.split(":") + ["latest"])[1]).is_file()
        out["vision"] = out["has_model"]
        if not out["installed"]:
            out["error"] = "Ollama isn't installed"
        return out
    try:
        names = {m.get("name") for m in models()}
        out["has_model"] = MODEL in names or f"{MODEL}:latest" in names
        if out["has_model"]:
            caps = httpx.post(f"{OLLAMA_URL}/api/show", json={"model": MODEL}, timeout=5).json().get("capabilities") or []
            out["vision"] = "vision" in caps
        out["ready"] = out["has_model"]
        if not out["has_model"]:
            out["error"] = f"Ollama has no {MODEL} (ollama pull {MODEL})"
    except httpx.HTTPError as e:
        out["error"] = f"Ollama: {e}"
    return out


# ---------------------------------------------------------------------------
# what each model family wants
# ---------------------------------------------------------------------------
FAMILY_KEYS = {"krea": "krea", "flux klein": "klein", "klein": "klein", "qwen image": "qwen", "qwen": "qwen", "moss": "moss",
               "ltx-2.5": "ltx", "ltx": "ltx", "minimax h3": "h3", "h3": "h3", "image": "image", "video": "video"}

STYLE = ("Write natural, concrete English in a few clear sentences, as one paragraph; no lists, no headings, no "
         "quality tags (masterpiece, 8k, best quality), no negative prompt, no commentary.")
GUIDE = {
    "krea": ("Krea 2, a photographic image model that reads full sentences well. Lead with the subject and what they do, "
             "then the setting, the composition and camera (shot size, angle, lens), the light (source, direction, time of "
             "day), colour palette and mood. Reference pictures are called \"the first image\" and \"the second image\"."),
    "klein": ("FLUX.2 Klein, an image model that follows long natural-language prompts. Put the main subject first, then "
              "its look and action, the setting, the composition, the lighting and the style or medium. Reference pictures "
              "are <ref_image_0>, <ref_image_1>…; layout boxes are <obj_1>, <obj_2>…"),
    "qwen": ("Qwen Image, an image model that is very literal and renders text well: put any words that must appear in the "
             "picture in double quotes and say where they go. Describe the subject, setting, composition, lighting and "
             "style plainly. Reference pictures are called Picture 1, Picture 2…"),
    "moss": ("MOSS Image, an image model. Describe the subject, setting, composition, lighting and style. Reference "
             "pictures are called image 1, image 2…"),
    "image": "a text-to-image model. Describe the subject, setting, composition, lens, lighting, colour and mood.",
    "ltx": ("LTX-2.5, a video model that also makes the sound. Write one paragraph of 4 to 8 sentences in the present "
            "tense that tells what happens in order, like a shot description: the subject and their exact movements and "
            "gestures, the camera's movement (static, slow push-in, pan, handheld…), the setting, the light and the mood, "
            "then the sound (ambience, effects, any spoken words in double quotes and who says them). One continuous shot "
            "unless the prompt asks for cuts."),
    "h3": ("MiniMax H3, a video model with a fixed prompt structure. Keep it: first, optional lines that define each "
           "subject (\"<Subject 1> is a young woman in a red coat, as shown in <Picture 1>.\"); then one line per shot, "
           "starting \"[Shot 1] \" and, for later shots, \"[Shot 2] At 00:03.000, the camera cuts to …\" with the same "
           "timestamps as the original; spoken words go inside <d></d> after who says them (\"<Subject 1> says: "
           "<d>words</d>\"); last come two lines, \"overall_soundscape: …\" (ambience and sound effects, or N/A) and "
           "\"non_diegetic_music: …\" (the score, or N/A). Keep who each subject is as the user wrote it. Each shot "
           "describes the framing, the action in order, the camera movement and the light."),
    "video": ("a video model. Describe in the present tense what happens in order, the camera movement, the setting, the "
              "light and the mood, in one paragraph."),
}
EDIT = ("This template edits the reference picture(s), so write an edit instruction, not a description of a new "
        "picture. Start with the change as a command (\"Change her coat to…\", \"Put her on…\", \"Make it night…\"), with "
        "concrete detail, then say what must stay the same (the person's face and identity, pose, framing) unless the "
        "change is about that. Don't describe parts of the picture that aren't changing.")
I2V = ("The video starts from the reference picture, so don't re-describe how it looks: describe the motion, the "
       "camera and the sound.")


def family_key(family: str = "", tag_style: str = "", media: str = "") -> str:
    if tag_style == "h3":
        return "h3"
    k = FAMILY_KEYS.get((family or "").strip().lower())
    if k:
        return k
    if tag_style in GUIDE:
        return tag_style
    return "video" if media == "video" else "image"


# Words a rewrite must keep exactly: reference tags, @Name mentions, wildcard groups, H3's shots, speech and fields
PROTECT = re.compile(
    r"<(?:Picture|Video|Audio|Subject) \d+>|<ref_image_\d+>|<obj_\d+>"
    r"|\b(?:Picture|image|Subject) \d+\b"
    r"|\bthe right half of the second image\b|\bthe (?:first|second) image\b"
    r"|@[A-Za-z][\w'-]*"
    r"|\{[^{}\n]*\|[^{}\n]*\}"
    r"|<d>.*?</d>"
    r"|\[Shot \d+\](?: At \d+:\d+(?:\.\d+)?)?"
    r"|\b(?:overall_soundscape|non_diegetic_music):", re.S)


def protected(text: str) -> list[str]:
    seen = []
    for m in PROTECT.finditer(text or ""):
        t = m.group(0)
        if t not in seen:
            seen.append(t)
    return seen


def missing(text: str, keep: list[str]) -> list[str]:
    return [k for k in keep if k not in text]


def clean(v) -> str:
    s = str(v or "").strip()
    s = re.sub(r"^(?:prompt|variant \d+|rewrite)\s*:\s*", "", s, flags=re.I)
    if len(s) > 1 and s[0] == s[-1] and s[0] in "\"'":
        s = s[1:-1].strip()
    return s.replace("\r\n", "\n")


def _system(fam: str, mode: str, edit: bool, i2v: bool, keep: list[str], n: int) -> str:
    task = {
        "improve": ("Rewrite the user's rough prompt into a strong prompt. Keep the user's intent and every subject, "
                    "object and action they asked for; don't change what happens. Add concrete visual detail where "
                    "the prompt is vague."),
        "expand": ("The user gives a short idea. Turn it into a full scene prompt: who or what, doing what, where, "
                   "the framing and camera, the light, the colours and the mood. Keep everything the idea names."),
    }[mode]
    parts = [f"You write prompts for {GUIDE[fam]}", task]
    if edit and fam not in ("ltx", "h3", "video"):
        parts.append(EDIT)
    if i2v and fam in ("ltx", "video"):
        parts.append(I2V)
    if fam != "h3":
        parts.append(STYLE)
    if keep:
        parts.append("Copy these exactly as written, each at least once, where they belong: "
                     + ", ".join(json.dumps(k, ensure_ascii=False) for k in keep) + ".")
    shape = '[["line 1", "line 2", "…"]], each version a list of its lines' if fam == "h3" else '["…"]'
    parts.append(f"Give {n} different versions (they may differ in detail, framing or mood, never in what is asked for). "
                 f"Reply with JSON only: {{\"variants\": {shape}}}.")
    return "\n\n".join(parts)


DESCRIBE = {
    "full": ("Describe this picture as a prompt that would recreate it with {who}: the subject (who or what, their look, "
             "clothes, pose, expression), the setting, the composition and camera (shot size, angle, lens and depth of "
             "field), the light (source, direction, quality, time of day), the colour palette, the medium or style, and "
             "the mood."),
    "style": ("Describe only the look of this picture, so it can be reused on a different subject with {who}: the "
              "medium or style, the light, the colour palette and grade, the lens and depth of field, the texture and "
              "grain, and the mood. Don't mention the subject, the people, the objects or the place."),
}


def _schema(lines: bool = False):
    item = {"type": "array", "items": {"type": "string"}} if lines else {"type": "string"}
    return {"type": "object", "properties": {"variants": {"type": "array", "items": item}}, "required": ["variants"]}


def _vram_free_mb() -> int | None:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout
        return int(out.split()[0])
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


def _comfy_busy() -> bool:
    try:
        q = httpx.get(f"{config.COMFY_URL}/queue", timeout=5).json()
        return bool(len(q.get("queue_running", [])) + len(q.get("queue_pending", [])))
    except (httpx.HTTPError, ValueError):
        return False


def _room_on_card():
    """ComfyUI's models off the card when the prompt model wouldn't fit beside them (refused while ComfyUI is busy)."""
    free = _vram_free_mb()
    if free is not None and free >= NEED_MB:
        return
    voice._free_gpu()


def _post(payload: dict, timeout: float) -> dict:
    try:
        r = httpx.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=timeout)
    except httpx.TimeoutException:
        raise HTTPException(504, f"The prompt model took longer than {int(timeout)} s")
    except httpx.HTTPError as e:
        raise HTTPException(503, f"Can't reach Ollama: {e}")
    if r.status_code == 404:
        raise HTTPException(503, f"Ollama has no {payload['model']}: run `ollama pull {payload['model']}`")
    if r.status_code != 200:
        try:
            msg = r.json().get("error") or r.text
        except ValueError:
            msg = r.text
        raise HTTPException(502, f"Ollama: {msg[:300]}")
    return r.json()


def chat(messages: list[dict], device: str = "auto", temperature: float = 0.8, lines: bool = False) -> tuple[dict, str]:
    """One JSON answer from the prompt model -> (parsed, the device it ran on). device: auto | gpu | cpu.
    lines: each variant comes as a list of its lines (H3's structure), which the model gets right more often."""
    ensure_server()
    payload = {"model": MODEL, "stream": False, "think": False, "keep_alive": 0, "format": _schema(lines),
               "options": {"temperature": temperature, "num_ctx": 4096, "num_predict": 1600}, "messages": messages}
    auto = device not in ("gpu", "cpu")
    if auto:
        device = "cpu" if _comfy_busy() else "gpu"
    d = None
    if device == "gpu":
        if voice._gpu.acquire(timeout=0.5 if auto else 60):
            try:
                try:
                    _room_on_card()
                    d = _post(payload, GPU_TIMEOUT)
                except RuntimeError as e:   # ComfyUI got a job in the meantime
                    if not auto:
                        raise HTTPException(409, str(e))
            finally:
                voice._gpu.release()
        elif not auto:
            raise HTTPException(409, "The graphics card is busy with a voice or 3D job: try again, or run on the processor")
        if d is None:
            device = "cpu"
    if d is None:
        payload["options"]["num_gpu"] = 0
        d = _post(payload, CPU_TIMEOUT)
    text = (d.get("message") or {}).get("content") or ""
    try:
        return json.loads(text), device
    except ValueError:
        m = re.search(r"\{.*\}", text, re.S)
        try:
            return json.loads(m.group(0)) if m else {"variants": [text]}, device
        except ValueError:
            return {"variants": [text]}, device


def _variants(data, n: int) -> list[str]:
    vs = data.get("variants") if isinstance(data, dict) else data
    if isinstance(vs, str):
        vs = [vs]
    out = []
    for v in vs or []:
        if isinstance(v, dict):
            v = v.get("prompt") or v.get("text") or v.get("lines")
        if isinstance(v, str) and re.match(r"^\s*[\[{]\s*\"", v):   # its lines written as a JSON list inside the string
            try:
                v = json.loads("[" + v.strip()[1:-1] + "]")
            except ValueError:
                pass
        if isinstance(v, list):
            v = "\n".join(clean(x) for x in v if str(x or "").strip())
        c = clean(v)
        if c and c not in out:
            out.append(c)
    return out[:n]


def improve(text: str, family: str = "", tag_style: str = "", media: str = "", mode: str = "improve",
            edit: bool = False, i2v: bool = False, n: int = 3, device: str = "auto") -> dict:
    text = (text or "").strip()
    if not text:
        raise HTTPException(400, "Write something first: a few words are enough")
    if mode not in ("improve", "expand"):
        raise HTTPException(400, f"Unknown mode {mode}")
    n = max(1, min(4, int(n or 3)))
    fam = family_key(family, tag_style, media)
    keep = protected(text)
    t0 = time.time()
    msgs = [{"role": "system", "content": _system(fam, mode, edit, i2v, keep, n)}, {"role": "user", "content": text}]
    data, used = chat(msgs, device, lines=fam == "h3")
    vs = _variants(data, n)
    lost = [missing(v, keep) for v in vs]
    if keep and (not vs or all(lost)):   # every one dropped a tag: ask once more, naming them
        msgs.append({"role": "assistant", "content": json.dumps({"variants": vs}, ensure_ascii=False)})
        msgs.append({"role": "user", "content": "Each version must contain these exactly: "
                     + ", ".join(json.dumps(k, ensure_ascii=False) for k in keep) + ". Write them again."})
        data, used = chat(msgs, used, lines=fam == "h3")
        vs = _variants(data, n) or vs
        lost = [missing(v, keep) for v in vs]
    if not vs:
        raise HTTPException(502, "The prompt model gave nothing back: try again")
    order = sorted(range(len(vs)), key=lambda i: len(lost[i]))   # the ones that kept every tag first
    return {"family": fam, "keep": keep, "device": used, "seconds": round(time.time() - t0, 1),
            "variants": [{"text": vs[i], "missing": lost[i]} for i in order]}


def _image_b64(data: bytes, side: int = 1024) -> str:
    from PIL import Image, ImageOps
    try:
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
    except Exception:
        raise HTTPException(400, "That file isn't a picture")
    im = im.convert("RGB")
    im.thumbnail((side, side))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode()


def describe(image: bytes, what: str = "full", family: str = "", tag_style: str = "", media: str = "",
             device: str = "auto") -> dict:
    if what not in DESCRIBE:
        raise HTTPException(400, f"Unknown description {what}")
    fam = family_key(family, tag_style, media)
    who = GUIDE[fam].split(",")[0]
    sys_p = "\n\n".join([
        DESCRIBE[what].format(who=who),
        "Write what you see; don't guess names, brands or places you can't read in the picture. " + STYLE,
        "Give 2 versions: a detailed one (4 to 7 sentences) and a short one (1 or 2 sentences). "
        "Reply with JSON only: {\"variants\": [\"…\", \"…\"]}."])
    t0 = time.time()
    data, used = chat([{"role": "system", "content": sys_p},
                       {"role": "user", "content": "Describe this picture.", "images": [_image_b64(image)]}],
                      device, temperature=0.4)
    vs = _variants(data, 2)
    if not vs:
        raise HTTPException(502, "The prompt model gave nothing back: try again")
    return {"family": fam, "device": used, "seconds": round(time.time() - t0, 1),
            "variants": [{"text": v, "missing": []} for v in vs]}


# ---------------------------------------------------------------------------
# routes
# ---------------------------------------------------------------------------
def _opts(b: dict) -> dict:
    return {"family": str(b.get("family") or ""), "tag_style": str(b.get("tag_style") or ""),
            "media": str(b.get("media") or ""), "device": str(b.get("device") or "auto")}


@router.post("/improve")
async def improve_route(body: dict = Body(...)):
    """{text, family, tag_style, media, mode: improve | expand, edit, i2v, n, device: auto | gpu | cpu} ->
    {variants: [{text, missing}], keep, family, device, seconds}. missing: tags a variant lost (shown as a warning)."""
    b = body or {}
    return await run_in_threadpool(improve, str(b.get("text") or ""), mode=str(b.get("mode") or "improve"),
                                   edit=bool(b.get("edit")), i2v=bool(b.get("i2v")), n=b.get("n") or 3, **_opts(b))


@router.post("/describe")
async def describe_route(body: dict = Body(...)):
    """{image (an input name), what: full | style, family, tag_style, media, device} -> {variants: [{text}], …}"""
    b = body or {}
    name = str(b.get("image") or "")
    if not name:
        raise HTTPException(400, "Pick a picture")
    if read_input is None:
        raise HTTPException(500, "Pictures can't be read here")
    try:
        data = await read_input(name)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(404, f"Can't open {name}: {e}")
    return await run_in_threadpool(describe, data, str(b.get("what") or "full"), **_opts(b))
