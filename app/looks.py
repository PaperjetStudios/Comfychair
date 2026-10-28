"""Characters' look packs: a sheet made from their views, and a look check that says when a picture has drifted
from how a character looks.

  POST /api/looks/sheet    {pictures: [input names], project_id}: the views side by side on light grey, as one
                           input picture -> {name, width, height}
  GET  /api/looks/status   which scorer checks looks, and whether it can run -> {scorer, ready, why}
  POST /api/looks/check    {image: {input} | {generation, index}, characters: [{id, pictures: [input names]}]}
                           -> {scorer, results: {id: {score, look, colour, drift, box}}}

The scorer is pluggable (SCORERS, DECK_LOOK_SCORER): "clip" runs look/clip_worker.py in ComfyUI's venv on the CPU
with the DFN5B CLIP ViT-H-14 that ComfyUI-MMAudio keeps (no download), and finds the people in a picture with DWPose's
YOLOX person detector, so a character in a scene is compared on their own. A result's look is the best CLIP cosine
similarity of any of its crops (the whole picture, each person) to any of the character's pictures; its colour is
how much the hues of that crop's middle match the closest pack picture's (a jacket that changed colour). Measured on
the robot test character (2026-10-28): the same character in a scene 0.81 look, another person 0.54-0.69; a recoloured
jacket kept 0.87 look but fell to 0.36 colour (the same outfit 0.83-0.95). A changed head of similar colours isn't
caught. "none" turns the check off.
"""
import asyncio
import hashlib
import io
import json
import os
import subprocess
import threading
import time
from collections import OrderedDict
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Body, HTTPException
from PIL import Image

from . import config, db

router = APIRouter(prefix="/api/looks")

# main.py sets these: an input's bytes, a generation output's path, and saving a picture as an input
input_bytes = None   # async (name) -> bytes
local_input = None   # (name) -> Path | None
output_path = None   # (generation dict, output dict) -> Path
save_input = None    # async (png bytes, project_id, source) -> name

CACHE_DIR = config.DATA_DIR / "tmp" / "looks"
LOOK_MIN = float(os.environ.get("DECK_LOOK_MIN", "0.75"))      # below: another person, or a different look
COLOUR_MIN = float(os.environ.get("DECK_COLOUR_MIN", "0.6"))   # below: the outfit's colours changed


# ---- the sheet ----------------------------------------------------------------
SHEET_H = 1024   # each view's height on the sheet
SHEET_BG = (214, 214, 214)


