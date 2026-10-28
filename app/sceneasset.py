"""Files imported into the 3D tab (models, Gaussian splats, and what they refer to) are kept in the
project's own folder: projects/<folder>/.deck/assets/<import id>/<file name>. One import can be several
files (an OBJ with its MTL and textures, a glTF with its .bin) that share an import id, so their
relative names keep working. They are served under /files/projects/ like every other project file."""
import json
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
# The 3D view shows a lighter preview level (the most visible Gaussians of the full set); renders use the full set,
# kept beside them as <name>_full.ply. Levels with as many Gaussians as the full set, or more, aren't written.
SPLAT_MAX = int(os.environ.get("DECK_SPLAT_MAX", "250000"))   # (500k still crawled on the tablet; thin_splat's default)
LEVELS = (("light", 150_000), ("medium", 300_000), ("dense", 600_000))
LEVEL_NAMES = [k for k, _ in LEVELS] + ["full"]
LEVEL_SUFFIX = re.compile(r"(_t[0-9a-f]{8})?_(light|medium|dense|full)$")


def _read_ply(src: Path):
    """A binary little-endian splat .ply's vertex property names and values (n × props, float32)."""
    import numpy as np
    with src.open("rb") as f:
        if f.readline().strip() != b"ply":
            raise ValueError("Not a .ply file")
        props, n, el = [], 0, None
        while (line := f.readline().decode("ascii", "replace").strip()) != "end_header":
            if f.tell() > 1 << 16:
                raise ValueError("Bad .ply header")
            p = line.split()
            if p[:1] == ["format"] and p[1:2] != ["binary_little_endian"]:
                raise ValueError(f"Can't read {p[1]} .ply files, only binary little-endian ones")
            if p[:1] == ["element"]:
                el = p[1]
                if el == "vertex":
                    n = int(p[2])
            elif p[:1] == ["property"] and el == "vertex":
                if p[1] != "float":
                    raise ValueError(f"Unexpected splat property type {p[1]}")
                props.append(p[2])
        if not {"x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2"} <= set(props):
            raise ValueError("That .ply has no Gaussians in it (no opacity or scale)")
        raw = f.read(n * 4 * len(props))
        if len(raw) < n * 4 * len(props):
            raise ValueError("The .ply file is cut short")
    return props, np.frombuffer(raw, dtype="<f4").reshape(n, len(props))


def _write_ply(dst: Path, props, data):
    import numpy as np
    header = ["ply", "format binary_little_endian 1.0", f"element vertex {len(data)}", *[f"property float {k}" for k in props], "end_header"]
    tmp = dst.with_suffix(".tmp")
    with tmp.open("wb") as f:
        f.write(("\n".join(header) + "\n").encode())
        f.write(np.ascontiguousarray(data, dtype="<f4").tobytes())
    tmp.replace(dst)


def _visible_order(props, data):
    """The Gaussians' indices, most visible (opacity × size) first."""
    import numpy as np
    opacity = 1 / (1 + np.exp(-data[:, props.index("opacity")].astype("f8")))
    size = np.exp(data[:, [props.index("scale_0"), props.index("scale_1"), props.index("scale_2")]].astype("f8")).prod(1) ** (1 / 3)
    return np.argsort(-(opacity * size), kind="stable")


def grow_for(n: int, keep: int) -> float:
    """How much a preview's Gaussians grow to close the gaps the left-out ones leave: the fourth root of how many
    times fewer there are, at most 1.4 (1.0 when nothing is left out). On a synthetic splat thinned 5.5×, 1.1 left it
    see-through and 1.3-1.5 filled it; 1.2M → 150k gives 1.4, → 600k 1.19."""
    return 1.0 if keep >= n else round(min(1.4, (n / keep) ** 0.25), 4)


def _thinned(props, data, order, keep: int, grow: float = 1.0):
    """The `keep` most visible Gaussians (in file order), each grown by `grow`."""
    import numpy as np
    out = data[np.sort(order[:keep])]
    if grow != 1.0:
        out = out.copy()
        for k in ("scale_0", "scale_1", "scale_2"):
            out[:, props.index(k)] += math.log(grow)   # (scales are stored as logs)
    return out


