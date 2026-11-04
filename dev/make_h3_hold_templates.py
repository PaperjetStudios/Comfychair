"""Write the H3 "hold" templates: deck-h3-ref2v and deck-h3-ctrl2v set up to stay closer to their references.

Run: python3 dev/make_h3_hold_templates.py   (then ↻ templates in ComfyChair; run it again if a base template changes)

The same graphs and models as their base templates, with two settings changed:
- Shift 6 video / 3 audio, the shifts the 8-step ref2v turbo LoRA was trained at, according to ComfyUI Wiki's
  write-up of it. Without a shift node ComfyUI uses the model's default, 12 / 3. Shown as a setting, to compare.
- ref_image_size "max": references keep up to 2048 px on the short edge. "match" shrinks each one to the video's area,
  about 0.34 MP at 768x448, which leaves a full-body reference few pixels for the face. It is much slower, and takes
  more of the card; the picture slot's Max MP or the Shot group's ref_image_size bring it back down.

Not yet tested on a GPU: nothing here is proven to hold a reference better than the base template.
"""
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "templates"
SHIFT = "60"   # the new node's id
TURBO = "30"   # the turbo LoRA, last in both base templates' LoRA chains
H3 = "7"       # MiniMaxH3ReferenceToVideo
# Base template, the file it makes, its save prefix, and the group number that puts Shift beside Steps
BASES = [("deck-h3-ref2v", "deck-h3-ref2v-hold", "comfydeck/h3refhold", 6),
         ("deck-h3-ctrl2v", "deck-h3-ctrl2v-hold", "comfydeck/h3ctrlhold", 9)]


def hold(base, prefix, group):
    wf = json.loads((OUT / f"{base}.json").read_text())
    for n in wf.values():   # whatever read the turbo LoRA now reads the shift
        if n.get("inputs", {}).get("model") == [TURBO, 0]:
            n["inputs"]["model"] = [SHIFT, 0]
    wf[SHIFT] = {"class_type": "MiniMaxH3SigmaShift",
                 "inputs": {"model": [TURBO, 0], "shift_video": 6.0, "shift_audio": 3.0},
                 "_meta": {"title": f"@{group} Shift [shift_video,shift_audio]"}}
    wf[H3]["inputs"]["ref_image_size"] = "max"
    wf["15"]["inputs"]["filename_prefix"] = prefix
    return wf


if __name__ == "__main__":
    for base, name, prefix, group in BASES:
        (OUT / f"{name}.json").write_text(json.dumps(hold(base, prefix, group), indent=2) + "\n")
        print("wrote", name)
