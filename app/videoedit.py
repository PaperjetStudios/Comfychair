"""Render the Video tab's timeline with ffmpeg: stacked video tracks, mixed audio tracks."""
import json
import subprocess
from pathlib import Path


def probe(path: Path) -> dict:
    """{"width", "height", "duration", "fps", "video", "audio"} for a video, image or audio file."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", str(path)],
        check=True, capture_output=True, timeout=30)
    info = json.loads(r.stdout)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    fps = 24.0
    if v:
        num, _, den = (v.get("avg_frame_rate") or "24/1").partition("/")
        try:
            fps = float(num) / float(den or 1) or 24.0
        except (ValueError, ZeroDivisionError):
            fps = 24.0
    return {
        "width": int(v["width"]) if v else 0, "height": int(v["height"]) if v else 0,
        "duration": float(info["format"].get("duration") or (v or {}).get("duration") or 0),
        "fps": fps, "video": bool(v),
        "audio": any(s["codec_type"] == "audio" for s in info["streams"]),
    }


def _overlaps(items: list[dict]):
    """Clips overlapping an earlier clip on the same track cross-fade: the later one fades in over
    the overlap (and, for sound, the earlier one fades out). Sets "xin"/"xout" on each item."""
    for it in items:
        it["xin"] = it["xout"] = 0.0
    by_track: dict = {}
    for it in items:
        by_track.setdefault(it["track"], []).append(it)
    for lst in by_track.values():
        lst.sort(key=lambda i: i["at"])
        for a, b in zip(lst, lst[1:]):
            ov = min(a["at"] + a["len"] - b["at"], b["len"], a["len"])
            if ov > 0.01:
                b["xin"], a["xout"] = ov, ov


def _place(it: dict, W: int, H: int) -> tuple[list[str], str, str]:
    """(extra filters, overlay x, overlay y) for one visual clip. Mirrors the preview's drawing: the
    clip's anchor point (0..1 of the clip, default the centre) sits at the frame centre + (x*W, y*H),
    and the clip rotates (degrees, clockwise) and scales around it. A clip without rotation or
    anchor gets exactly the filters it always had."""
    rot = float(it.get("rotation") or 0) % 360
    ax = 0.5 if it.get("anchor_x") is None else float(it["anchor_x"])
    ay = 0.5 if it.get("anchor_y") is None else float(it["anchor_y"])
    px, py = float(it.get("x") or 0) * W, float(it.get("y") or 0) * H
    if rot < 0.005 or rot > 359.995:
        if abs(ax - 0.5) < 1e-6 and abs(ay - 0.5) < 1e-6:
            return [], f"(W-w)/2+{px:.1f}", f"(H-h)/2+{py:.1f}"
        return [], f"W/2+{px:.1f}-{ax:.5f}*w", f"H/2+{py:.1f}-{ay:.5f}*h"
    # pad so the anchor is the centre of the picture, then rotate about the centre (transparent
    # corners), then put that centre on the anchor's spot
    hx, hy = f"ceil(max({ax:.5f}\\,1-{ax:.5f})*iw)", f"ceil(max({ay:.5f}\\,1-{ay:.5f})*ih)"   # \, : a comma inside an option, not a new filter
    side = "2*ceil(hypot(iw\\,ih)/2)"
    chain = [f"pad=w=2*{hx}:h=2*{hy}:x={hx}-round({ax:.5f}*iw):y={hy}-round({ay:.5f}*ih):color=black@0",
             f"rotate=a={rot:.4f}*PI/180:ow={side}:oh={side}:c=none"]
    return chain, f"W/2+{px:.1f}-w/2", f"H/2+{py:.1f}-h/2"


def render(items: list[dict], out: Path, width: int | None = None, height: int | None = None,
           fps: float | None = None):
    """items: [{"path", "kind": video|image|audio, "track", "z" (video tracks: 0 = bottom),
    "hidden", "muted", "at", "in", "out", "x", "y", "scale", "fit", "rotation" (degrees, clockwise), "anchor_x", "anchor_y" (0..1 of the
    clip, default 0.5), "opacity", "volume", "fade_in", "fade_out"}] with times in seconds. Frame size and rate default to the first visual
    clip's; gaps are black, clip audio and audio-track clips are mixed."""
    items = [dict(it) for it in items]
    for it in items:
        it["info"] = probe(Path(it["path"]))
        dur = it["info"]["duration"] if it["kind"] != "image" else 0
        it["in"] = max(0.0, float(it.get("in") or 0))
        end = float(it.get("out") or dur or 3)
        if dur:
            end = min(end, dur)
        it["len"] = end - it["in"]
        it["at"] = max(0.0, float(it.get("at") or 0))
        if it["len"] < 0.04:
            raise ValueError(f"A clip on the timeline is empty ({Path(it['path']).name})")
    if not items:
        raise ValueError("The timeline is empty")
    _overlaps(items)

    visual = sorted((i for i in items if i["kind"] in ("video", "image")), key=lambda i: (i["z"], i["at"]))
    first = min(visual, key=lambda i: (i["at"], i["z"]), default=None)
    W = int(width or (first["info"]["width"] if first else 0) or 1280)
    H = int(height or (first["info"]["height"] if first else 0) or 720)
    W, H = W - W % 2, H - H % 2  # yuv420p needs even sizes
    fps = float(fps or next((i["info"]["fps"] for i in visual if i["kind"] == "video"), 0) or 24)
    total = max(i["at"] + i["len"] for i in items)

    args = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i",
            f"color=c=black:s={W}x{H}:r={fps:g}:d={total:.3f}"]
    filters, n = ["[0:v]format=yuv420p[b0]"], 0
    inputs: dict[int, int] = {}  # item id -> ffmpeg input index
    for it in items:
        if it["kind"] == "image":
            if it.get("hidden"):
                continue
            args += ["-loop", "1", "-framerate", f"{fps:g}", "-t", f"{it['len']:.3f}", "-i", it["path"]]
        else:
            args += ["-ss", f"{it['in']:.3f}", "-t", f"{it['len']:.3f}", "-i", it["path"]]
        inputs[id(it)] = len(inputs) + 1

    for it in visual:
        if it.get("hidden") or it["kind"] == "video" and not it["info"]["video"]:
            continue
        j = inputs[id(it)]
        scale = max(0.01, float(it.get("scale") or 1))
        mode = "increase" if it.get("fit") == "fill" else "decrease"
        chain = [f"fps={fps:g}", "setpts=PTS-STARTPTS",
                 f"scale=w={round(W * scale)}:h={round(H * scale)}:force_original_aspect_ratio={mode}:force_divisible_by=2",
                 "setsar=1", "format=yuva420p"]
        fi = max(float(it.get("fade_in") or 0), it["xin"])
        fo = float(it.get("fade_out") or 0)
        if fi > 0:
            chain.append(f"fade=t=in:st=0:d={min(fi, it['len']):.3f}:alpha=1")
        if fo > 0:
            chain.append(f"fade=t=out:st={max(0.0, it['len'] - fo):.3f}:d={min(fo, it['len']):.3f}:alpha=1")
        opacity = float(it.get("opacity", 1))
        if opacity < 0.999:
            chain.append(f"colorchannelmixer=aa={max(0.0, opacity):.3f}")
        extra, x, y = _place(it, W, H)
        chain += extra
        chain.append(f"setpts=PTS+{it['at']:.3f}/TB")
        filters.append(f"[{j}:v]{','.join(chain)}[o{n}]")
        filters.append(f"[b{n}][o{n}]overlay=x={x}:y={y}:eof_action=pass:format=auto[b{n + 1}]")
        n += 1
    filters.append(f"[b{n}]format=yuv420p[v]")

    mix = [f"anullsrc=r=48000:cl=stereo,atrim=0:{total:.3f}[sil]"]
    labels = ["[sil]"]
    for it in items:
        if it["kind"] == "image" or it.get("muted") or not it["info"]["audio"]:
            continue
        vol = float(it.get("volume", 1))
        if vol <= 0:
            continue
        chain = ["asetpts=PTS-STARTPTS", "aresample=48000", "aformat=channel_layouts=stereo", f"volume={vol:.3f}"]
        fi = max(float(it.get("fade_in") or 0), it["xin"])
        fo = max(float(it.get("fade_out") or 0), it["xout"])
        if fi > 0:
            chain.append(f"afade=t=in:st=0:d={min(fi, it['len']):.3f}")
        if fo > 0:
            chain.append(f"afade=t=out:st={max(0.0, it['len'] - fo):.3f}:d={min(fo, it['len']):.3f}")
        ms = round(it["at"] * 1000)
        chain.append(f"adelay={ms}|{ms}")
        k = len(labels)
        mix.append(f"[{inputs[id(it)]}:a]{','.join(chain)}[a{k}]")
        labels.append(f"[a{k}]")
    mix.append(f"{''.join(labels)}amix=inputs={len(labels)}:duration=first:normalize=0[a]")

    args += ["-filter_complex", ";".join(filters + mix), "-map", "[v]", "-map", "[a]", "-t", f"{total:.3f}",
             "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    r = subprocess.run(args, capture_output=True, timeout=3600)
    if r.returncode:
        raise RuntimeError(r.stderr.decode(errors="replace").strip().splitlines()[-1] if r.stderr else "ffmpeg failed")
    return probe(out)
