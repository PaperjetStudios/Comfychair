"""Image preparation: crop, megapixel cap, dimension snapping, frame extraction."""
import io
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageOps

# What a file is, by its extension: the one table the server goes by (outputs, the media library). The UI's
# web/kinds.js says how each kind is shown and where it can go. A .json is a motion when the motion nodes
# saved it (DeckSaveMotion / DeckSaveBodyMotion); fill_facts in main.py checks its content.
KINDS = {
    "video": {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"},
    "audio": {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".opus", ".aac"},
    "image": {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"},
    "motion": {".npz", ".bvh"},
    "mesh": {".glb", ".gltf", ".obj", ".fbx"},
    "splat": {".ply", ".splat", ".ksplat", ".spz"},
}
VIDEO_EXT, AUDIO_EXT, IMAGE_EXT = KINDS["video"], KINDS["audio"], KINDS["image"]


def kind_of(filename: str, node_class: str = "") -> str:
    ext = Path(filename).suffix.lower()
    for kind, exts in KINDS.items():
        if ext in exts:
            return kind
    if ext == ".json" and "motion" in node_class.lower():
        return "motion"
    return "file"


def prep(data: bytes, max_mp: float = 0, multiple: int = 8, crop: dict | None = None):
    """Return (png_bytes, width, height).

    crop: {"x","y","w","h"} as fractions 0..1 of the (EXIF-corrected) image.
    max_mp: downscale so width*height <= max_mp megapixels (0 = keep size). Never upscales.
    multiple: snap both sides down to a multiple of this (most models want 8, 16 or 32).
    """
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if "A" in im.getbands() else "RGB")

    if crop:
        W, H = im.size
        x = max(0.0, min(1.0, float(crop.get("x", 0))))
        y = max(0.0, min(1.0, float(crop.get("y", 0))))
        w = max(0.0, min(1.0 - x, float(crop.get("w", 1))))
        h = max(0.0, min(1.0 - y, float(crop.get("h", 1))))
        box = (round(x * W), round(y * H), round((x + w) * W), round((y + h) * H))
        if box[2] - box[0] >= 8 and box[3] - box[1] >= 8:
            im = im.crop(box)

    w, h = im.size
    if max_mp and w * h > max_mp * 1_000_000:
        s = math.sqrt(max_mp * 1_000_000 / (w * h))
        w, h = max(1, int(w * s)), max(1, int(h * s))
        im = im.resize((w, h), Image.LANCZOS)

    if multiple and multiple > 1:  # centre-crop the few leftover pixels instead of stretching
        sw, sh = max(multiple, w // multiple * multiple), max(multiple, h // multiple * multiple)
        if (sw, sh) != (w, h):
            if sw > w or sh > h:
                im = im.resize((max(sw, w), max(sh, h)), Image.LANCZOS)
                w, h = im.size
            left, top = (w - sw) // 2, (h - sh) // 2
            im = im.crop((left, top, left + sw, top + sh))

    out = io.BytesIO()
    im.save(out, "PNG")
    return out.getvalue(), im.size[0], im.size[1]


def thumbnail(data: bytes, width: int) -> bytes:
    """Small JPEG for gallery grids."""
    im = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
    im.thumbnail((width, width * 2), Image.LANCZOS)
    out = io.BytesIO()
    im.convert("RGB").save(out, "JPEG", quality=82)
    return out.getvalue()


def frame_from_image(path: Path, which: str = "last") -> bytes:
    """Still image -> itself. Animated gif/webp -> first or last frame."""
    im = Image.open(path)
    n = getattr(im, "n_frames", 1)
    if n > 1:
        im.seek(n - 1 if which == "last" else 0)
    out = io.BytesIO()
    im.convert("RGBA" if "A" in im.getbands() else "RGB").save(out, "PNG")
    return out.getvalue()


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def frame_from_video(path: Path, which: str = "last") -> bytes:
    if not ffmpeg_available():
        raise RuntimeError("ffmpeg isn't installed (sudo apt install ffmpeg)")
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "frame.png"
        if which == "first":
            cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(path), "-frames:v", "1", str(out)]
        else:  # decode the last second and keep overwriting: the file left is the final frame
            cmd = ["ffmpeg", "-v", "error", "-y", "-sseof", "-1", "-i", str(path), "-update", "1", str(out)]
        subprocess.run(cmd, check=True, capture_output=True, timeout=60)
        if not out.exists():  # very short clips can fail -sseof; fall back to a full decode
            cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(path), "-update", "1", str(out)]
            subprocess.run(cmd, check=True, capture_output=True, timeout=120)
        return out.read_bytes()
