"""Write the picture-control templates: a depth, Canny, scribble or pose picture steers a new picture.

Run: python3 dev/make_control_templates.py   (then ↻ templates in ComfyChair)

None of the image models here has a ControlNet, but the Klein and Qwen edit models take a picture as the layout of
what they make. So each control template is that model's edit template with
the first picture read as a control map: its size is the output's size, its shapes and edges stay where they are,
and the prompt says what they become. The optional reference slots stay (a look or a person to borrow).
Make the maps in the VFX tab (Depth map, Canny edges, Scribble, Pose preview, from a picture) or the 3D tab (Depth
picture, Pose picture).

Tested on 2026-10-30 (RTX 4070 Super, a made-up table scene): Klein 9B (Canny and depth) and Qwen 2.1 (Canny) kept
the window, ball and vase where the map had them. Klein 3 is the same graph as Klein 9B with its own models (loaded,
not run). Krea 2 and MOSS are left out: their edit modes pin the output to the picture, so they gave the map back
(Krea 2 at ref_boost 1 too).
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "templates"
MODELS = ["klein3", "klein9b", "qwen21"]

PROMPT = ("Turn the first picture, a control map (depth: white is near, dark is far; or edges, scribble lines or a pose), into a "
          "photograph of: a woman in a red coat on a rainy street at night. Keep every shape, edge and distance of the map "
          "where it is; draw the colours, light and detail from this description.")


def control(model):
    wf = json.loads((OUT / f"deck-{model}-edit.json").read_text())
    for n in wf.values():
        title = n.get("_meta", {}).get("title", "")
        if title == "@2 Image to edit":
            n["_meta"]["title"] = "@2 Control picture (depth, edges, scribble, pose)"
        elif title.startswith("@3 "):
            n["_meta"]["title"] = "@3 Look references (optional)"
        elif title.startswith("@1 Edit"):
            n["_meta"]["title"] = title.replace("@1 Edit", "@1 Prompt")
            key = "prompt" if "prompt" in n["inputs"] else "text"
            n["inputs"][key] = PROMPT
        elif n["class_type"] == "SaveImage":
            n["inputs"]["filename_prefix"] = f"{model}_control"
    return wf


if __name__ == "__main__":
    for m in MODELS:
        (OUT / f"deck-{m}-control.json").write_text(json.dumps(control(m), indent=1) + "\n")
        print("wrote", f"deck-{m}-control")
