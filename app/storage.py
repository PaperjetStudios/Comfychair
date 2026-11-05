"""Where ComfyChair's files go, and making sure they go away when they're deleted.

The rules (see also the tests in tests/test_storage.py):
- ComfyUI keeps nothing: once ComfyChair has its own copy of a run's outputs, ComfyUI's copies (with the files it
  wrote beside them and never reported: a video's silent copy, its first-frame PNG, an auto-rigger's GLB/FBX
  pair and texture folder) are deleted, and the run leaves ComfyUI's history (which holds its prompt).
- Deleting a run, a picture or a project removes every copy of its files: ComfyChair's, ComfyUI's, and the
  thumbnails, previews and Extend frame canvases cached from them.
- A saved picture (main.saved_run) is an input and a run on the Board with one copy each: deleting either takes both.
- The 3D tab's files (imports, photo splats, Blender clean-ups: asset_dir) live in their project's folder and go with it.
- sweep() finds what was left behind before these rules, in ComfyChair's own folders in ComfyUI only, and never
  a file ComfyChair has no other copy of.
- project_unused() lists one project's pictures, 3D imports and stray files that nothing uses; drop_unused() deletes
  the ones picked from that list. A saved document, in the trash too, or a run still on its way always holds a file.
"""
import hashlib
import json
import logging
import re
import shutil
import time
from pathlib import Path
from urllib.parse import quote

from . import config, db

log = logging.getLogger("comfydeck.storage")

PREVIEW_DIR = config.THUMB_DIR / "previews"
CACHE_DIRS = (config.THUMB_DIR, PREVIEW_DIR, config.VIDEOPREP_DIR, config.PLAYABLE_DIR)   # (PLAYABLE_DIR: playable.py's <tag>-play.mp4; VIDEOPREP_DIR: /api/video/canvas's <tag>-canvas_*.mp4)
SOLVE_FRAME = re.compile(r"^solve_[0-9a-f]{12}\.png$")   # app/solve.py's first frame for MoGe, in input/comfydeck
RIG_COPY = re.compile(r"^\d{5}_[\w.\-]+\.(glb|gltf|fbx|obj|ply|stl)$", re.I)   # /api/scene/mesh's copies in input/3d
FRESH = 600   # a file this new (seconds) may be a run still writing: the sweep leaves it


def tag(key) -> str:
    """The prefix every cached thumbnail and preview of one source starts with, so deleting the source can find
    them all (whatever size or kind was made)."""
    return hashlib.sha1(str(key).encode()).hexdigest()[:12]


def drop_caches(*keys) -> int:
    """Delete the thumbnails, previews and canvases made from these sources (resolved paths, or input names)."""
    n = 0
    for k in keys:
        t = tag(k)
        for d in CACHE_DIRS:
            for p in d.glob(f"{t}-*"):
                p.unlink(missing_ok=True)
                n += 1
    return n


