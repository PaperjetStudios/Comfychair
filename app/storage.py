"""Where ComfyChair's files go, and making sure they go away when they're deleted.

The rules (see also the tests in tests/test_storage.py):
- ComfyUI keeps nothing: once ComfyChair has its own copy of a run's outputs, ComfyUI's copies (with the files it
  wrote beside them and never reported: a video's silent copy, its first-frame PNG, an auto-rigger's GLB/FBX
  pair and texture folder) are deleted, and the run leaves ComfyUI's history (which holds its prompt).
- Deleting a run, a picture or a project removes every copy of its files: ComfyChair's, ComfyUI's, and the
  thumbnails and previews cached from them.
- sweep() finds what was left behind before these rules, in ComfyChair's own folders in ComfyUI only, and never
  a file ComfyChair has no other copy of.
"""
import hashlib
import json
import logging
import re
import shutil
import time
from pathlib import Path

from . import config, db

log = logging.getLogger("comfydeck.storage")

PREVIEW_DIR = config.THUMB_DIR / "previews"
RIG_COPY = re.compile(r"^\d{5}_[\w.\-]+\.(glb|gltf|fbx|obj|ply|stl)$", re.I)   # /api/scene/mesh's copies in input/3d
FRESH = 600   # a file this new (seconds) may be a run still writing: the sweep leaves it


def tag(key) -> str:
    """The prefix every cached thumbnail and preview of one source starts with, so deleting the source can find
    them all (whatever size or kind was made)."""
    return hashlib.sha1(str(key).encode()).hexdigest()[:12]


def drop_caches(*keys) -> int:
    """Delete the thumbnails and previews made from these sources (resolved paths, or input names)."""
    n = 0
    for k in keys:
        t = tag(k)
        for d in (config.THUMB_DIR, PREVIEW_DIR):
            for p in d.glob(f"{t}-*"):
                p.unlink(missing_ok=True)
                n += 1
    return n


def _inside(p: Path, root: Path | None) -> bool:
    try:
        return bool(root) and p.resolve().is_relative_to(root.resolve()) and p.resolve() != root.resolve()
    except OSError:
        return False


def family(p: Path) -> list[Path]:
    """A file ComfyUI wrote and the ones it wrote beside it under the same name: h3_00001-audio.mp4 comes with
    h3_00001.mp4 and h3_00001.png; rigged_mia_x.fbx with rigged_mia_x.glb and the rigged_mia_x.fbm/ textures."""
    base = p.stem.removesuffix("-audio")
    names = {base, base + "-audio"}
    out = []
    try:
        for q in p.parent.iterdir():
            if (q.is_file() and q.stem in names) or (q.is_dir() and q.name in {n + ".fbm" for n in names}):
                out.append(q)
    except OSError:
        pass
    return out


def remove(paths) -> int:
    """Delete files and folders; returns the bytes freed."""
    freed = 0
    for p in paths:
        try:
            if p.is_dir() and not p.is_symlink():
                freed += sum(f.stat().st_size for f in p.rglob("*") if f.is_file())
                shutil.rmtree(p, ignore_errors=True)
            elif p.exists() or p.is_symlink():
                freed += p.stat().st_size if p.is_file() else 0
                p.unlink(missing_ok=True)
        except OSError:
            log.warning("couldn't delete %s", p, exc_info=True)
    return freed


def comfy_path(item: dict) -> Path | None:
    """ComfyUI's file for a reported output ({filename, subfolder, type}), if it's in its output or temp folder."""
    root = {"output": config.COMFY_OUTPUT_DIR, "temp": config.COMFY_TEMP_DIR}.get(item.get("type") or "output")
    if not root:
        return None
    p = root / (item.get("subfolder") or "") / Path(item.get("filename", "")).name
    return p if _inside(p, root) else None


def drop_comfy_outputs(items: list[dict], saved: list[Path]) -> int:
    """After a run: ComfyUI's copies of what it reported, and their family, once every one of ComfyChair's copies
    is on disk (if one is missing or empty nothing is deleted: ComfyUI's may be the only copy)."""
    if not saved or not all(p.is_file() and p.stat().st_size > 0 for p in saved):
        return 0
    # (previews in ComfyUI's temp folder stay: it empties that itself when it starts, and a preview node has no
    # file name to make unique, so a repeated run is answered with the same temp files)
    paths = {q for it in items if it.get("type", "output") == "output" and (p := comfy_path(it)) for q in family(p)}
    freed = remove(paths)
    for d in {p.parent for p in paths}:   # the run's own folder (comfy.once), now empty
        if d.name.startswith("run-") and _inside(d, config.COMFY_OUTPUT_DIR) and d.is_dir() and not any(d.iterdir()):
            d.rmdir()
    return freed


