"""deck-ltx-continue / deck-h3-continue: a new clip that carries on from the previous clip's last frames.

The tail of the previous clip loads through "@1 Clip to continue" (its trim maps onto the loader's own
skip_first_frames / frame_load_cap), is anchored at frame 0 as a multi-frame guide, and Length counts the new footage
after it. An end image is optional."""
import math
import os
import tempfile
from pathlib import Path

os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
os.environ.setdefault("DECK_COMFY_DIR", "")

TEMPLATES = Path(__file__).resolve().parent.parent / "templates"
LORA = [{"name": "style.safetensors", "strength": 1.0, "enabled": True}]


def load(tid):
    from app import templates as tpl
    t = tpl.get(TEMPLATES, tid)
    assert t and not t.error, t.error if t else "missing"
    return tpl, t


def fields(tpl, t):
    return {f["key"]: f for f in tpl.describe(t, None)["fields"]}


def assert_links(tpl, wf):
    for nid, node in wf.items():
        for name, v in node["inputs"].items():
            if tpl._is_link(v):
                assert v[0] in wf, f"{nid}.{name} points at missing node {v[0]}"


def feeds(wf, nid, target):
    """Whether node nid is fed (through any chain of links) by node target."""
    seen, todo = set(), [nid]
    while todo:
        n = todo.pop()
        if n == target:
            return True
        if n in seen or n not in wf:
            continue
        seen.add(n)
        todo += [v[0] for v in wf[n]["inputs"].values() if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str)]
    return False


def calc(node, **vals):
    """A ComfyMathExpression node's own expression, evaluated the way simpleeval does (plain Python)."""
    names = {"floor": math.floor, "ceil": math.ceil, "min": min, "max": max, "round": round, "__builtins__": {}}
    return eval(node["inputs"]["expression"], names, vals)


def h3_guide_frames(n):
    """MiniMaxH3AddGuide's own snap of an n-frame guide batch (comfy_extras/nodes_minimax_h3.py)."""
    if n < 5:
        return 1
    while n % 17 != 5:
        n -= 1
    return n


def check_loader(wf, fs):
    from app import videoprep
    src = wf["src"]
    assert src["class_type"] == "VHS_LoadVideoPath"
    assert src["_meta"]["title"] == "@1 Clip to continue [video]"
    assert src["inputs"]["force_rate"] == 24
    assert fs["src.video"]["kind"] == "video" and fs["src.video"]["group"] == "Clip to continue"
    info = {"width": 768, "height": 448, "duration": 5.0, "fps": 24.0, "video": True, "audio": True}
    tail = videoprep.norm_trim({"start": (120 - 22) / 24, "len": 22 / 24}, 5.0)
    assert videoprep.loader_trim(info, tail, src["inputs"]) == {"skip_first_frames": 98, "frame_load_cap": 22}


# ---------------------------------------------------------------------------- LTX
def test_ltx_fields():
    tpl, t = load("deck-ltx-continue")
    fs = fields(tpl, t)
    check_loader(t.workflow, fs)
    assert fs["prompt.value"]["kind"] == "text" and fs["prompt.value"]["group"] == "Prompt"
    assert fs["secs.value"]["kind"] == "float" and fs["secs.value"]["label"] == "Length (seconds)"
    assert fs["short.value"]["group"] == "Resolution (short side)"
    assert fs["last.image"]["kind"] == "image" and fs["last.image"]["group"] == "End image"
    assert fs["noise.noise_seed"]["kind"] == "seed"
    assert fs["loras.__loras"]["kind"] == "loras"
    assert fs["vref.audio_file"]["kind"] == "audio"
    assert not any(f["kind"] == "image" and k != "last.image" for k, f in fs.items()), "no start image"


def test_ltx_guide_is_the_clip_at_frame_0():
    tpl, t = load("deck-ltx-continue")
    wf = t.workflow
    g = wf["guide"]
    assert g["class_type"] == "LTXVAddGuide"
    assert g["inputs"]["frame_idx"] == 0 and g["inputs"]["strength"] == 1.0
    assert g["inputs"]["latent"] == ["vlat", 0]
    assert wf["pre"]["class_type"] == "LTXVPreprocess" and g["inputs"]["image"] == ["pre", 0]
    assert wf["cut"]["inputs"]["image"] == ["src", 0] and wf["cut"]["inputs"]["length"] == ["gn", 1]
    assert feeds(wf, "guide", "src")
    assert wf["size"]["inputs"]["image"] == ["cut", 0], "the output is sized from the guide"
    assert wf["vlat"]["inputs"]["width"] == ["W", 1] and wf["vlat"]["inputs"]["length"] == ["nf", 1]
    assert not any(n["class_type"] in ("LoadImage", "LTXVImgToVideoInplace") and nid != "last" for nid, n in wf.items())
    assert wf["crop"]["class_type"] == "LTXVCropGuides" and wf["vdec"]["inputs"]["latents"] == ["crop", 2]


def test_ltx_without_end_image_drops_cleanly():
    tpl, t = load("deck-ltx-continue")
    wf = tpl.apply(t.workflow, {"src.video": "/x/clip.mp4", "last.image": "", "vref.audio_file": "",
                                "loras.__loras": [], "prompt.value": "she keeps running"})
    for gone in ("last", "lastrs", "lastpre", "endg"):
        assert gone not in wf, gone
    assert_links(tpl, wf)
    assert wf["av"]["inputs"]["video_latent"] == ["guide", 2]
    assert wf["crop"]["inputs"]["positive"] == ["guide", 0] and wf["crop"]["inputs"]["negative"] == ["guide", 1]
    assert wf["guider"]["inputs"]["positive"] == ["guide", 0]
    assert wf["guide"]["inputs"]["frame_idx"] == 0