def compose_sheet(images: list[Image.Image], height: int = SHEET_H, gap: int = 24, max_w: int = 4096) -> Image.Image:
    """The pictures side by side at one height on light grey, scaled down to fit max_w."""
    ims = [im.convert("RGB") for im in images]
    if not ims:
        raise ValueError("No pictures")
    scaled = [im.resize((max(1, round(im.width * height / im.height)), height), Image.LANCZOS) for im in ims]
    w = sum(i.width for i in scaled) + gap * (len(scaled) + 1)
    sheet = Image.new("RGB", (w, height + 2 * gap), SHEET_BG)
    x = gap
    for im in scaled:
        sheet.paste(im, (x, gap))
        x += im.width + gap
    if sheet.width > max_w:
        sheet = sheet.resize((max_w, max(1, round(sheet.height * max_w / sheet.width))), Image.LANCZOS)
    # on 16s, which every model takes
    return sheet.crop((0, 0, sheet.width // 16 * 16, sheet.height // 16 * 16))


@router.post("/sheet")
async def sheet(body: dict = Body(...)):
    names = [str(n) for n in (body.get("pictures") or []) if n][:8]
    if not names:
        raise HTTPException(400, "No pictures for the sheet")
    try:
        ims = [Image.open(io.BytesIO(await input_bytes(n))) for n in names]
    except Exception as e:
        raise HTTPException(404, f"A picture is missing: {e}")
    im = await asyncio.to_thread(compose_sheet, ims)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    pid = body.get("project_id")
    name = await save_input(buf.getvalue(), int(pid) if pid not in (None, "", "null") else None, "sheet")
    return {"name": name, "width": im.width, "height": im.height}


# ---- scorers ------------------------------------------------------------------
def _first(*paths) -> Path | None:
    return next((Path(p) for p in paths if p and Path(p).is_file()), None)


class ClipScorer:
    """look/clip_worker.py in ComfyUI's venv, kept running while it's used (it exits after IDLE seconds)."""
    name = "clip"
    IDLE = 300
    MODEL = "apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors"

    def __init__(self):
        comfy = config.COMFY_DIR
        self.py = _first(os.environ.get("DECK_LOOK_PY"), comfy and comfy / ".venv" / "bin" / "python")
        self.model = _first(os.environ.get("DECK_LOOK_MODEL"), comfy and comfy / "models" / "mmaudio" / self.MODEL,
                            *[Path(b) / "mmaudio" / self.MODEL for b in _model_bases()])
        self.det = _first(os.environ.get("DECK_LOOK_DET"),
                          comfy and comfy / "custom_nodes/comfyui_controlnet_aux/ckpts/yzd-v/DWPose/yolox_l.onnx")
        self.script = config.BASE_DIR / "look" / "clip_worker.py"
        self.proc = None
        self.lock = threading.Lock()
        self.used = 0.0
        self.cache = OrderedDict()   # (path, mtime, people) -> crops

    def why(self) -> str:
        if not self.py:
            return "ComfyUI's venv wasn't found (DECK_COMFY_DIR, or DECK_LOOK_PY)"
        if not self.model:
            return f"{self.MODEL} (ComfyUI-MMAudio's CLIP) wasn't found in models/mmaudio (or DECK_LOOK_MODEL)"
        return ""

    def _start(self):
        args = [str(self.py), "-I", str(self.script), str(self.model), "--threads", str(max(1, (os.cpu_count() or 4) // 2))]
        if self.det:
            args += ["--det", str(self.det)]
        self.proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     text=True, env={**os.environ, "CUDA_VISIBLE_DEVICES": ""})
        hello = self.proc.stdout.readline()
        if not hello or not json.loads(hello).get("ready"):
            self.proc.kill()
            self.proc = None
            raise RuntimeError("The look checker didn't start")
        threading.Thread(target=self._reaper, daemon=True).start()

    def _reaper(self):
        while self.proc:
            time.sleep(15)
            with self.lock:
                if self.proc and time.time() - self.used > self.IDLE:
                    self.proc.stdin.close()
                    self.proc.wait(10)
                    self.proc = None

    def embed(self, items: list[tuple[Path, bool]]) -> list[list[dict]]:
        """Each (path, people): its crops [{box, vec, hist}] (the whole picture first). Cached by file and time."""
        keys = [(str(p), p.stat().st_mtime, people) for p, people in items]
        todo = [k for k in dict.fromkeys(keys) if k not in self.cache]
        if todo:
            with self.lock:
                self.used = time.time()
                if not self.proc or self.proc.poll() is not None:
                    self._start()
                self.proc.stdin.write(json.dumps({"images": [{"path": k[0], "people": k[2]} for k in todo]}) + "\n")
                self.proc.stdin.flush()
                line = self.proc.stdout.readline()
                self.used = time.time()
            if not line:
                self.proc = None
                raise RuntimeError("The look checker stopped")
            r = json.loads(line)
            if "error" in r:
                raise RuntimeError(r["error"])
            for k, it in zip(todo, r["items"]):
                self.cache[k] = it["crops"]
                while len(self.cache) > 400:
                    self.cache.popitem(last=False)
        return [self.cache[k] for k in keys]


class NoScorer:
    name = "none"

    def why(self):
        return "The look check is off (DECK_LOOK_SCORER=none)"


def _model_bases() -> list[str]:
    """base_path entries of ComfyUI's extra_model_paths.yaml (models kept on another drive)."""
    y = config.COMFY_DIR and config.COMFY_DIR / "extra_model_paths.yaml"
    if not y or not y.is_file():
        return []
    return [ln.split(":", 1)[1].strip() for ln in y.read_text(errors="replace").splitlines()
            if ln.strip().startswith("base_path:")]


SCORERS = {"clip": ClipScorer, "none": NoScorer}
_scorer = None


def scorer():
    global _scorer
    if _scorer is None:
        _scorer = SCORERS.get(os.environ.get("DECK_LOOK_SCORER", "clip"), NoScorer)()
    return _scorer


def hue_match(a, b) -> float | None:
    """How alike two crops' colours are (0..1): the overlap of their hue histograms. None when either is mostly grey
    (its hues say nothing)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    if a[:12].sum() < 0.03 or b[:12].sum() < 0.03:
        return None
    return float(np.minimum(a[:12] / a[:12].sum(), b[:12] / b[:12].sum()).sum())


def judge(result: list[dict], pack: list[list[dict]]) -> dict:
    """result: the checked picture's crops; pack: each pack picture's crops (the whole picture is used)."""
    refs = [p[0] for p in pack if p]
    if not refs:
        return {"score": None, "drift": False}
    R = np.array([r["vec"] for r in refs])
    best = None
    for c in result:
        sims = R @ np.array(c["vec"])
        i = int(sims.argmax())
        if best is None or sims[i] > best[0]:
            best = (float(sims[i]), c, i)
    look, crop, i = best
    colours = [x for x in (hue_match(crop["hist"], r["hist"]) for r in refs) if x is not None]
    colour = max(colours) if colours else None
    drift = look < LOOK_MIN or (colour is not None and colour < COLOUR_MIN)
    # one number for the badge: the look, pulled down by a colour change
    score = look if colour is None else min(look, look * (0.5 + 0.5 * min(1.0, colour / COLOUR_MIN)))
    return {"score": round(score, 3), "look": round(look, 3), "colour": None if colour is None else round(colour, 3),
            "drift": bool(drift), "box": crop.get("box")}


async def _input_path(name: str) -> Path:
    p = local_input(name) if local_input else None
    if p:
        return p
    data = await input_bytes(name)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    p = CACHE_DIR / f"{hashlib.sha1(name.encode()).hexdigest()[:16]}{Path(name).suffix or '.png'}"
    if not p.is_file() or p.read_bytes() != data:
        p.write_bytes(data)
    return p


@router.get("/status")
async def status():
    s = scorer()
    why = s.why()
    return {"scorer": s.name, "ready": not why, "why": why, "look_min": LOOK_MIN, "colour_min": COLOUR_MIN}


@router.post("/check")
async def check(body: dict = Body(...)):
    s = scorer()
    if s.why():
        raise HTTPException(503, s.why())
    img = body.get("image") or {}
    try:
        if img.get("input"):
            path = await _input_path(str(img["input"]))
        else:
            g = db.get_generation(int(img.get("generation")))
            if not g:
                raise HTTPException(404, "No such generation")
            path = output_path(g, g["outputs"][int(img.get("index", 0))])
        chars = [c for c in (body.get("characters") or []) if c.get("id") and c.get("pictures")][:8]
        packs = [[await _input_path(str(n)) for n in c["pictures"][:8]] for c in chars]
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(404, f"A picture is missing: {e}")
    if not path.is_file():
        raise HTTPException(404, "That picture is gone")
    items = [(path, True)] + [(p, False) for pk in packs for p in pk]
    try:
        crops = await asyncio.to_thread(s.embed, items)
    except Exception as e:
        raise HTTPException(500, f"Look check failed: {e}")
    out, k = {}, 1
    for c, pk in zip(chars, packs):
        out[c["id"]] = judge(crops[0], crops[k:k + len(pk)])
        k += len(pk)
    return {"scorer": s.name, "results": out}