def thin_splat(src: Path, dst: Path, keep: int = SPLAT_MAX):
    """Write src's Gaussians to dst, at most `keep` of them: the most visible (opacity × size) first. Only the vertex
    element is written (SHARP's camera elements after it are read by _ply_lens from the full file)."""
    props, data = _read_ply(src)
    _write_ply(dst, props, _thinned(props, data, _visible_order(props, data), keep) if len(data) > keep else data)


def splat_box(props, data) -> list:
    """Where the splat is, as the 3D tab's splatBox finds it: the middle 99% of its centres per axis,
    [x0, y0, z0, x1, y1, z1] in the file's own units."""
    import numpy as np
    xyz = data[:, [props.index("x"), props.index("y"), props.index("z")]].astype("f8")
    lo, hi = np.percentile(xyz, 0.5, axis=0), np.percentile(xyz, 99.5, axis=0)
    return [round(float(v), 3) for v in (*lo, *hi)]


def clean_trim(trim) -> dict | None:
    """A radial trim as the layer keeps it: {c: [x, y, z] (the centre, in the file's units), r (keep within this
    of c), near (drop within this of the photo's camera, the file's origin; 0 = off)} -> rounded, or None (no trim)."""
    if not trim:
        return None
    try:
        c = [round(float(v), 4) for v in trim["c"]]
        r, near = round(float(trim["r"]), 4), round(float(trim.get("near") or 0), 4)
    except (KeyError, TypeError, ValueError):
        raise ValueError("A trim is {c: [x, y, z], r, near}")
    if len(c) != 3 or not all(map(math.isfinite, [*c, r, near])) or r <= 0 or near < 0:
        raise ValueError("A trim needs a centre and a radius above 0")
    return {"c": c, "r": r, "near": near}


def trim_tag(trim: dict) -> str:
    import hashlib
    return hashlib.sha1(repr((trim["c"], trim["r"], trim["near"])).encode()).hexdigest()[:8]


def trim_mask(props, data, trim: dict):
    """Which Gaussians a trim keeps: centre within r of c, and farther than `near` from the origin."""
    import numpy as np
    xyz = data[:, [props.index("x"), props.index("y"), props.index("z")]].astype("f8")
    keep = ((xyz - np.array(trim["c"])) ** 2).sum(1) <= trim["r"] ** 2
    if trim["near"] > 0:
        keep &= (xyz ** 2).sum(1) > trim["near"] ** 2
    return keep


def make_levels(full: Path, base: str, grow: bool = True, trim: dict | None = None) -> dict:
    """The preview levels of the splat in `full`, written beside it as <base>_light.ply, _medium and _dense (only the
    ones lighter than the full set). -> {n: the full count, kept, box, levels: {name: {file, n}}}.
    With a trim (clean_trim) only the Gaussians it keeps go in, as <base>_t<tag>_<level>.ply, so a level's budget is
    spent inside the trim; the first level with room for all of them holds all of them. (Earlier trims' files stay:
    another layer may use them.) The box is always the untrimmed set's, so the layer doesn't move."""
    props, data = _read_ply(full)
    n, box = len(data), splat_box(props, data)
    if trim:
        data = data[trim_mask(props, data, trim)]
        if not len(data):
            raise ValueError("That trim leaves nothing: make the radius bigger")
    kept = len(data)
    order = _visible_order(props, data) if kept > LEVELS[0][1] else None
    prefix = f"{base}_t{trim_tag(trim)}" if trim else base
    levels = {}
    for k, keep in LEVELS:
        dst = full.with_name(f"{prefix}_{k}.ply")
        if keep >= kept:
            if trim and kept < n and not any(v["n"] >= kept for v in levels.values()):
                _write_ply(dst, props, data)   # (all of what the trim keeps)
                levels[k] = {"file": dst.name, "n": kept}
            elif dst != full and not trim:
                dst.unlink(missing_ok=True)   # (left from an earlier, bigger set)
            continue
        _write_ply(dst, props, _thinned(props, data, order, keep, grow_for(kept, keep) if grow else 1.0))
        levels[k] = {"file": dst.name, "n": keep}
    return {"n": n, "kept": kept, "box": box, "levels": levels}