def rig_input(wf: dict | None) -> Path | None:
    """The mesh copy in ComfyUI's input/3d an auto-rig run read (put there by /api/scene/mesh), if any."""
    if not wf or not config.COMFY_INPUT_DIR:
        return None
    for node in wf.values():
        if node.get("class_type") != "UniRigLoadMesh":
            continue
        v = node["inputs"].get("file_path")
        for _ in range(4):   # (through the switch to the text field)
            if not (isinstance(v, list) and len(v) == 2 and v[0] in wf):
                break
            ins = wf[v[0]]["inputs"]
            v = ins.get("value", ins.get("on_true"))
        if isinstance(v, str) and v.startswith("3d/") and RIG_COPY.match(Path(v).name):
            p = config.COMFY_INPUT_DIR / v
            if _inside(p, config.COMFY_INPUT_DIR / "3d"):
                return p
    return None


# ---- pictures (inputs) ----
def input_files(name: str) -> list[Path]:
    """Every copy of an input picture: ComfyChair's and ComfyUI's."""
    from .main import local_input   # (main imports this module)
    out = []
    if (p := local_input(name)) is not None:
        out.append(p)
    if config.COMFY_INPUT_DIR:
        p = config.COMFY_INPUT_DIR / name
        if _inside(p, config.COMFY_INPUT_DIR):
            out.append(p)
    return out


def input_used(name: str) -> bool:
    """Whether any run or any project's tab uses this picture (a deleted project's are gone by then)."""
    for g in db.all_generations():
        if name in json.dumps(g["params"]):
            return True
    for f in config.PROJECTS_DIR.glob("*/.deck/*-tabs/*.json"):
        try:
            if name in f.read_text(errors="ignore"):
                return True
        except OSError:
            continue
    return False


def delete_input(name: str) -> int:
    """A picture, for good: its files, ComfyUI's copy, its thumbnails and its rows."""
    files = input_files(name)
    drop_caches(name, *[p.resolve() for p in files if p.exists()])
    freed = remove(files)
    db.delete_input(name)
    return freed


# ---- what was left behind ----
def _kept_comfy_copies() -> set[Path]:
    """ComfyUI's copies that are the only copy left (ComfyChair's own is gone): never swept."""
    keep = set()
    out = config.COMFY_OUTPUT_DIR
    for g in db.all_generations():
        for o in g["outputs"] or []:
            ours = config.PROJECTS_DIR / o["path"] if o.get("path") else config.GEN_DIR / str(g["id"]) / o["filename"]
            if ours.is_file():
                continue
            c = o.get("comfy")
            if c and (p := comfy_path(c)):
                keep.add(p.resolve())
            elif out:
                sub = config.COMFY_INPUT_SUBFOLDER
                for p in (out / sub / db.project_folder(g["project_id"]) / o["filename"], out / sub / o["filename"]):
                    keep.add(p.resolve())
    return keep


def sweep(do: bool = False) -> dict:
    """What ComfyUI still holds of ComfyChair's (its output/comfydeck folder, the mesh copies in input/3d) and the
    thumbnail caches. With do=True it's deleted. Leaves files under FRESH seconds old and sole copies."""
    now, items = time.time(), []
    keep = _kept_comfy_copies()

    def add(p: Path, why: str):
        try:
            st = p.stat()
        except OSError:
            return
        if now - st.st_mtime < FRESH or p.resolve() in keep:
            return
        size = sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.is_dir() else st.st_size
        items.append({"path": str(p), "bytes": size, "why": why})

    if config.COMFY_OUTPUT_DIR:
        mine = config.COMFY_OUTPUT_DIR / config.COMFY_INPUT_SUBFOLDER
        if mine.is_dir():
            for p in sorted(mine.rglob("*")):
                if p.is_file():
                    add(p, "ComfyUI's copy of a ComfyChair output")
    if config.COMFY_INPUT_DIR and (config.COMFY_INPUT_DIR / "3d").is_dir():
        for p in sorted((config.COMFY_INPUT_DIR / "3d").iterdir()):
            if p.is_file() and RIG_COPY.match(p.name):
                add(p, "a model copied in for rigging")
    for d in (config.THUMB_DIR, PREVIEW_DIR):
        for p in sorted(d.glob("*")):
            if p.is_file() and not re.match(r"^[0-9a-f]{12}-", p.name):
                add(p, "an old thumbnail (made again when it's needed)")
    total = sum(i["bytes"] for i in items)
    freed = remove(Path(i["path"]) for i in items) if do else 0
    if do:
        for d in sorted({Path(i["path"]).parent for i in items}, key=lambda p: -len(p.parts)):   # folders left empty
            if _inside(d, config.COMFY_OUTPUT_DIR) and d.is_dir() and not any(d.iterdir()):
                d.rmdir()
        log.info("storage sweep: %d files, %.1f MB freed", len(items), freed / 1e6)
    return {"items": items, "bytes": total, "freed": freed, "count": len(items)}
