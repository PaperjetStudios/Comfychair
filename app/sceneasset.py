"""Files imported into the 3D tab (models, Gaussian splats, and what they refer to) are kept in the
project's own folder: projects/<folder>/.deck/assets/<import id>/<file name>. One import can be several
files (an OBJ with its MTL and textures, a glTF with its .bin) that share an import id, so their
relative names keep working. They are served under /files/projects/ like every other project file."""
import re
import shutil
import uuid
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

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
