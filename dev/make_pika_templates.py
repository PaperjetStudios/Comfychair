"""Write the Pika H3 Flex templates: deck-h3-pika-ref2v, deck-h3-pika-i2v and deck-h3-pika-flf2v.

Run: python3 dev/make_pika_templates.py   (then ↻ templates in ComfyChair; run it again if a base template changes)

Pika H3 Flex is two LoRAs on MiniMax-H3 (Ref2VA for references, FL2VA for text and first / last frames) that finish
in six steps. The graphs are the base H3 templates' with four things changed, as Comfy-Org's own Pika templates
(video_pika_h3_flex_ref2va / _fl2va) and docs.comfy.org/tutorials/video/pika/pika-h3-flex have them:
- the turbo LoRA is replaced by the Pika LoRA at strength 1.0, and is no longer a setting: a turbo or lightning LoRA
  on top of it is the one thing the docs rule out;
- the sampler is lcm (it adds fresh noise between steps, the manifest's "renoise");
- the steps are Pika's own six, as a fixed list of sigmas: the manifest's knots 1000/750/500/250/100/40/0 at video
  shift 12. Six steps of any other schedule are not the same thing, so there is no Steps setting;
- the references template takes Pika's 9 pictures and 3 sounds (video references are not wired yet).

The LoRAs were made for MiniMax's own FL2VA and Ref2VA weights; the Model setting here starts on the merge the base
templates use (Singularity ref2va, pruned int8).

Tested on 2026-11-05 (RTX 4070 Super, ComfyUI v0.44.0, that merge, 5 s clips, models already on disk): Ref2V with
one picture at 768x448 took 69 s and kept the character through a walk and a spoken line; I2V at 448x768 took 54 s
and started on its first frame. Both came with a sound track, which was not listened to. One run each. FLF2V (the
same LoRA with a last frame) and sound references were not run.
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "templates"
SIGMAS = "1.0, 0.972973, 0.923077, 0.8, 0.571429, 0.333333, 0.0"
REF_LORA = "h3/pika_h3_flex_ref2va_v1_bf16.safetensors"
FL_LORA = "h3/pika_h3_flex_fl2va_v1_bf16.safetensors"
TURBO, SAMPLER, STEPS, SAVE, H3 = "30", "9", "10", "15", "7"
# Base template, the file it makes, its LoRA, its save prefix
BASES = [("deck-h3-ref2v", "deck-h3-pika-ref2v", REF_LORA, "comfydeck/h3pikaref"),
         ("deck-h3-i2v", "deck-h3-pika-i2v", FL_LORA, "comfydeck/h3pika"),
         ("deck-h3-flf2v", "deck-h3-pika-flf2v", FL_LORA, "comfydeck/h3pikaflf")]
PICTURES, SOUNDS = 9, 3


def more_references(wf):
    """Fill the H3 node's picture and sound slots up to Pika's 9 and 3, with pickers like the ones already there."""
    ins = wf[H3]["inputs"]
    nid = max(int(k) for k in wf) + 1
    for stem, total in (("ref_images.ref_image_", PICTURES), ("ref_audios.ref_audio_", SOUNDS)):
        have = sorted(k for k in ins if k.startswith(stem))
        like = wf[ins[have[0]][0]]   # the first picker of this kind: same class, title and inputs
        for i in range(len(have), total):
            wf[str(nid)] = json.loads(json.dumps(like))
            ins[f"{stem}{i}"] = [str(nid), 0]
            nid += 1


def pika(base, lora, prefix):
    wf = json.loads((OUT / f"{base}.json").read_text())
    wf[TURBO]["inputs"]["lora_name"] = lora
    wf[TURBO]["_meta"]["title"] = "Pika H3 Flex LoRA"
    wf[SAMPLER]["inputs"]["sampler_name"] = "lcm"
    wf[STEPS] = {"class_type": "ManualSigmas", "inputs": {"sigmas": SIGMAS},
                 "_meta": {"title": "Pika sigmas (6 steps)"}}
    wf[SAVE]["inputs"]["filename_prefix"] = prefix
    if wf[H3]["class_type"] == "MiniMaxH3ReferenceToVideo":
        more_references(wf)
    return wf


if __name__ == "__main__":
    for base, name, lora, prefix in BASES:
        (OUT / f"{name}.json").write_text(json.dumps(pika(base, lora, prefix), indent=2) + "\n")
        print("wrote", name)