def _asset_url(folder: str, group: str, name: str) -> str:
    return f"/files/projects/{quote(folder)}/.deck/assets/{group}/{quote(name)}"


def level_list(folder: str, group: str, made: dict, full_name: str | None) -> list:
    """make_levels' result as a splat layer keeps it: [{k, url, n}], lightest first, the full set last (when kept)."""
    out = [{"k": k, "url": _asset_url(folder, group, v["file"]), "n": v["n"]} for k, v in made["levels"].items()]
    if full_name:
        out.append({"k": "full", "url": _asset_url(folder, group, full_name), "n": made["n"]})
    return out


@router.post("/splat/levels")
async def splat_levels(body: dict = Body(...)):
    """{url: a splat asset's URL, trim?: {c, r, near}} -> {levels, n, kept, box, trim}: its preview levels, (re)made
    from its full set. That is <name>_full.ply when there is one (a photo's splat), else the file itself (an imported
    .ply), so older splats and imports get levels too. With a trim the levels hold only what it keeps (the full set
    stays whole: renders trim it as they draw)."""
    import asyncio
    from urllib.parse import unquote
    m = re.fullmatch(r"/files/projects/([^/]+)/\.deck/assets/([0-9a-f]{8})/([^/]+)", str((body or {}).get("url") or "").split("?")[0])
    if not m:
        raise HTTPException(400, "That isn't a splat in a project")
    folder, group, name = unquote(m[1]), m[2], unquote(m[3])
    if folder != Path(folder).name or folder.startswith(".") or name != _safe_name(name):
        raise HTTPException(404, "No such splat")
    d = config.PROJECTS_DIR / folder / ".deck" / "assets" / group
    path = d / name
    if not path.is_file() or path.resolve().parent != d.resolve():
        raise HTTPException(404, "No such splat")
    if path.suffix.lower() != ".ply":
        raise HTTPException(400, "Only .ply splats can get lighter previews")
    base = LEVEL_SUFFIX.sub("", path.stem)
    full = next((p for p in (d / f"{base}_full.ply", d / f"{base}{path.suffix}") if p.is_file()), None)
    if full is None:
        raise HTTPException(400, "The full set of that splat is gone: only a preview of it is left")
    try:
        trim = clean_trim(body.get("trim"))
        made = await asyncio.to_thread(make_levels, full, base, True, trim)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"levels": level_list(folder, group, made, full.name), "n": made["n"], "kept": made["kept"], "box": made["box"],
            "trim": trim}


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


def pick_level(levels: list, want: str) -> dict:
    """The densest of a layer's levels ([{k, url, n}], lightest first) no denser than `want`; else the lightest."""
    rank = LEVEL_NAMES.index(want) if want in LEVEL_NAMES else 0
    fit = [v for v in levels if LEVEL_NAMES.index(v["k"]) <= rank]
    return fit[-1] if fit else levels[0]


def finish_splat(full: Path, folder: str, group: str, preview: str = "light", keep_full: bool = True) -> dict:
    """After SHARP: the levels beside its full set, and the asset the new layer starts on (the preview level asked
    for). Without keep_full the full set is deleted once its lens is read and the levels are made (renders then use
    the densest level); a splat too small to thin keeps it either way."""
    lens = _ply_lens(full)
    base = LEVEL_SUFFIX.sub("", full.stem)
    made = make_levels(full, base)
    keep = keep_full or not made["levels"]
    levels = level_list(folder, group, made, full.name if keep else None)
    if not keep:
        full.unlink()
    pick = pick_level(levels, preview)
    name = full.name if pick["k"] == "full" else made["levels"][pick["k"]]["file"]
    return {"url": pick["url"], "name": name, "group": group, "kind": "splat", "size": (full.parent / name).stat().st_size,
            "lens": lens, "levels": levels, "level": pick["k"], "n": made["n"], "box": made["box"]}


