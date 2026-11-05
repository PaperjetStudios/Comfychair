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
not run). MOSS is left out, and Krea 2's edit mode is not used: their edit modes pin the output to the picture, so they
gave the map back (Krea 2 at ref_boost 1 too).
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


# How each Krea 2 Control LoRA wants its map, from the node pack's README and the LoRAs' model cards
KREA = {
    "depth": {"lora": "krea/depth-control-lora.safetensors", "channel_mode": "grayscale", "normalize": "per_image_minmax",
              "picture": "@2 Control picture (depth map: white is near)"},
    "anything": {"lora": "krea/krea2-anythng_step_007000.safetensors", "channel_mode": "rgb", "normalize": "none",
                 "picture": "@2 Control picture (silhouette, pose, rough layout)"},
}
KREA_PROMPT = "A woman in a red coat on a rainy street at night, wet pavement, neon reflections, highly realistic detailed photograph"


def krea_control(kind):
    """deck-krea2-t2i with a Control LoRA after its LoRAs, and the output's size taken from the control picture."""
    k = KREA[kind]
    wf = json.loads((OUT / "deck-krea2-t2i.json").read_text())
    wf["4"]["_meta"]["title"] = "@4 LoRAs"
    wf["5"]["inputs"]["text"] = KREA_PROMPT
    wf["7"]["inputs"].update(width=["15", 0], height=["15", 1])
    wf["7"]["_meta"]["title"] = "Latent"
    wf["8"]["inputs"]["model"] = ["32", 0]
    wf["8"]["_meta"]["title"] = "@5 Sampler [seed,steps,sampler_name,scheduler]"
    wf["10"]["inputs"]["filename_prefix"] = f"krea2_{kind}_control"
    wf.update({
        "20": {"class_type": "LoadImage", "inputs": {"image": ""}, "_meta": {"title": k["picture"]}},
        "14": {"class_type": "ImageScaleToTotalPixels",
               "inputs": {"image": ["20", 0], "upscale_method": "lanczos", "megapixels": 1.0, "resolution_steps": 16},
               "_meta": {"title": "Size from the control picture"}},
        "15": {"class_type": "GetImageSize", "inputs": {"image": ["14", 0]}, "_meta": {"title": "Image size"}},
        "30": {"class_type": "Krea2ControlPlusImageEncode",
               "inputs": {"control_image": ["14", 0], "vae": ["3", 0], "latent": ["7", 0], "resize": "match_latent_size",
                          "upscale_method": "lanczos", "crop": "center", "channel_mode": k["channel_mode"],
                          "normalize": k["normalize"], "invert": False, "batch_mode": "independent_images"},
               "_meta": {"title": "Encode the control picture"}},
        "31": {"class_type": "Krea2ControlPlusLoRALoader",
               "inputs": {"model": ["4", 0], "lora_name": k["lora"], "strength": 1.0, "start_percent": 0.0, "end_percent": 1.0},
               "_meta": {"title": "@3 Control [strength,end_percent]"}},
        "32": {"class_type": "Krea2ControlPlusApply", "inputs": {"model": ["31", 0], "control_latent": ["30", 0]},
               "_meta": {"title": "Apply the control"}},
    })
    return wf


# RefControl (thedeoxen/refcontrol-FLUX.2-klein-9B-reference-pose-lora): a LoRA that reads picture 1 as a pose map
# and picture 2 as the character. The sentence is its trigger, as the model card and its workflow have it.
POSE_LORA = "klein/refcontrol_v2_poses.safetensors"
POSE_PROMPT = "apply pose from image 1 with reference from image 2"


def klein_pose():
    """deck-klein9b-control with the RefControl pose LoRA after its LoRAs: a pose map and one character picture.

    The card trains and recommends it on Klein 9B Base (about 50 steps, guidance 4) and says the 4-step distilled
    model works with slightly lower likeness and pose accuracy. This uses the distilled model the other Klein 9B
    templates do, at their 4 steps; Base is a gated download. The LoRA strength is the workflow's 1.0 (the card says
    0.8 to 1.0). Make the pose map as for the control templates (Image tools, the VFX tab's Quick effects, or the 3D
    tab's Save pose frame): a DWPose skeleton on black is what the card says works well. Tested on 2026-11-05 (RTX 4070 Super, one pose and
    character): the raised arm and the coat and face came through in about 40 s once loaded, but the framing came out
    closer than the full-body map.
    """
    wf = control("klein9b")
    last = wf.pop("22")   # the LoRA is trained on two pictures: the pose, then the character
    assert last["class_type"] == "LoadImage"
    del wf["10"]["inputs"]["images.image2"]
    wf["20"]["_meta"]["title"] = "@2 Pose picture (a skeleton on black)"
    wf["21"]["_meta"]["title"] = "@3 Character"
    wf["8"]["inputs"]["text"] = POSE_PROMPT
    wf["30"] = {"class_type": "LoraLoaderModelOnly",
                "inputs": {"model": ["4", 0], "lora_name": POSE_LORA, "strength_model": 1.0},
                "_meta": {"title": "RefControl pose LoRA"}}
    wf["24"]["inputs"]["model"] = ["30", 0]
    wf["13"]["inputs"]["filename_prefix"] = "klein9b_pose"
    return wf


if __name__ == "__main__":
    for m in MODELS:
        (OUT / f"deck-{m}-control.json").write_text(json.dumps(control(m), indent=1) + "\n")
        print("wrote", f"deck-{m}-control")
    for kind in KREA:
        (OUT / f"deck-krea2-{kind}-control.json").write_text(json.dumps(krea_control(kind), indent=1) + "\n")
        print("wrote", f"deck-krea2-{kind}-control")
    (OUT / "deck-klein9b-pose.json").write_text(json.dumps(klein_pose(), indent=1) + "\n")
    print("wrote", "deck-klein9b-pose")
