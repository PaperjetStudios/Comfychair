"""Render the Video tab's timeline with ffmpeg: stacked video tracks, mixed audio tracks."""
import json
import subprocess
from pathlib import Path


def probe(path: Path) -> dict:
    """{"width", "height", "duration", "fps", "video", "audio", "alpha"} for a video, image or audio file.
    "alpha" is a VP9/VP8 webm carrying an alpha channel (what key() writes)."""
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
        "alpha": bool(v) and v.get("codec_name") in ("vp9", "vp8")
                 and str((v.get("tags") or {}).get("alpha_mode") or (v.get("tags") or {}).get("ALPHA_MODE")) == "1",
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


def mix_filters(items: list[dict], inputs: dict, total: float) -> list[str]:
    """filter_complex parts that mix every unmuted clip with sound into [a] (48 kHz stereo, total seconds).
    items carry "info" (probe), "at", "len", "xin"/"xout" (_overlaps), "volume", "fade_in", "fade_out",
    "pan" (-1 left .. 1 right) and "muted"; inputs maps id(item) to its ffmpeg input index."""
    mix = [f"anullsrc=r=48000:cl=stereo,atrim=0:{total:.3f}[sil]"]
    labels = ["[sil]"]
    for it in items:
        if it["kind"] == "image" or it.get("muted") or not it["info"]["audio"]:
            continue
        vol = float(it.get("volume", 1) if it.get("volume") is not None else 1)
        if vol <= 0:
            continue
        chain = ["asetpts=PTS-STARTPTS", "aresample=48000", "aformat=channel_layouts=stereo", f"volume={vol:.3f}"]
        pan = max(-1.0, min(1.0, float(it.get("pan") or 0)))
        if abs(pan) > 0.005:   # balance: turn the far side down
            chain.append(f"pan=stereo|c0={min(1.0, 1 - pan):.3f}*c0|c1={min(1.0, 1 + pan):.3f}*c1")
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
    return mix


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
            # ffmpeg's native VP9 decoder drops the alpha plane; libvpx keeps it
            dec = ["-c:v", "libvpx-vp9"] if it["info"].get("alpha") else []
            args += dec + ["-ss", f"{it['in']:.3f}", "-t", f"{it['len']:.3f}", "-i", it["path"]]
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

    mix = mix_filters(items, inputs, total)

    args += ["-filter_complex", ";".join(filters + mix), "-map", "[v]", "-map", "[a]", "-t", f"{total:.3f}",
             "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    r = subprocess.run(args, capture_output=True, timeout=3600)
    if r.returncode:
        raise RuntimeError(r.stderr.decode(errors="replace").strip().splitlines()[-1] if r.stderr else "ffmpeg failed")
    return probe(out)


def _hex(color: str) -> str:
    c = str(color or "#00ff00").lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    if len(c) != 6 or any(ch not in "0123456789abcdefABCDEF" for ch in c):
        raise ValueError(f"Not a colour: {color}")
    return c.lower()


COMBINE = {"union": "lighten", "intersect": "darken", "subtract": "subtract", "average": "average"}


def _morph(filt: str, px: int) -> list[str]:
    """dilation / erosion grow or shrink by 1 px a pass (3x3): px passes."""
    return [filt] * max(0, int(px))


def matte_filters(combine: str | None = "union", grow: float = 0, close: float = 0, smooth: int = 0, feather: float = 0,
                  low: float = 0, high: float = 1, invert: bool = False, alpha: tuple[bool, bool] = (False, False)) -> str:
    """The -filter_complex for refine_matte(). Input 0 is matte A; input 1, when combine is set, matte B (scaled to
    A). White = keep. In order: combine (union = either, intersect = both, subtract = A without B, average),
    close (fill holes and gaps up to close px: grow then shrink), grow (+ dilate / - erode, px), smooth (average
    over that many frames, for jitter), levels (low..high stretched to black..white: a hard or a soft edge),
    feather (blur, px), invert."""
    def gray(i, a):
        return f"[{i}:v]{'format=yuva420p,alphaextract' if a else 'format=gray'},format=gray"
    parts = [gray(0, alpha[0]) + "[a]"]
    cur = "[a]"
    if combine:
        if combine not in COMBINE:
            raise ValueError(f"Combine is one of {', '.join(COMBINE)}")
        parts.append(gray(1, alpha[1]) + "[b0]")
        parts.append("[b0][a]scale2ref=flags=bilinear[b][a2]")
        parts.append(f"[a2][b]blend=all_mode={COMBINE[combine]}:shortest=1[c]")
        cur = "[c]"
    chain = []
    c = round(max(0.0, float(close or 0)))
    chain += _morph("dilation", c) + _morph("erosion", c)
    g = round(float(grow or 0))
    chain += _morph("dilation", g) if g > 0 else _morph("erosion", -g)
    if int(smooth or 0) > 1:
        chain.append(f"tmix=frames={min(15, int(smooth))}")
    lo, hi = max(0.0, min(1.0, float(low or 0))), max(0.0, min(1.0, float(1 if high is None else high)))
    if hi - lo < 0.999:
        hi = max(hi, lo + 0.004)
        chain.append(f"lutyuv=y='clip((val-{lo * 255:.1f})*255/{(hi - lo) * 255:.2f},0,255)'")
    if float(feather or 0) > 0:
        chain.append(f"gblur=sigma={float(feather) / 2:.2f}")
    if invert:
        chain.append("negate")
    chain.append("format=yuv420p")
    parts.append(f"{cur}{','.join(chain)}[v]")
    return ";".join(parts)


def refine_matte(a: Path, out: Path, b: Path | None = None, **opts) -> dict:
    """A cleaned or combined matte (see matte_filters) as an H.264 clip at matte A's size and rate."""
    ia = probe(a)
    ib = probe(b) if b else None
    args = ["ffmpeg", "-v", "error", "-y"]
    for p, i in ((a, ia), (b, ib)):
        if p:
            args += (["-c:v", "libvpx-vp9"] if i.get("alpha") else []) + ["-i", str(p)]
    fc = matte_filters(combine=opts.pop("combine", "union") if b else None,
                       alpha=(bool(ia.get("alpha")), bool(ib and ib.get("alpha"))), **opts)
    args += ["-filter_complex", fc, "-map", "[v]", "-an", "-c:v", "libx264", "-crf", "16", "-preset", "medium",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]
    r = subprocess.run(args, capture_output=True, timeout=3600)
    if r.returncode:
        raise RuntimeError(r.stderr.decode(errors="replace").strip().splitlines()[-1] if r.stderr else "ffmpeg failed")
    return probe(out)


def key_filters(mode: str, color: str = "#00ff00", similarity: float = 0.12, blend: float = 0.08,
                spill: float = 0.5, invert: bool = False) -> str:
    """The -filter_complex for key(). Input 0 is the clip; for mode "matte" input 1 is a matte video
    (white = keep). mode "color" keys out one colour (chromakey) and pulls its spill (despill)."""
    if mode == "matte":
        neg = ",negate" if invert else ""
        return ("[1:v]format=gray" + neg + "[m];[m][0:v]scale2ref[m2][c];"
                "[c]format=yuva420p[c2];[c2][m2]alphamerge,format=yuva420p[v]")
    if mode != "color":
        raise ValueError(f"Unknown key mode {mode}")
    c = _hex(color)
    sim = min(1.0, max(0.01, float(similarity)))
    bl = min(1.0, max(0.0, float(blend)))
    chain = [f"chromakey=color=0x{c}:similarity={sim:.3f}:blend={bl:.3f}"]
    r, g, b = (int(c[i:i + 2], 16) for i in (0, 2, 4))
    sp = min(1.0, max(0.0, float(spill)))
    if sp > 0 and max(g, b) > r:  # after the key (despill greys the screen colour); only green and blue
        chain += ["format=gbrap", f"despill=type={'green' if g >= b else 'blue'}:mix={sp:.3f}:expand=0"]
    if invert:
        chain.append("format=yuva420p,lutyuv=a=255-val")
    return f"[0:v]{','.join(chain)},format=yuva420p[v]"


def key(src: Path, out: Path, mode: str, matte: Path | None = None, trim: dict | None = None, **opts) -> dict:
    """A copy of src with an alpha channel, as a VP9 webm (yuva420p, which Chromium plays and
    render() composites). mode "matte": alpha from the matte video's brightness; "color": chroma key.
    Sound is kept."""
    if mode == "matte" and not matte:
        raise ValueError("Pick a matte clip")
    info = probe(src)
    cut = []   # trim {start, len} (seconds) applies to the clip only: a matte made from the trimmed clip starts at 0
    if trim:
        cut = ["-ss", f"{max(0.0, float(trim.get('start') or 0)):.3f}"] + (["-t", f"{float(trim['len']):.3f}"] if trim.get("len") else [])
    args = ["ffmpeg", "-v", "error", "-y", *cut, "-i", str(src)]
    if mode == "matte":
        args += ["-i", str(matte)]
    args += ["-filter_complex", key_filters(mode, **opts), "-map", "[v]"]
    if info["audio"]:
        args += ["-map", "0:a:0", "-c:a", "libopus", "-b:a", "160k"]
    args += ["-shortest", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "28",
             "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", "-auto-alt-ref", "0", str(out)]
    r = subprocess.run(args, capture_output=True, timeout=3600)
    if r.returncode:
        raise RuntimeError(r.stderr.decode(errors="replace").strip().splitlines()[-1] if r.stderr else "ffmpeg failed")
    return probe(out)
