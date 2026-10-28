"""Files imported into the 3D tab (models, Gaussian splats, and what they refer to) are kept in the
project's own folder: projects/<folder>/.deck/assets/<import id>/<file name>. One import can be several
files (an OBJ with its MTL and textures, a glTF with its .bin) that share an import id, so their
relative names keep working. They are served under /files/projects/ like every other project file."""
import math
import os
import re
import shutil
import struct
import subprocess
import tempfile
import uuid
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile

from . import config, db

MAX_ASSET = 200 << 20
MODELS = {".glb", ".gltf", ".obj", ".fbx"}
SPLATS = {".ply", ".splat", ".ksplat", ".spz"}
EXTRAS = {".mtl", ".bin", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tga"}  # what a model refers to
ALLOWED = MODELS | SPLATS | EXTRAS
GROUP_RE = re.compile(r"[0-9a-f]{8}")

router = APIRouter(prefix="/api/scene")


def _safe_name(raw: str) -> str:
    # the name only: no folders, no dot-leading names, letters/digits/._- (the rest becomes _)
    name = re.sub(r"[^\w.-]+", "_", Path((raw or "").replace("\\", "/")).name).lstrip(".")
    return name[:100]


@router.post("/asset")
async def upload_asset(file: UploadFile = File(...), project_id: str = Form(""), group: str = Form("")):
    pid = int(project_id) if project_id not in ("", "null") else None
    if pid is not None and not any(p["id"] == pid for p in db.list_projects()):
        raise HTTPException(404, "No such project")
    name = _safe_name(file.filename or "")
    ext = Path(name).suffix.lower()
    if not name or ext not in ALLOWED:
        raise HTTPException(400, f"Can't use {ext or 'that'} files: try glb, gltf, obj, fbx, ply, splat, ksplat or spz")
    if group and not GROUP_RE.fullmatch(group):
        raise HTTPException(400, "Bad import id")
    group = group or uuid.uuid4().hex[:8]
    folder = db.project_folder(pid)
    d = config.PROJECTS_DIR / folder / ".deck" / "assets" / group
    d.mkdir(parents=True, exist_ok=True)
    path = d / name
    if path.resolve().parent != d.resolve():  # (belt and braces: _safe_name leaves no separators)
        raise HTTPException(400, "Bad file name")
    size = 0
    try:
        with path.open("wb") as f:
            while chunk := await file.read(1 << 20):
                size += len(chunk)
                if size > MAX_ASSET:
                    raise HTTPException(413, f"That file is over {MAX_ASSET >> 20} MB")
                f.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        if not any(d.iterdir()):
            shutil.rmtree(d, ignore_errors=True)
        raise
    kind = "model" if ext in MODELS else "splat" if ext in SPLATS else "extra"
    url = f"/files/projects/{quote(folder)}/.deck/assets/{group}/{quote(name)}"
    return {"url": url, "name": name, "group": group, "kind": kind, "size": size}


# ---- a picture as a Gaussian splat: Apple's SHARP (apple/ml-sharp), in its own venv on /mnt/data ----
# One photo in, about 1.2M Gaussians out (a .ply in the photo's camera space, metres, OpenCV axes: y down, z away),
# saved as an asset like an imported splat. It runs on the GPU outside ComfyUI, as the voice tools do: ComfyUI is
# asked to unload its models first, and a run is refused while ComfyUI has work queued. Best for small camera moves
# near where the photo was taken; nothing behind what the picture shows exists.
SHARP = Path(os.environ.get("DECK_SHARP", "/mnt/data/sharp-venv/bin/sharp"))
SHARP_CKPT = Path(os.environ.get("DECK_SHARP_CKPT", "/mnt/data/ComfyUI/models/sharp/sharp_2572gikvuh.pt"))


# SHARP makes about 1.2M Gaussians: too many for a tablet's GPU (the 3D view went white: its WebGL context gave out).
# The scene layer gets the most visible SPLAT_MAX of them; the full set is kept beside it (<name>_full.ply).
SPLAT_MAX = int(os.environ.get("DECK_SPLAT_MAX", "500000"))


def thin_splat(src: Path, dst: Path, keep: int):
    """Write src's Gaussians to dst, at most `keep` of them: the most visible (opacity × size) first. Only the vertex
    element is written (SHARP's camera elements after it are read by _ply_lens from the full file)."""
    import numpy as np
    with src.open("rb") as f:
        props, n, el = [], 0, None
        while (line := f.readline().decode("ascii", "replace").strip()) != "end_header":
            p = line.split()
            if p[:1] == ["element"]:
                el = p[1]
                if el == "vertex":
                    n = int(p[2])
            elif p[:1] == ["property"] and el == "vertex":
                if p[1] != "float":
                    raise ValueError(f"Unexpected splat property type {p[1]}")
                props.append(p[2])
        data = np.frombuffer(f.read(n * 4 * len(props)), dtype="<f4").reshape(n, len(props))
    if n > keep:
        col = {k: i for i, k in enumerate(props)}
        opacity = 1 / (1 + np.exp(-data[:, col["opacity"]]))
        size = np.exp(data[:, [col["scale_0"], col["scale_1"], col["scale_2"]]]).prod(1) ** (1 / 3)
        data = data[np.sort(np.argsort(-(opacity * size))[:keep])]
    header = ["ply", "format binary_little_endian 1.0", f"element vertex {len(data)}", *[f"property float {k}" for k in props], "end_header"]
    tmp = dst.with_suffix(".tmp")
    with tmp.open("wb") as f:
        f.write(("\n".join(header) + "\n").encode())
        f.write(np.ascontiguousarray(data, dtype="<f4").tobytes())
    tmp.replace(dst)


def _ply_lens(path: Path) -> dict:
    """The camera SHARP saved after the Gaussians (its intrinsic and image_size elements): vertical field of view."""
    sizes = {"float": 4, "uint": 4, "int": 4, "uchar": 1, "char": 1, "ushort": 2, "short": 2, "double": 8}
    with path.open("rb") as f:
        elems, cur = [], None
        while (line := f.readline().decode("ascii", "replace").strip()) != "end_header":
            p = line.split()
            if p[:1] == ["element"]:
                cur = [p[1], int(p[2]), []]; elems.append(cur)
            elif p[:1] == ["property"] and cur:
                cur[2].append(p[1])
        data = {}
        for name, n, props in elems:
            raw = f.read(n * sum(sizes[t] for t in props))
            if name in ("intrinsic", "image_size"):
                fmt = "".join({"float": "f", "uint": "I", "int": "i"}[t] for t in props) * n
                data[name] = struct.unpack("<" + fmt, raw)
    k, wh = data.get("intrinsic"), data.get("image_size")
    if not k or not wh:
        return {}
    fy, h = k[4], wh[1]
    return {"fov": round(math.degrees(2 * math.atan(h / (2 * fy))), 2), "width": wh[0], "height": wh[1]}


@router.post("/splat")
async def photo_splat(body: dict = Body(...)):
    """{image (an input name), project_id} -> job; its result is the splat asset ({url, name, group, kind, size}) plus the
    photo's lens ({fov, width, height}) so the shot camera can look through it."""
    from . import clipimport, voice   # (voice: the GPU lock and ComfyUI's unload)
    image = Path(str((body or {}).get("image") or "")).name
    src = config.INPUT_DIR / image
    if not image or not src.is_file():
        raise HTTPException(400, "Pick a picture")
    if not SHARP.is_file() or not SHARP_CKPT.is_file():
        raise HTTPException(400, f"SHARP isn't installed ({SHARP}, {SHARP_CKPT})")
    pid = body.get("project_id")
    pid = int(pid) if pid not in (None, "", "null") else None
    folder = db.project_folder(pid)

    def work(job):
        group = uuid.uuid4().hex[:8]
        d = config.PROJECTS_DIR / folder / ".deck" / "assets" / group
        with tempfile.TemporaryDirectory() as tmp, voice._gpu:
            voice._free_gpu()
            job["label"] = "Making the splat"
            inp = Path(tmp) / "in"; inp.mkdir()
            shutil.copy(src, inp / (Path(image).stem + Path(image).suffix.lower()))
            r = subprocess.run([str(SHARP), "predict", "-i", str(inp), "-o", str(Path(tmp) / "out"), "-c", str(SHARP_CKPT), "--device", "cuda"],
                               capture_output=True, text=True, timeout=900)
            plys = sorted((Path(tmp) / "out").glob("*.ply"))
            if r.returncode or not plys:
                raise RuntimeError("SHARP failed: " + ((r.stderr or r.stdout).strip().splitlines() or ["no output"])[-1][:300])
            d.mkdir(parents=True, exist_ok=True)
            name = _safe_name(Path(image).stem + "_splat.ply")
            full = d / (Path(name).stem + "_full.ply")
            shutil.move(str(plys[0]), full)
        lens = _ply_lens(full)
        job["label"] = "Thinning it for the tablet"
        thin_splat(full, d / name, SPLAT_MAX)
        size = (d / name).stat().st_size
        return {"url": f"/files/projects/{quote(folder)}/.deck/assets/{group}/{quote(name)}", "name": name, "group": group,
                "kind": "splat", "size": size, "lens": lens}

    return clipimport._start(work, "Making the splat")