@router.post("/splat")
async def photo_splat(body: dict = Body(...)):
    """{image (an input name), project_id, preview (light | medium | dense | full), keep_full} -> job; its result is
    the splat asset ({url, name, group, kind, size}: the preview level asked for), its levels ([{k, url, n}]), the
    full count and box, plus the photo's lens ({fov, width, height}) so the shot camera can look through it.
    (SHARP itself has no options worth giving: only --render, a turntable video, and the device.)"""
    from . import clipimport, voice   # (voice: the GPU lock and ComfyUI's unload)
    body = body or {}
    image = Path(str(body.get("image") or "")).name
    src = config.INPUT_DIR / image
    if not image or not src.is_file():
        raise HTTPException(400, "Pick a picture")
    preview = str(body.get("preview") or "light")
    if preview not in LEVEL_NAMES:
        raise HTTPException(400, "preview is light, medium, dense or full")
    keep_full = body.get("keep_full", True) is not False
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
            full = d / (Path(_safe_name(Path(image).stem + "_splat.ply")).stem + "_full.ply")
            shutil.move(str(plys[0]), full)
        job["label"] = "Making lighter previews"
        return finish_splat(full, folder, group, preview, keep_full)

    return clipimport._start(work, "Making the splat")


# ---- people in a photo: "Calibrate from a person" (a photo's mesh or splat scaled so a person in it is a real height) ----
PERSON_WORKER = config.BASE_DIR / "look" / "person_worker.py"


def _comfy_busy() -> bool:
    """ComfyUI has something running or waiting (the detector then waits: it would slow a run down)."""
    import httpx
    try:
        q = httpx.get(f"{config.COMFY_URL}/queue", timeout=5).json()
        return bool(len(q.get("queue_running", [])) + len(q.get("queue_pending", [])))
    except (httpx.HTTPError, ValueError):
        return False


def find_people(path: Path, py: Path, det: Path) -> dict:
    """look/person_worker.py on the picture, in ComfyUI's venv on the CPU -> {w, h, people: [[x0, y0, x1, y1, score]]}."""
    threads = str(max(1, (os.cpu_count() or 4) // 2))
    r = subprocess.run([str(py), "-I", str(PERSON_WORKER), str(path), str(det), "--threads", threads], capture_output=True,
                       text=True, timeout=180, env={**os.environ, "CUDA_VISIBLE_DEVICES": ""})
    lines = [ln for ln in (r.stdout or "").splitlines() if ln.startswith("{")]
    if not lines:
        raise RuntimeError(((r.stderr or "").strip().splitlines() or ["the person finder gave nothing back"])[-1][:300])
    out = json.loads(lines[-1])
    if "error" in out:
        raise RuntimeError(out["error"])
    return out


@router.post("/person")
async def photo_person(body: dict = Body(...)):
    """{image: an input name} -> {w, h, people: [[x0, y0, x1, y1, score], ...]}: the people in a photo (fractions of the
    picture, the tallest first), found with DWPose's YOLOX on the CPU; refused (409) while ComfyUI's queue is busy."""
    import asyncio
    from . import looks
    image = str((body or {}).get("image") or "")
    if not image:
        raise HTTPException(400, "This layer has no source picture")
    s = looks.ClipScorer()   # (only its paths: ComfyUI's venv and DWPose's YOLOX-L)
    if not s.py or not s.det:
        raise HTTPException(503, "No person finder here (ComfyUI's venv or DWPose's yolox_l.onnx wasn't found)")
    if await asyncio.to_thread(_comfy_busy):
        raise HTTPException(409, "ComfyUI is busy: try again when its queue is empty, or measure instead")
    try:
        path = await looks._input_path(image)
    except Exception as e:
        raise HTTPException(404, f"The source picture is missing: {e}")
    try:
        return await asyncio.to_thread(find_people, path, s.py, s.det)
    except Exception as e:
        raise HTTPException(500, f"Finding people failed: {e}")
