"""Runtime configuration. Everything can be overridden with environment variables."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

# Where ComfyUI is running. ComfyDeck proxies everything, so ComfyUI itself can stay on
# 127.0.0.1 (no --listen needed) while the tablet only talks to ComfyDeck.
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")

# Live previews while sampling: taesd | latent2rgb | auto | none (video runs add VHS animation)
PREVIEW_METHOD = os.environ.get("DECK_PREVIEW", "taesd")
VIDEO_PREVIEW_METHOD = os.environ.get("DECK_VIDEO_PREVIEW", "latent2rgb")

DATA_DIR = Path(os.environ.get("DECK_DATA", BASE_DIR / "data")).resolve()
TEMPLATES_DIR = Path(os.environ.get("DECK_TEMPLATES", BASE_DIR / "templates")).resolve()
WEB_DIR = BASE_DIR / "web"

GEN_DIR = DATA_DIR / "generations"   # old layout (one folder per generation), migrated into PROJECTS_DIR
PROJECTS_DIR = DATA_DIR / "projects"  # saved outputs: projects/<project name>/<generation id>_<file>
INPUT_DIR = DATA_DIR / "inputs"      # local copies of every image sent to ComfyUI
THUMB_DIR = DATA_DIR / "thumbs"      # cached JPEG thumbnails for the input gallery
MEDIA_DIR = DATA_DIR / "media"       # music, voice-overs and outside clips uploaded for the Video tab

# Subfolder inside ComfyUI's input/ directory that ComfyDeck uploads into.
COMFY_INPUT_SUBFOLDER = os.environ.get("DECK_COMFY_SUBFOLDER", "comfydeck")

for d in (DATA_DIR, TEMPLATES_DIR, GEN_DIR, PROJECTS_DIR, INPUT_DIR, THUMB_DIR, MEDIA_DIR):
    d.mkdir(parents=True, exist_ok=True)
