"""Uploaded clips the browser can't play (iPhone and camera .mov: HEVC, ProRes, DNxHD, MJPEG, PCM sound) get an
H.264 + AAC copy for the player. The original stays as it is: ffmpeg, tracking and the Video tab render read it.
The copy is a cache file named <storage.tag(media name)>-play.mp4, so storage.drop_caches(name) removes it."""
import logging
import subprocess
from pathlib import Path

from . import config, storage, videoedit

log = logging.getLogger("comfydeck.playable")
VIDEO_OK = {"h264", "avc1", "vp8", "vp9", "av1"}
AUDIO_OK = {"aac", "mp3", "opus", "vorbis"}


def browser_plays(info_or_path) -> bool:
    """True when a browser plays the file's video and sound (a probe dict, or a path to probe)."""
    info = info_or_path if isinstance(info_or_path, dict) else videoedit.probe(Path(info_or_path))
    return info.get("vcodec") in VIDEO_OK and (not info.get("audio") or info.get("acodec") in AUDIO_OK)


def path_for(name: str) -> Path:
    return config.PLAYABLE_DIR / f"{storage.tag(name)}-play.mp4"


def playable_copy(src: Path, dest: Path, info: dict | None = None):
    """An H.264 + AAC mp4 of src at dest (the video is copied as it is when only the sound is the problem)."""
    info = info or videoedit.probe(src)
    keep_video = info.get("vcodec") in VIDEO_OK
    venc = ["-c:v", "copy"] if keep_video else [*videoedit.h264(), "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]
    tmp = dest.with_name(dest.stem + ".part.mp4")
    args = ["ffmpeg", "-v", "error", "-y", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?", *venc,
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(tmp)]
    r = videoedit.run_ffmpeg(args, timeout=3600)
    if r.returncode:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(r.stderr.decode(errors="replace")[-300:] or "ffmpeg failed")
    tmp.replace(dest)


def ensure(path: Path) -> Path | None:
    """Make the playable copy of an uploaded video when the browser can't play it. None when it can, or when it fails
    (the original is still served then)."""
    try:
        info = videoedit.probe(path)
        if not info["video"] or browser_plays(info):
            return None
        dest = path_for(path.name)
        playable_copy(path, dest, info)
        return dest
    except (subprocess.SubprocessError, OSError, ValueError, KeyError, RuntimeError) as e:
        log.warning("no playable copy of %s: %s", path.name, e)
        return None