def prune_canvas(max_age_days=30):
    """Extend frame's canvases are remade on demand: clear the ones unused for a month (main.py's lifespan)."""
    cutoff = time.time() - max_age_days * 86400
    for p in config.VIDEOPREP_DIR.glob("*-canvas_*.mp4"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:
            pass


def asset_dir(folder: str, group: str) -> Path:
    """Where one 3D-tab import (or splat, or Blender clean-up) keeps its files: inside its project's folder, so
    deleting the project deletes them (projects.delete removes the folder)."""
    return config.PROJECTS_DIR / folder / ".deck" / "assets" / group


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


def drop_view_marks(project_folder: str, gid: int) -> None:
    """The frames marked on a run's clip (Mark views) go with the run."""
    (config.PROJECTS_DIR / project_folder / ".deck" / "view-marks" / f"g{gid}.json").unlink(missing_ok=True)


def drop_comfy_outputs(items: list[dict], saved: list[Path]) -> int:
    """After a run: ComfyUI's copies of what it reported, and their family, once every one of ComfyChair's copies
    is on disk (if one is missing or empty nothing is deleted: ComfyUI's may be the only copy)."""
    if not saved or not all(p.is_file() and p.stat().st_size > 0 for p in saved):
        return 0
    return drop_comfy_read(items)


def drop_comfy_read(items: list[dict]) -> int:
    """ComfyUI's copies of reported outputs ComfyChair only reads and keeps nowhere (a node's JSON answer, such as
    app/solve.py's geometry), their family, and the run's own folder once it's empty."""
    # (previews in ComfyUI's temp folder stay: it empties that itself when it starts, and a preview node has no
    # file name to make unique, so a repeated run is answered with the same temp files)
    paths = {q for it in items if it.get("type", "output") == "output" and (p := comfy_path(it)) for q in family(p)}
    freed = remove(paths)
    for d in {p.parent for p in paths}:   # the run's own folder (comfy.once), now empty
        if d.name.startswith("run-") and _inside(d, config.COMFY_OUTPUT_DIR) and d.is_dir() and not any(d.iterdir()):
            d.rmdir()
    return freed


def comfy_input(name: str) -> Path | None:
    """ComfyUI's input file for a name upload_image returned (subfolder/name), if it's inside its input folder."""
    if not config.COMFY_INPUT_DIR or not name:
        return None
    p = config.COMFY_INPUT_DIR / name
    return p if _inside(p, config.COMFY_INPUT_DIR) else None


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
def crop_name(name: str, key: str) -> str:
    """The file a crop of a picture is sent to a run as: named after the picture, so input_files finds it when the picture goes."""
    return f"crop_{tag(name)}_{key}.png"


def input_files(name: str) -> list[Path]:
    """Every copy of an input picture: ComfyChair's, ComfyUI's and the crops cut from it for runs."""
    from .main import local_input   # (main imports this module)
    out = []
    if (p := local_input(name)) is not None:
        out.append(p)
    if config.COMFY_INPUT_DIR:
        p = config.COMFY_INPUT_DIR / name
        if _inside(p, config.COMFY_INPUT_DIR):
            out.append(p)
        out += (config.COMFY_INPUT_DIR / config.COMFY_INPUT_SUBFOLDER).glob(crop_name(name, "*"))
    return out


def _doc_files():
    """Every saved document of every project, and the shared library's: tabs, characters, scenes, tracks and the rest
    (a trashed one is in .trash, one folder further down, so it isn't here)."""
    yield from config.PROJECTS_DIR.glob("*/.deck/*/*.json")
    yield from config.LIBRARY_DIR.glob("*/*.json")


def input_used(name: str) -> bool:
    """Whether any run or any saved document uses this picture (a deleted project's are gone by then)."""
    for g in db.all_generations():
        if name in json.dumps(g["params"]):
            return True
    for f in _doc_files():
        try:
            if name in f.read_text(errors="ignore"):
                return True
        except OSError:
            continue
    return False


def media_used(name: str) -> str | None:
    """The project that uses this media-library file in a tab (video, sound, VFX) or a run's params (None: nobody). An "import"
    run holds its own copy, so it doesn't count."""
    for g in db.all_generations():
        if g["template"] != "import" and name in json.dumps(g["params"]):
            return (db.get_project(g["project_id"]) or {}).get("name") or "Unsorted"
    for f in _doc_files():
        try:
            if name in f.read_text(errors="ignore"):
                return f.relative_to(config.PROJECTS_DIR).parts[0] if f.is_relative_to(config.PROJECTS_DIR) else "the library"
        except OSError:
            continue
    return None


# ---- what's attached: a run nothing may delete while something uses it ----
_NOT_USE_KEYS = {"parent", "pending", "vpending"}   # where a run came from, and runs still on their way, aren't uses
_NOT_USE_KINDS = {"view-marks", "prefs", "gen-presets", "setups"}   # settings, not uses of a run
_KIND_LABEL = {"characters": "Character", "story-tabs": "Story", "scene-tabs": "3D", "scenes": "3D scene", "video-tabs": "Video",
               "sound-tabs": "Sound", "vfx-tabs": "VFX", "edit-tabs": "Image", "gen-tabs": "Generate", "objects": "3D object", "tracks": "Tracks", "tables": "Table"}


def _run_refs(v, origins: dict, out: set):
    """The runs one document's value points at: {generation: id} and {gen: id}, and a picture made from a run's output."""
    if isinstance(v, dict):
        for k, x in v.items():
            if k in _NOT_USE_KEYS:
                continue
            if k in ("generation", "gen") and isinstance(x, int) and not isinstance(x, bool):
                out.add(x)
            else:
                _run_refs(x, origins, out)
    elif isinstance(v, list):
        for x in v:
            _run_refs(x, origins, out)
    elif isinstance(v, str) and v in origins:
        out.add(origins[v])


def attachments() -> dict[int, list[dict]]:
    """{run id: [{kind, label, project, id, name}]}: every run a saved document uses, in any project (a trashed document
    doesn't count). The Board shows these and the delete routes refuse them, until the owner lets go."""
    origins = db.input_origin_runs()
    found: dict[int, list[dict]] = {}
    for f in config.PROJECTS_DIR.glob("*/.deck/*/*.json"):
        kind = f.parent.name
        if kind in _NOT_USE_KINDS:
            continue
        try:
            doc = json.loads(f.read_text(errors="ignore"))
        except (OSError, ValueError):
            continue
        refs: set[int] = set()
        _run_refs(doc.get("payload"), origins, refs)
        for gid in refs:
            found.setdefault(gid, []).append({"kind": kind, "label": _KIND_LABEL.get(kind, kind), "project": f.relative_to(config.PROJECTS_DIR).parts[0],
                                              "id": doc.get("id") or f.stem, "name": doc.get("name") or ""})
    return found


# ---- a frame's cached render: frame.render = {generation, key} (a run) or {media, key} (a sound mix in the media library) ----
def frame_renders(payload) -> dict[str, dict]:
    """{frame id: its cached render {generation|media, key}} for the frames of a table payload that have one."""
    out = {}
    for f in (payload or {}).get("frames") or []:
        r = f.get("render") if isinstance(f, dict) else None
        if isinstance(r, dict) and f.get("id") is not None and (isinstance(r.get("media"), str) or (
                isinstance(r.get("generation"), int) and not isinstance(r.get("generation"), bool))):
            out[str(f["id"])] = {k: r[k] for k in ("generation", "media", "key") if k in r}
    return out


def _same_render(a: dict, b: dict) -> bool:
    return a.get("generation") == b.get("generation") and a.get("media") == b.get("media")


def render_changes(before, after) -> tuple[list[dict], list[tuple[str, dict]]]:
    """A table saved: ([renders to drop now], [(frame doc id, render) of frames that left the table]). A frame whose render was
    replaced or cleared drops the old one; a frame that is gone keeps its render until its document leaves the trash for good."""
    old, new = frame_renders(before), frame_renders(after)
    kept = list(new.values())
    now_ids = {str(f.get("id")) for f in (after or {}).get("frames") or [] if isinstance(f, dict)}
    docs = {str(f.get("id")): f.get("doc") for f in (before or {}).get("frames") or [] if isinstance(f, dict)}
    drop, stash = [], []
    for fid, r in old.items():
        if fid in new and _same_render(r, new[fid]):
            continue
        if any(_same_render(r, k) for k in kept):
            continue
        if fid in now_ids:
            drop.append(r)
        elif isinstance(docs.get(fid), str):
            stash.append((docs[fid], r))
    return drop, stash


def render_media_drop(render: dict) -> bool:
    """A cached sound mix, for good, unless a tab or run uses it. (A cached run goes through the server's delete: main.py.)"""
    name = render.get("media")
    path = config.MEDIA_DIR / Path(name).name if isinstance(name, str) else None
    if not path or not path.is_file() or media_used(path.name):
        return False
    path.unlink()
    drop_caches(path.name, path.resolve())
    return True


def render_run_free(render: dict) -> int | None:
    """The run id of a cached render if no saved document uses it any more (else None)."""
    gid = render.get("generation")
    if not isinstance(gid, int) or isinstance(gid, bool) or gid in attachments():
        return None
    return gid


def stash_render(d: Path, doc_id: str, render: dict):
    """A frame left its table but its document is in the trash (Undo): its render waits beside it until the document is purged."""
    (d / ".trash").mkdir(parents=True, exist_ok=True)
    (d / ".trash" / f"{doc_id}.render.json").write_text(json.dumps(render))


def unstash_render(d: Path, doc_id: str):
    """A frame points at this document again with its render: the render no longer waits for the document's purge."""
    if re.fullmatch(r"[A-Za-z0-9_-]{1,64}", doc_id or ""):
        (d / ".trash" / f"{doc_id}.render.json").unlink(missing_ok=True)


def stashed_renders(d: Path) -> list[tuple[str, dict, Path]]:
    """[(doc id, render, file)] of the waiting renders in a document folder's trash whose document is gone for good (no live
    copy, no trashed copy)."""
    out = []
    tr = d / ".trash"
    for f in tr.glob("*.render.json") if tr.is_dir() else []:
        did = f.name[:-len(".render.json")]
        if (d / f"{did}.json").exists() or any(p.name[len(did) + 1:-5].isdigit() for p in tr.glob(f"{did}.*.json")):
            continue
        try:
            out.append((did, json.loads(f.read_text()), f))
        except (OSError, ValueError):
            f.unlink(missing_ok=True)
    return out


def used_by_text(owners: list[dict]) -> str:
    """A run's owners for a sentence: Character Mara, Video Cut 2."""
    return ", ".join(f"{o['label']} {o['name']}".strip() for o in owners)


def characters_using(test) -> list[str]:
    """The characters, in any project, whose saved payload passes test(payload): their names."""
    names = []
    for f in config.PROJECTS_DIR.glob("*/.deck/characters/*.json"):
        try:
            doc = json.loads(f.read_text(errors="ignore"))
            if test(doc.get("payload") or {}):
                names.append(doc.get("name") or "Someone")
        except (OSError, ValueError):
            continue
    return names


def character_pictures(payload: dict) -> set[str]:
    """Every input name a character's payload holds (any field, any look)."""
    out: set[str] = set()
    def walk(v):
        if isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, str) and v.startswith(config.COMFY_INPUT_SUBFOLDER + "/"):
            out.add(v)
    walk(payload)
    return out


