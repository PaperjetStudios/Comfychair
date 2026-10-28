"""Sound with ffmpeg: pull the sound out of a clip, mix the Sound tab's tracks into one file, lay a
sound onto a video, and ready a picked sound for a template's audio loader (VHS_LoadAudio)."""
import hashlib
import json
import os
import subprocess
from pathlib import Path

from . import config, videoedit
from .videoprep import norm_trim

PREFIX = "aprep_"
LOADABLE = {".wav", ".mp3", ".ogg", ".m4a", ".flac"}   # what VHS_LoadAudio opens
# output formats: extension -> ffmpeg audio codec args
FORMATS = {
    "m4a": ["-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart"],
    "wav": ["-c:a", "pcm_s16le"],
    "mp3": ["-c:a", "libmp3lame", "-q:a", "2"],
    "flac": ["-c:a", "flac"],
}


def _run(args: list[str], timeout=3600):
    videoedit.check(subprocess.run(args, capture_output=True, timeout=timeout))


def _cut(trim, duration: float) -> list[str]:
    """-ss/-t for a trim {start, len} (seconds), clamped to the clip."""
    t = norm_trim(trim, duration)
    if not t:
        return []
    start, length = t
    return ["-ss", f"{start:.3f}"] + (["-t", f"{length:.3f}"] if length is not None else [])


def extract(src: Path, out: Path, trim=None, info: dict | None = None) -> dict:
    """The sound of a clip (or a cut of a sound file) on its own, in out's format (.m4a, .wav, .mp3, .flac)."""
    info = info or videoedit.probe(src)
    if not info["audio"]:
        raise ValueError("that clip has no sound")
    fmt = FORMATS.get(out.suffix.lower().lstrip("."))
    if not fmt:
        raise ValueError(f"can't write {out.suffix} sound")
    _run(["ffmpeg", "-v", "error", "-y", "-i", str(src), *_cut(trim, info["duration"]), "-vn", "-map", "0:a:0",
          "-ac", "2", "-ar", "48000", *fmt, str(out)])
    return videoedit.probe(out)


def prep(src: Path, trim=None) -> Path:
    """A file VHS_LoadAudio can open for this source + trim: the file itself when it is already a sound file
    and uncut, else a cached FLAC copy in data/tmp/videoprep, named after source+trim."""
    info = videoedit.probe(src)
    if not info["audio"]:
        raise ValueError("that clip has no sound")
    t = norm_trim(trim, info["duration"])
    if not t and not info["video"] and src.suffix.lower() in LOADABLE:
        return src
    st = src.stat()
    key = hashlib.sha1(json.dumps([str(src.resolve()), st.st_size, st.st_mtime_ns, t]).encode()).hexdigest()[:16]
    out = config.VIDEOPREP_DIR / f"{PREFIX}{key}.flac"
    if out.is_file() and out.stat().st_size > 0:
        os.utime(out)   # in use: keeps it out of prune()
        return out
    tmp = out.with_name(out.stem + ".part.flac")
    try:
        extract(src, tmp, trim, info)
        tmp.replace(out)
    finally:
        tmp.unlink(missing_ok=True)
    return out


def render(items: list[dict], out: Path, gain: float = 1.0, normalize: bool = False) -> dict:
    """Mix the Sound tab's timeline into out (.m4a/.wav/.mp3/.flac). items: [{"path", "kind" (audio|video),
    "track", "muted", "at", "in", "out", "volume", "pan", "fade_in", "fade_out"}], times in seconds.
    gain: the master level; normalize: loudness to -16 LUFS (EBU R128), like a podcast/streaming master."""
    items = videoedit.timeline_items([it for it in items if it.get("kind") in ("audio", "video")], 0.02, still_len=0)
    items = [it for it in items if it["info"]["audio"]]
    if not items:
        raise ValueError("Nothing on the timeline has sound")
    fmt = FORMATS.get(out.suffix.lower().lstrip("."))
    if not fmt:
        raise ValueError(f"can't write {out.suffix} sound")
    videoedit._overlaps(items)
    total = max(i["at"] + i["len"] for i in items)
    args = ["ffmpeg", "-v", "error", "-y"]
    inputs = {}
    for it in items:
        args += ["-ss", f"{it['in']:.3f}", "-t", f"{it['len']:.3f}", "-i", it["path"]]
        inputs[id(it)] = len(inputs)
    mix = videoedit.mix_filters(items, inputs, total)
    master = [f"volume={max(0.0, float(gain)):.3f}"]
    if normalize:
        master.append("loudnorm=I=-16:TP=-1.5:LRA=11")
    mix.append(f"[a]{','.join(master)},aresample=48000[m]")
    _run(args + ["-filter_complex", ";".join(mix), "-map", "[m]", "-t", f"{total:.3f}", "-ar", "48000", *fmt, str(out)])
    return videoedit.probe(out)


def lay(video: Path, sound: Path, out: Path, mode: str = "replace", at: float = 0.0, volume: float = 1.0,
        keep: float = 1.0, sound_trim=None) -> dict:
    """A copy of video (.mp4) with sound on it: mode "replace" drops the clip's own sound, "mix" keeps it
    (at level keep) under the new one. at: where the sound starts in the clip (seconds); it is cut at the
    clip's end. The picture is copied, not re-encoded."""
    vi, si = videoedit.probe(video), videoedit.probe(sound)
    if not vi["video"]:
        raise ValueError("that isn't a video")
    if not si["audio"]:
        raise ValueError("that sound file has no sound")
    ms = round(max(0.0, float(at)) * 1000)
    chain = [f"[1:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume={max(0.0, float(volume)):.3f},"
             f"adelay={ms}|{ms}[s]"]
    if mode == "mix" and vi["audio"]:
        chain.append(f"[0:a]aresample=48000,aformat=channel_layouts=stereo,volume={max(0.0, float(keep)):.3f}[o]")
        chain.append("[o][s]amix=inputs=2:duration=first:normalize=0[a]")
    else:
        chain.append(f"anullsrc=r=48000:cl=stereo,atrim=0:{vi['duration']:.3f}[z];[z][s]amix=inputs=2:duration=first:normalize=0[a]")
    _run(["ffmpeg", "-v", "error", "-y", "-i", str(video), *_cut(sound_trim, si["duration"]), "-i", str(sound),
          "-filter_complex", ";".join(chain), "-map", "0:v:0", "-map", "[a]", "-t", f"{vi['duration']:.3f}",
          "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)])
    return videoedit.probe(out)


def prune(max_age_days=30):
    """Readied copies are remade on demand: clear the ones unused for a month."""
    import time
    cutoff = time.time() - max_age_days * 86400
    for p in config.VIDEOPREP_DIR.glob(f"{PREFIX}*"):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
        except OSError:
            pass
