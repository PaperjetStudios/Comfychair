"""Build templates/deck-3d-object*.json from ComfyUI's official Pixal3D & TRELLIS.2 workflow.

    .venv/bin/python dev/make_3d_object_templates.py [--workflow PATH] [--comfy URL]

ComfyUI ships the workflow with its template library (comfyui_workflow_templates_json). This script
converts it to API format against the live /object_info, then keeps one branch, drops the preview,
remesh and bake nodes, adds the field primitives and writes the templates the 3D tab runs. Re-run it
when ComfyUI's workflow changes; the written JSON is what ships.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import ui_to_api as U  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
PKG = Path("/home/kb/Programs/ComfyUI/.venv/lib/python3.12/site-packages")
DEFAULT_WORKFLOW = PKG / "comfyui_workflow_templates_json/templates/3d_pixal3d_trellis2_image_to_model.json"


def node(cls, **inputs):
    return {"class_type": cls, "inputs": inputs}


def build(ui, oi, variant):
    api, problems = U.convert(ui, oi)
    problems = [p for p in problems if "241 RemeshMesh" not in p]

    def drop(*ids):
        for i in ids:
            api.pop(str(i), None)

    def refs(old, new):
        for n in api.values():
            for k, v in list(n["inputs"].items()):
                if isinstance(v, list) and len(v) == 2 and v[0] == str(old):
                    n["inputs"][k] = [str(new[0]), new[1]]

    def through(pid, sid, slot):
        refs(pid, (sid, slot))
        drop(pid)

    def resolve(sw, which):
        src = api[str(sw)]["inputs"].pop(which)
        refs(sw, (src[0], src[1]))
        drop(sw)

    pixal = variant != "trellis"
    for pid, sid, slot in ((302, 312, 0), (303, 248, 0), (164, 147, 0), (207, 147, 1), (208, 147, 2)):
        through(pid, sid, slot)

    # one branch: Pixal3D (single or four views) or TRELLIS.2
    if variant == "multi":
        drop(122, 192, 248, 312, 298, 55, 56, 242)
        api["mvc"] = node("Pixal3DMultiViewConditioning", clip_vision_model=["15", 0], fov=20.0)
        for role, title, name in (("front", "1", "Front"), ("back", "2", "Back"),
                                  ("left", "3", "Left"), ("right", "4", "Right")):
            api[role] = node("LoadImage", image="")
            api[role]["_meta"] = {"title": f"{title} {name} [image]"}
            api["bg_" + role] = node("RemoveBackground", bg_removal_model=["193", 0], image=[role, 0])
            api["crop_" + role] = node("ImageCropToMask", images=[role, 0], masks=["bg_" + role, 0],
                                       width=1024, height=1024, pad_factor=1.1, grow_mask=0,
                                       background="#000000")
            api["mvc"]["inputs"][role] = ["crop_" + role, 0]
        api["314"]["inputs"]["on_false"] = ["mvc", 0]
        api["314"]["inputs"]["on_true"] = ["mvc", 0]
        api["315"]["inputs"]["on_false"] = ["mvc", 1]
        api["315"]["inputs"]["on_true"] = ["mvc", 1]
    elif not pixal:
        drop(319, 298, 55, 56, 242)

    resolve(314, "on_false" if pixal else "on_true")
    resolve(315, "on_false" if pixal else "on_true")
    resolve(318, "on_false" if pixal else "on_true")
    drop(316)
    if pixal:
        drop(40, 299)

    # AO and normal maps need the remesh/decimate chain: leave them out (base colour, metal and roughness stay)
    drop(224, 233, 226, 235, 241, 186, 202)
    api["238"]["inputs"]["mesh"] = ["4", 0]
    api["210"]["inputs"].pop("occlusion", None)
    api["210"]["inputs"].pop("normal_map", None)

    # a view left empty takes its own background removal and crop with it (an optional multi-view input)
    follow = []
    if "192" in api:
        follow += ["192", "312"]
    if variant == "multi":
        for role in ("front", "back", "left", "right"):
            follow += ["bg_" + role, "crop_" + role]
    for nid in follow:
        meta = api[nid].setdefault("_meta", {})
        meta["deck_drop"] = True
        meta["deck_follow_on"] = ["image"] if nid.startswith(("192", "bg_")) else ["images", "masks"]

    # one Seed and one Detail (steps) drive every sampler
    api["seed"] = node("PrimitiveInt", value=43)
    api["steps"] = node("PrimitiveInt", value=20)
    for ks in ("3", "18", "23", "12"):
        api[ks]["inputs"]["seed"] = ["seed", 0]
        api[ks]["inputs"]["steps"] = ["steps", 0] if ks in ("18", "23") else api[ks]["inputs"].get("steps", 12)

    # Texture on/off: a lazy switch, so the texture stage and its bake do not run when it is off
    api["tex"] = node("PrimitiveBoolean", value=True)
    # (the plain side needs its own MeshToFile3D: Save3DAdvanced takes a file, not a MESH)
    api["plainfile"] = node("MeshToFile3D", mesh=["238", 0])
    api["texsw"] = node("LazySwitchKJ", switch=["tex", 0], on_false=["plainfile", 0], on_true=["285", 0])
    api["322"]["inputs"]["model_3d"] = ["texsw", 0]
    if "122" in api:
        api["122"]["inputs"]["image"] = ""   # (the official workflow ships a sample picture)
    api["322"]["inputs"]["filename_prefix"] = "deck/object3d"

    if variant == "multi":
        tags = {"front": "@1 Front [image]", "back": "@2 Back [image]", "left": "@3 Left [image]",
                "right": "@4 Right [image]", "steps": "@5 Detail (steps) [value]",
                "288": "@6 Texture resolution [value]", "tex": "@7 Texture [value]", "seed": "@8 Seed [value]"}
    else:
        tags = {"122": "@1 Front [image]", "248": "@2 Cut out [switch]", "steps": "@3 Detail (steps) [value]",
                "288": "@4 Texture resolution [value]", "tex": "@5 Texture [value]", "seed": "@6 Seed [value]"}
    for nid, title in tags.items():
        api[nid].setdefault("_meta", {})["title"] = title

    # keep only what the save node needs (the primitives it links to come along)
    keep, todo = set(), ["322"]
    while todo:
        nid = todo.pop()
        if nid in keep or nid not in api:
            continue
        keep.add(nid)
        for v in api[nid]["inputs"].values():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                todo.append(v[0])
    for nid in list(api):
        if nid not in keep:
            del api[nid]
    return api, problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workflow", default=str(DEFAULT_WORKFLOW))
    ap.add_argument("--comfy", default="http://127.0.0.1:8188")
    ap.add_argument("--out", default=str(ROOT / "templates"))
    a = ap.parse_args()
    ui = json.load(open(a.workflow))
    oi = U.object_info(a.comfy)
    for variant, name in (("pixal", "deck-3d-object"), ("multi", "deck-3d-object-multi"),
                          ("trellis", "deck-3d-object-trellis")):
        api, problems = build(ui, oi, variant)
        bad = U.validate(api, oi)
        print(f"{name}: {len(api)} nodes, {len(bad)} invalid, {len(problems)} conversion problems")
        for b in bad[:12]:
            print("   INVALID", b)
        for p in problems[:12]:
            print("   PROBLEM", p)
        if not bad and not problems:
            path = Path(a.out) / f"{name}.json"
            path.write_text(json.dumps(api, indent=1, sort_keys=True) + "\n")
            print("   wrote", path)


if __name__ == "__main__":
    main()