def drop_character_pictures(payload: dict) -> int:
    """A character has left the trash for good: its pictures go, unless something else uses them."""
    freed = 0
    for name in character_pictures(payload):
        if not input_used(name):
            freed += delete_input(name)
    return freed


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
    if config.COMFY_INPUT_DIR and (config.COMFY_INPUT_DIR / config.COMFY_INPUT_SUBFOLDER).is_dir():
        for p in sorted((config.COMFY_INPUT_DIR / config.COMFY_INPUT_SUBFOLDER).iterdir()):
            if p.is_file() and SOLVE_FRAME.match(p.name):
                add(p, "a frame copied in for a camera solve")
    live = {tag(m.name) for m in config.MEDIA_DIR.iterdir()}
    for p in sorted(config.PLAYABLE_DIR.glob("*-play.mp4")):   # a cache of a media file; the original is the content
        if p.is_file() and p.name[:-len("-play.mp4")] not in live:
            add(p, "a playable copy of a media file that's gone")
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


# ---- what one project no longer uses (Settings -> Projects -> Clean up this project) ----
def _uses() -> tuple[str, str]:
    """(everything saved documents and unfinished runs name, everything finished runs name) as text. A trashed document
    counts: Undo can bring it back. A run's workflow counts too: it holds the resized copies its params don't name."""
    docs, runs = [], []
    for f in (*_doc_files(), *config.PROJECTS_DIR.glob("*/.deck/*/.trash/*.json"), *config.LIBRARY_DIR.glob("*/.trash/*.json")):
        try:
            docs.append(f.read_text(errors="ignore"))
        except OSError:
            continue
    for status, text in db.run_texts():
        (runs if status in ("done", "error", "interrupted") else docs).append(text)
    return "\n".join(docs), "\n".join(runs)


