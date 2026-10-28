"""Write the Krea 2 edit templates: Krea 2 turbo with the Krea 2 Identity Edit V2 / General Edit V2 LoRAs.

Run: python3 dev/make_krea_edit_templates.py   (then ↻ templates in ComfyChair)

Needs the comfyui-krea2edit node pack (>= 2.0.0, github.com/lbouaraba/comfyui-krea2edit) and the LoRAs from
huggingface.co/conradlocke/krea2-identity-edit in loras/krea/. The LoRAs were trained with two ways of seeing the
picture, and both nodes are needed: Krea2EditModelPatch puts the VAE-encoded picture(s) in front of the image being made
(appearance), Krea2EditGroundedEncode lets the text encoder (Qwen3-VL) see them while it reads the prompt (meaning).

The node takes at most two pictures: the first (the scene, the picture being edited) and the last (the subject).
ref_boost is the last picture's pull (the only picture's when there is one), ref_boost_a the first's. ref_position
places the last picture: "aligned" pins it onto the output's layout (an edit), "beside" sets it next to the canvas so
the subject can be restaged freely (a person put into the scene).

- deck-krea2-edit (General Edit V2): the picture to edit and up to two references. The edit takes its size from the
  picture (the Generate tab's Size crops it); the references are fitted in by the node (no crop). Two references are
  put side by side into one picture, since the node has only one subject slot. An empty slot drops cleanly:
  without a reference the picture is the only (and "aligned") one.
- deck-krea2-identity (Identity Edit V2): one photo of a person and a prompt for the new scene, at any size.

Recommended (model card): Turbo, 8 steps, CFG 1, euler/simple; grounding 768; General Edit ref_boost 4,
Identity ref_boost 2 (2-3 for a person put into a scene, the scene at 1). Removals want the Raw model at CFG 3, which
is not installed.

Tested on 2026-10-28 (RTX 4070 Super, 1 MP, the robot frame and a generated room): the robot put into the room kept the
room pixel-close and the robot's look (about 50 s with model loading, 20 s warm); two references side by side worked
("holding the red ball from the right half of the second image"); a single-picture edit (sofa to red leather, evening)
kept the layout. Identity restaging kept the character at ref_boost 2-4 (1 drifts: a new head design); with a prompt
that doesn't say the pose it copies the photo's pose.
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "templates"

GENERAL = "krea/krea2_general_edit_v2.safetensors"
IDENTITY = "krea/krea2_identity_edit_v2.safetensors"
ALIGNED, BESIDE = "aligned (trained)", "beside (right of target)"


def node(cls, title=None, **inputs):
    n = {"class_type": cls, "inputs": inputs}
    if title:
        n["_meta"] = {"title": title}
    return n


class G(dict):
    def add(self, nid, n):
        self[nid] = n
        return nid


def loaders(g, lora, lora_title):
    g.add("1", node("UNETLoader", "@9 Model [unet_name]", unet_name="krea2_turbo_fp8_scaled.safetensors",
                    weight_dtype="default"))
    g.add("2", node("CLIPLoader", "Load CLIP", clip_name="qwen3vl_4b_fp8_scaled.safetensors", type="krea2",
                    device="default"))
    g.add("3", node("VAELoader", "Load VAE", vae_name="qwen_image_vae.safetensors"))
    g.add("4", node("LoraLoaderModelOnly", lora_title, model=["1", 0], lora_name=lora, strength_model=1.0))
    g.add("5", node("LoraLoaderModelOnly", "@6 LoRAs", model=["4", 0], lora_name="none", strength_model=1.0))


def finish(g, latent, prefix, steps=8):
    g.add("31", node("ConditioningZeroOut", "Negative (zeroed, CFG 1)", conditioning=["30", 0]))
    g.add("50", node("KSampler", "@5 Sampler [seed,steps]", seed=0, steps=steps, cfg=1.0, sampler_name="euler",
                     scheduler="simple", denoise=1.0, model=["41", 0], positive=["30", 0], negative=["31", 0],
                     latent_image=latent))
    g.add("51", node("VAEDecode", "VAE Decode", samples=["50", 0], vae=["3", 0]))
    g.add("52", node("SaveImage", "Save Image", filename_prefix=prefix, images=["51", 0]))


def edit():
    g = G()
    loaders(g, GENERAL, "General Edit V2 LoRA")
    g.add("20", node("LoadImage", "@2 Image to edit", image=""))
    g.add("21", node("LoadImage", "@3 References", image=""))
    g.add("22", node("LoadImage", "@3 References", image=""))
    # two references become one picture (the node has one subject slot); one reference passes through as it is
    stitch = node("ImageStitch", "References side by side", image1=["21", 0], image2=["22", 0], direction="right",
                  match_image_size=True, spacing_width=0, spacing_color="white")
    stitch["_meta"].update({"deck_passthrough": "image2", "deck_follow_on": ["image1"]})
    g.add("23", stitch)
    g.add("30", node("Krea2EditGroundedEncode", "@1 Edit [prompt]", clip=["2", 0],
                     prompt="Put the character from the second image into the first image, standing in the middle "
                            "of the room, lit by the room's light.",
                     image=["20", 0], image_b=["23", 0], grounding_px=768, system_prompt=""))
    g.add("40", node("VAEEncode", "Encode picture", pixels=["20", 0], vae=["3", 0]))
    patch = node("Krea2EditModelPatch", "@4 Reference [ref_boost]", model=["5", 0], source_latent=["40", 0],
                 ref_boost=4.0, ref_boost_a=1.0, fit_mode="fit", vae=["3", 0], source_image=["20", 0],
                 source_image_b=["23", 0], target_latent=["40", 0], ref_position=BESIDE, ref_position_a=ALIGNED)
    # without a reference the picture is the last (only) one: keep it on the layout
    patch["_meta"]["deck_unplugged"] = {"ref_position": ALIGNED}
    g.add("41", patch)
    finish(g, ["40", 0], "krea2_edit")
    return g


def identity():
    g = G()
    loaders(g, IDENTITY, "Identity Edit V2 LoRA")
    g.add("20", node("LoadImage", "@2 Person", image=""))
    g.add("30", node("Krea2EditGroundedEncode", "@1 Prompt [prompt]", clip=["2", 0],
                     prompt="Full body, the character stands on a misty mountain ridge at sunrise, warm light from "
                            "the left, wide shot.",
                     image=["20", 0], grounding_px=768, system_prompt=""))
    g.add("40", node("EmptySD3LatentImage", "@3 Size [width,height]", width=1024, height=1024, batch_size=1))
    # source_latent is required but unused: with vae + source_image the node fits the photo itself (no crop)
    g.add("41", node("Krea2EditModelPatch", "@4 Reference [ref_boost]", model=["5", 0], source_latent=["40", 0],
                     ref_boost=2.0, ref_boost_a=1.0, fit_mode="fit", vae=["3", 0], source_image=["20", 0],
                     target_latent=["40", 0], ref_position=BESIDE, ref_position_a=ALIGNED))
    finish(g, ["40", 0], "krea2_identity")
    return g


TEMPLATES = {
    "deck-krea2-edit": edit,
    "deck-krea2-identity": identity,
}

if __name__ == "__main__":
    for name, make in TEMPLATES.items():
        (OUT / f"{name}.json").write_text(json.dumps(make(), indent=1) + "\n")
        print("wrote", name)
