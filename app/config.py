"""Runtime configuration. Everything can be overridden with environment variables."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# Where ComfyUI is running. ComfyChair proxies everything, so ComfyUI itself can stay on
# 127.0.0.1 (no --listen needed) while the tablet only talks to ComfyChair.
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")

# Live previews while sampling: taesd | latent2rgb | auto | none (video runs add VHS animation)
PREVIEW_METHOD = os.environ.get("DECK_PREVIEW", "taesd")
VIDEO_PREVIEW_METHOD = os.environ.get("DECK_VIDEO_PREVIEW", "latent2rgb")

DATA_DIR = Path(os.environ.get("DECK_DATA", BASE_DIR / "data")).resolve()
TEMPLATES_DIR = Path(os.environ.get("DECK_TEMPLATES", BASE_DIR / "templates")).resolve()
WEB_DIR = BASE_DIR / "web"

GEN_DIR = DATA_DIR / "generations"   # old layout (one folder per generation), migrated into PROJECTS_DIR
PROJECTS_DIR = DATA_DIR / "projects"  # saved outputs: projects/<project name>/<generation id>_<file>
LIBRARY_DIR = DATA_DIR / "library"   # global (all projects) documents: library/<kind>/<id>.json, see store.py
INPUT_DIR = DATA_DIR / "inputs"      # local copies of every image sent to ComfyUI
THUMB_DIR = DATA_DIR / "thumbs"      # cached JPEG thumbnails for the input gallery
MEDIA_DIR = DATA_DIR / "media"       # music, voice-overs and outside clips uploaded for the Video tab
VIDEOPREP_DIR = DATA_DIR / "tmp" / "videoprep"  # trimmed/cropped copies of video inputs (see videoprep.py)
SCENE_CLIP_DIR = DATA_DIR / "tmp" / "sceneclips"  # 3D compositions rendered for a video export (temporary, see main.py)

# Optional access token. When set, every page, file and API call needs it: open
# http://<box>:8190/?token=<token> once on each device and a cookie remembers it.
TOKEN = os.environ.get("DECK_TOKEN", "")

# Subfolder inside ComfyUI's input/ directory that ComfyChair uploads into.
COMFY_INPUT_SUBFOLDER = os.environ.get("DECK_COMFY_SUBFOLDER", "comfydeck")

# ComfyUI's own folder, when it's on this machine (default: a ComfyUI folder next to ComfyChair's).
# Only used for housekeeping: deleting a generation also deletes ComfyUI's copy of its outputs, and
# old one-off crop files are cleared from its input folder. Set DECK_COMFY_DIR="" to turn that off.
_comfy_dir = os.environ.get("DECK_COMFY_DIR", str(BASE_DIR.parent / "ComfyUI"))
COMFY_DIR = Path(_comfy_dir).resolve() if _comfy_dir and Path(_comfy_dir).is_dir() else None
COMFY_OUTPUT_DIR = COMFY_DIR / "output" if COMFY_DIR and (COMFY_DIR / "output").is_dir() else None
COMFY_INPUT_DIR = COMFY_DIR / "input" if COMFY_DIR and (COMFY_DIR / "input").is_dir() else None

for d in (DATA_DIR, TEMPLATES_DIR, GEN_DIR, PROJECTS_DIR, LIBRARY_DIR, INPUT_DIR, THUMB_DIR, MEDIA_DIR, SCENE_CLIP_DIR, VIDEOPREP_DIR):
    d.mkdir(parents=True, exist_ok=True)