def _named(text: str, name: str) -> bool:
    """Whether a document's or a run's text names this file, however it's written there (in a URL, in escaped JSON)."""
    return name in text or quote(name) in text or json.dumps(name)[1:-1] in text


def _newest(p: Path) -> float:
    return max((f.stat().st_mtime for f in p.rglob("*") if f.is_file()), default=p.stat().st_mtime) if p.is_dir() else p.stat().st_mtime


def project_unused(project_id) -> dict:
    """One project's files nothing uses, listed and not touched: its input pictures, its 3D imports (while no outside job
    has the card: one may be writing into a new import) and files in its folder that are no run's output. tier "free": nothing
    names it. tier "runs": only finished runs do, which keep their outputs but can't run again without it. Runs themselves
    aren't listed, nor a picture saved to the Board (it is a run), nor anything under FRESH seconds old."""
    from . import gpu   # (it imports nothing of this, but only this list needs it)
    docs, runs = _uses()
    now, items = time.time(), []

    def add(kind: str, key: str, name: str, p: Path, size: int, *refs: str):
        try:
            if now - _newest(p) < FRESH or any(_named(docs, r) for r in refs):
                return
        except OSError:
            return
        items.append({"id": f"{kind}:{key}", "kind": kind, "name": name, "bytes": size, "tier": "runs" if any(_named(runs, r) for r in refs) else "free"})

    for r in db.project_inputs(project_id):
        name = r["name"]
        files = [p for p in input_files(name) if p.is_file()]
        if files and not (db.input_origin(name) or {}).get("saved"):
            add("input", name, Path(name).name, files[0], files[0].stat().st_size, Path(name).name)

    root = config.PROJECTS_DIR / db.project_folder(project_id)
    assets = root / ".deck" / "assets"
    if assets.is_dir() and not gpu.state()[0]:
        for d in sorted(assets.iterdir()):
            if d.is_dir():
                parts = sorted((f for f in d.rglob("*") if f.is_file()), key=lambda f: -f.stat().st_size)
                label = (parts[0].name + (f" + {len(parts) - 1} more" if len(parts) > 1 else "")) if parts else d.name
                add("asset", d.name, label, d, sum(f.stat().st_size for f in parts), d.name)

    if root.is_dir():
        recorded = {(config.PROJECTS_DIR / o["path"]).resolve() for g in db.all_generations() for o in g["outputs"] or [] if o.get("path")}
        for p in sorted(root.rglob("*")):
            rel = p.relative_to(root)
            if ".deck" not in rel.parts and p.is_file() and p.resolve() not in recorded:
                add("file", rel.as_posix(), rel.as_posix(), p, p.stat().st_size, p.name)
    return {"items": items, "count": len(items), "bytes": sum(i["bytes"] for i in items)}


def drop_unused(project_id, ids) -> dict:
    """Delete the picked items of project_unused, every copy. The list is made again first, so what something started using
    since it was shown stays. Returns what went, with the picture names for the galleries."""
    want = set(ids)
    root = config.PROJECTS_DIR / db.project_folder(project_id)
    freed, gone, pictures = 0, 0, []
    for it in project_unused(project_id)["items"]:
        if it["id"] not in want:
            continue
        key = it["id"].split(":", 1)[1]
        if it["kind"] == "input":
            freed += delete_input(key)
            pictures.append(key)
        else:
            p = (root / ".deck" / "assets" / key) if it["kind"] == "asset" else root / key
            if not _inside(p, root):
                continue
            drop_caches(*[f.resolve() for f in ([q for q in p.rglob("*") if q.is_file()] if p.is_dir() else [p])])
            freed += remove([p])
            if it["kind"] == "file":
                for d in p.parents:   # folders it leaves empty
                    if d == root or not _inside(d, root) or any(d.iterdir()):
                        break
                    d.rmdir()
        gone += 1
    log.info("project clean-up: %d items, %.1f MB freed", gone, freed / 1e6)
    return {"count": gone, "freed": freed, "pictures": pictures}