def test_ltx_with_end_image():
    tpl, t = load("deck-ltx-continue")
    wf = tpl.apply(t.workflow, {"src.video": "/x/clip.mp4", "last.image": "end.png", "vref.audio_file": "",
                                "loras.__loras": LORA})
    assert_links(tpl, wf)
    e = wf["endg"]
    assert e["class_type"] == "LTXVAddGuide" and e["inputs"]["frame_idx"] == -1
    assert e["inputs"]["latent"] == ["guide", 2] and e["inputs"]["positive"] == ["guide", 0]
    assert wf["av"]["inputs"]["video_latent"] == ["endg", 2]
    assert wf["crop"]["inputs"]["positive"] == ["endg", 0]


def test_ltx_length_maths():
    _, t = load("deck-ltx-continue")
    wf = t.workflow
    for n in (1, 9, 17, 22, 24, 25, 33, 48):
        g = calc(wf["gn"], a=n)
        assert g % 8 == 1 and 1 <= g <= n and n - g < 8, (n, g)
        for secs in (0.0, 0.5, 1.0, 2.5, 5.0, 7.3):
            total = calc(wf["nf"], a=secs, b=g)
            assert total % 8 == 1, (n, secs, total)
            assert total >= g, "the guide always fits"
            assert abs((total - g) - secs * 24) < 8, (n, secs, total)
    assert calc(wf["nf"], a=5.0, b=17) == 137        # 1 s of overlap (17) + 120 new frames


# ---------------------------------------------------------------------------- H3
def test_h3_fields():
    tpl, t = load("deck-h3-continue")
    fs = fields(tpl, t)
    check_loader(t.workflow, fs)
    assert fs["prompt.value"]["kind"] == "text" and fs["prompt.value"]["group"] == "Prompt"
    assert fs["secs.value"]["kind"] == "float" and fs["secs.value"]["label"] == "Length (seconds)"
    assert fs["short.value"]["group"] == "Resolution (short side)"
    assert fs["last.image"]["kind"] == "image" and fs["last.image"]["group"] == "End image"
    assert fs["8.noise_seed"]["kind"] == "seed"
    assert fs["6.__loras"]["kind"] == "loras" and fs["30.__loras"]["kind"] == "loras"
    assert not any(k.startswith("7.") for k in fs), "the shot's size and prompt come from elsewhere"


def test_h3_guide_is_the_clip_at_frame_0():
    tpl, t = load("deck-h3-continue")
    wf = t.workflow
    shot = wf["7"]
    assert shot["class_type"] == "MiniMaxH3ImageToVideo" and "first_frame" not in shot["inputs"]
    assert shot["inputs"]["width"] == ["W", 1] and shot["inputs"]["height"] == ["H", 1]
    assert shot["inputs"]["length"] == ["17", 1] and shot["inputs"]["prompt"] == ["prompt", 0]
    g = wf["guide"]
    assert g["class_type"] == "MiniMaxH3AddGuide"
    assert g["inputs"]["frame_idx"] == 0
    assert g["inputs"]["positive"] == ["7", 0] and g["inputs"]["latent"] == ["7", 1]
    assert g["inputs"]["vae"] == ["3", 0] and g["inputs"]["audio_vae"] == ["4", 0]
    assert g["inputs"]["image"] == ["cut", 0] and wf["cut"]["inputs"]["image"] == ["src", 0]
    assert feeds(wf, "guide", "src")
    assert wf["gaud"]["inputs"]["audio"] == ["src", 2], "the clip's sound guides too (main.takes_sound adds a silent track)"
    assert wf["11"]["inputs"]["conditioning"] == ["guide", 0]
    assert wf["12"]["inputs"]["latent_image"] == ["7", 1]
    assert wf["size"]["inputs"]["image"] == ["cut", 0]
    for k in ("W", "H"):
        assert wf[k]["inputs"]["expression"].endswith("/32)*32")


def test_h3_without_end_image_drops_cleanly():
    tpl, t = load("deck-h3-continue")
    wf = tpl.apply(t.workflow, {"src.video": "/x/clip.mp4", "last.image": "", "6.__loras": [], "30.__loras": LORA})
    assert "last" not in wf and "last_frame" not in wf["7"]["inputs"]
    assert "7" in wf and "guide" in wf
    assert_links(tpl, wf)


def test_h3_with_end_image():
    tpl, t = load("deck-h3-continue")
    wf = tpl.apply(t.workflow, {"src.video": "/x/clip.mp4", "last.image": "end.png", "6.__loras": LORA, "30.__loras": []})
    assert wf["7"]["inputs"]["last_frame"] == ["last", 0]
    assert_links(tpl, wf)


def test_h3_length_maths():
    _, t = load("deck-h3-continue")
    wf = t.workflow
    for n in (1, 4, 5, 12, 21, 22, 24, 30, 39, 48):
        g = calc(wf["gn"], a=n)
        assert 1 <= g <= n, (n, g)
        assert g == h3_guide_frames(min(g, n)), "the cut is already on the node's own grid: the overlap is exactly g"
        assert g == h3_guide_frames(n)
        for secs in (0.0, 0.5, 1.0, 2.0, 5.0, 7.5):
            total = calc(wf["17"], a=secs, b=g)
            assert total % 17 == 5, (n, secs, total)
            assert total >= max(5, g), "the guide always fits in the video"
            assert total >= g + round(secs * 24) and total - g - round(secs * 24) < 17, (n, secs, total)
            assert calc(wf["gdur"], a=g) == g / 24
    assert calc(wf["17"], a=5.0, b=22) == 158        # 22 overlap + 120 new = 142, up to the 17k+5 grid
