"""Write the VFX tab's Quick templates: a depth map of a picture or a clip (Video Depth Anything,
ComfyUI-Video-Depth-Anything), and its Canny edges or scribble lines (ComfyUI's Canny; XDoG from comfyui_controlnet_aux). Remove watermark has no template: app/delogo.py builds its workflow.

Run: python3 dev/make_quick_templates.py   (then ↻ templates in ComfyChair)

Shares the graph helpers of make_ltx_templates.py. Field titles follow web/vfx.js ROLES (README "VFX templates").
"""
import json

from make_ltx_templates import FPS, OUT, G, math, node

# Large: the sharpest, steadiest depth (CC-BY-NC weights); Small: about 5x faster
MODELS = ["video_depth_anything_vitl.pth", "video_depth_anything_vits.pth"]
# the size it works at (short side, x14): Large at 518 needs more than a 12 GB card has (32 frames at a time)
SIZES = {MODELS[0]: 448, MODELS[1]: 518}


def depth(g, images, max_res=1280):
    """Video Depth Anything over a batch of frames (one picture counts as a still clip): grey, near is white,
    normalised over the whole clip so it doesn't pump."""
    g.add("vda", node("LoadVideoDepthAnythingModel", "@5 Depth model [model]", model=MODELS[0]))
    g.add("run", node("VideoDepthAnythingProcess", "@6 Depth detail [input_size]", vda_model=["vda", 0], images=images,
                      input_size=SIZES[MODELS[0]], max_res=max_res,
                      precision="fp16"))
    g.add("grey", node("VideoDepthAnythingOutput", depths=["run", 0], colormap="gray"))
    return ["grey", 0]


def depth_video():
    """A clip's depth as a video at 24 fps, for H3 control (deck-h3-ctrl2v) or LTX layout."""
    g = G()
    g.add("src", node("VHS_LoadVideoPath", "@1 Source video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
                      frame_load_cap=0, skip_first_frames=0, select_every_nth=1))
    g.add("secs", node("PrimitiveFloat", "@2 Length (seconds) [value]", value=10.0))
    math(g, "nf", f"max(1, min(a, round(b*{FPS})))", "frames within the clip and Length", a=["src", 1], b=["secs", 0])
    g.add("cut", node("ImageFromBatch", image=["src", 0], batch_index=0, length=["nf", 1]))
    out = depth(g, ["cut", 0])
    g.add("vid", node("CreateVideo", images=out, fps=FPS))
    g.add("save", node("SaveVideo", video=["vid", 0], filename_prefix="deck/depth", format="auto", codec="auto"))
    return g


def depth_image():
    """A picture's depth as a PNG."""
    g = G()
    g.add("img", {**node("LoadImage", image=""), "_meta": {"title": "@1 Picture [image]", "deck_keep_size": True}})
    out = depth(g, ["img", 0], max_res=2048)
    g.add("save", node("SaveImage", images=out, filename_prefix="deck/depth"))
    return g


def canny(g, images):
    """White Canny edges on black (ComfyUI's own node, no model). The low threshold is the effect's Amount, the high one twice it."""
    g.add("amount", node("PrimitiveFloat", "@7 Edge amount [value]", value=0.4))
    math(g, "high", "min(0.99, a*2)", "the high threshold: twice the low one", a=["amount", 0])
    g.add("edges", node("Canny", image=images, low_threshold=["amount", 0], high_threshold=["high", 0]))
    return ["edges", 0]


def scribble(g, images, max_res=1280):
    """Scribble lines (XDoG: no model). The threshold is the effect's Amount; the lines come out at `resolution`."""
    g.add("lines", node("Scribble_XDoG_Preprocessor", "@7 Line amount [threshold]", image=images, threshold=32, resolution=max_res))
    return ["lines", 0]


def clip_of(make, name, **kw):
    def build():
        g = G()
        g.add("src", node("VHS_LoadVideoPath", "@1 Source video [video]", video="", force_rate=FPS, custom_width=0, custom_height=0,
                          frame_load_cap=0, skip_first_frames=0, select_every_nth=1))
        g.add("secs", node("PrimitiveFloat", "@2 Length (seconds) [value]", value=10.0))
        math(g, "nf", f"max(1, min(a, round(b*{FPS})))", "frames within the clip and Length", a=["src", 1], b=["secs", 0])
        g.add("cut", node("ImageFromBatch", image=["src", 0], batch_index=0, length=["nf", 1]))
        g.add("vid", node("CreateVideo", images=make(g, ["cut", 0], **kw), fps=FPS))
        g.add("save", node("SaveVideo", video=["vid", 0], filename_prefix=f"deck/{name}", format="auto", codec="auto"))
        return g
    return build


def still_of(make, name, **kw):
    def build():
        g = G()
        g.add("img", {**node("LoadImage", image=""), "_meta": {"title": "@1 Picture [image]", "deck_keep_size": True}})
        g.add("save", node("SaveImage", images=make(g, ["img", 0], **kw), filename_prefix=f"deck/{name}"))
        return g
    return build


TEMPLATES = {
    "deck-depth-video": depth_video,
    "deck-depth-image": depth_image,
    "deck-canny-video": clip_of(canny, "canny"),
    "deck-canny-image": still_of(canny, "canny"),
    "deck-scribble-video": clip_of(scribble, "scribble"),
    "deck-scribble-image": still_of(scribble, "scribble", max_res=2048),
}

if __name__ == "__main__":
    for name, make in TEMPLATES.items():
        (OUT / f"{name}.json").write_text(json.dumps(make(), indent=1) + "\n")
        print("wrote", name)
