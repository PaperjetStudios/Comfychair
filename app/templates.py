"""Workflow templates with @-tagged nodes.

A template is a ComfyUI workflow exported in API format (Workflow > Export (API)) and dropped
into templates/. Any node whose title starts with "@" is exposed in the tablet UI:

    @Prompt                 expose every widget input on this node, group label "Prompt"
    @Sampler [seed,steps]   expose only the listed inputs
    @1 Prompt               leading number sets the group's position in the UI
    @LoRAs                  on a LoraLoader / LoraLoaderModelOnly node: becomes a variable-length
                            LoRA stack (0..n). The node is removed or chained at run time.
    @Boxes                  on a CreateBoundingBoxes node: layout boxes drawn on the tablet, each an
                            object or a text with a description (MOSS / Flux3 layout prompts). With
                            a ReferenceMultiLatent in the graph, a box can also carry a reference image
    @Turbo LoRA             a LoRA stack whose title mentions "turbo" lists only speed-up LoRAs
                            (turbo, lightning, distill, N-step…) and starts switched off
    @Ref 1                  on a LoadImage node: an image picker. Left empty, the node is removed
                            and whatever it fed is unplugged (fine for optional inputs like refs).
    @Sound                  on a VHS_LoadAudio node: a sound picker (a sound file, or the sound of a
                            clip). Left empty, it is removed the same way.

Input types, ranges and dropdown options come from ComfyUI's /object_info, so the UI always
matches whatever models and nodes are actually installed.
"""
import copy
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import accel, editsize, maskcomp

TAG_RE = re.compile(r"^@\s*(?:(?P<order>\d+)\s+)?(?P<label>[^\[\]]*?)\s*(?:\[(?P<inputs>[^\]]*)\])?\s*$")
LORA_CLASSES = {"LoraLoader", "LoraLoaderModelOnly"}
BOX_CLASS = "CreateBoundingBoxes"
REF_CLASSES = {"ReferenceMultiLatent"}  # reference images numbered from images.image0 = <ref_image_0>
BOX_GRID = 1024
LAYOUT_SIZED = {"MOSSImageLayoutPrompt"}
IMAGE_CLASSES = {"LoadImage", "LoadImageMask", "LoadImageOutput"}
# a video picker: the tablet sends {"generation", "index"} or {"media"}, main.generate swaps in the file's path
VIDEO_CLASSES = {"VHS_LoadVideoPath"}
# a sound picker, the same way: main.generate swaps in a file the loader can open (app/audioedit.prep)
AUDIO_CLASSES = {"VHS_LoadAudio"}
SEED_NAMES = {"seed", "noise_seed"}
SAFE_ID = re.compile(r"^[\w\-. ]+$")
TURBO_RE = re.compile(r"turbo|lightning|lightx2v|distill|\d+[-_ ]?steps?\b|lcm", re.I)
AUTOGROW_RE = re.compile(r"^(?P<stem>[^.]+\.\D+?)(?P<n>\d+)$")


@dataclass
class Template:
    id: str
    name: str
    path: Path
    workflow: dict = field(default_factory=dict)
    error: str | None = None


def _is_link(v) -> bool:
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int)


def _is_api_format(data) -> bool:
    return (
        isinstance(data, dict)
        and len(data) > 0
        and all(isinstance(v, dict) and "class_type" in v and "inputs" in v for v in data.values())
    )


def _load(path: Path) -> Template:
    tid = path.stem
    t = Template(id=tid, name=tid.replace("_", " ").replace("-", " ").strip(), path=path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        t.error = f"Could not read JSON: {e}"
        return t
    if isinstance(data, dict) and "nodes" in data and "links" in data:
        t.error = "This is a UI-format workflow. In ComfyUI use Workflow > Export (API) and save that instead."
    elif not _is_api_format(data):
        t.error = "Not a ComfyUI API-format workflow."
    else:
        t.workflow = data
    return t


def load_all(directory: Path) -> list[Template]:
    return [_load(p) for p in sorted(directory.glob("*.json"))]


def get(directory: Path, tid: str) -> Template | None:
    if not SAFE_ID.match(tid or ""):
        return None
    p = directory / f"{tid}.json"
    return _load(p) if p.is_file() else None


# ---------------------------------------------------------------------------
# describe: workflow + object_info -> list of UI fields
# ---------------------------------------------------------------------------
def _parse_spec(ispec):
    """Normalise an /object_info input spec into (type, options)."""
    if not ispec:
        return None, {}
    t = ispec[0]
    opts = ispec[1] if len(ispec) > 1 and isinstance(ispec[1], dict) else {}
    if isinstance(t, list):
        return "COMBO", {**opts, "options": t}
    if t == "COMBO":
        return "COMBO", {**opts, "options": opts.get("options", [])}
    return t, opts


def _priority(cls: str) -> int:
    c = cls.lower()
    if "textencode" in c or "prompt" in c:
        return 0
    if "loadimage" in c or "image" in c and "load" in c:
        return 1
    if "lora" in c:
        return 2
    if "sampler" in c or "noise" in c or "scheduler" in c or "guider" in c:
        return 3
    if "latent" in c or "video" in c:
        return 4
    if "loader" in c or "checkpoint" in c or "unet" in c:
        return 5
    return 6


def _pretty(name: str) -> str:
    return name.replace("_", " ").strip().capitalize()


def _field(node_id, cls, name, value, ispec):
    t, opts = _parse_spec(ispec)
    f = {
        "key": f"{node_id}.{name}",
        "node": node_id,
        "input": name,
        "label": _pretty(name),
        "value": value,
    }
    if t is None:  # ComfyUI offline or node missing: infer from the value
        if isinstance(value, bool):
            t = "BOOLEAN"
        elif isinstance(value, int):
            t = "INT"
        elif isinstance(value, float):
            t = "FLOAT"
        else:
            t = "STRING"
            opts = {"multiline": name == "text" or (isinstance(value, str) and len(value) > 60)}

    if cls in IMAGE_CLASSES and name in ("image",) or opts.get("image_upload"):
        f.update(kind="image", options=opts.get("options", []))
    elif cls in VIDEO_CLASSES and name == "video":
        f.update(kind="video", value=None)
    elif cls in AUDIO_CLASSES and name == "audio_file":
        f.update(kind="audio", value=None, label="Sound")
    # Primitive nodes carry control_after_generate too, but they're plain numbers (e.g. a duration)
    elif t == "INT" and (name in SEED_NAMES or opts.get("control_after_generate") and not cls.startswith("Primitive")):
        f.update(kind="seed", min=opts.get("min", 0), max=opts.get("max"))
    elif t == "INT":
        f.update(kind="int", min=opts.get("min"), max=opts.get("max"), step=opts.get("step", 1))
    elif t == "FLOAT":
        f.update(kind="float", min=opts.get("min"), max=opts.get("max"), step=opts.get("step", 0.01),
                 round=opts.get("round"))
    elif t == "BOOLEAN":
        f.update(kind="bool")
    elif t == "COMBO":
        f.update(kind="choice", options=opts.get("options", []))
    elif t == "STRING":
        f.update(kind="text", multiline=bool(opts.get("multiline")))
    else:
        return None  # an unsupported widget type; skip it
    return f


def describe(t: Template, object_info: dict | None) -> dict:
    warnings = []
    if object_info is None:
        warnings.append("ComfyUI is offline: showing basic fields without dropdown options.")
    groups, fields = [], []
    node_titles = {}

    for file_order, (node_id, node) in enumerate(t.workflow.items()):
        cls = node.get("class_type", "")
        title = (node.get("_meta") or {}).get("title", "") or ""
        node_titles[node_id] = title or cls
        m = TAG_RE.match(title.strip())
        if not title.strip().startswith("@") or not m:
            continue
        label = (m.group("label") or cls).strip() or cls
        only = [s.strip() for s in (m.group("inputs") or "").split(",") if s.strip()]
        order = int(m.group("order")) if m.group("order") else None
        spec = {}
        if object_info is not None:
            info = object_info.get(cls)
            if info is None:
                warnings.append(f"Node '{cls}' ({label}) isn't installed in ComfyUI.")
            else:
                spec = {**info.get("input", {}).get("required", {}), **info.get("input", {}).get("optional", {})}

        group = {"label": label, "node": node_id, "class": cls,
                 "order": (order, _priority(cls), file_order)}

        if cls == BOX_CLASS:  # layout boxes, drawn on the tablet (see apply / boxes_to_state)
            fields.append({"key": f"{node_id}.__boxes", "node": node_id, "input": "__boxes", "label": label,
                           "kind": "boxes", "value": [], "group": label,
                           "refs": any(n.get("class_type") in REF_CLASSES for n in t.workflow.values())})
            groups.append(group)
            continue

        if cls in LORA_CLASSES:
            lora_opts = []
            if spec.get("lora_name"):
                _, o = _parse_spec(spec["lora_name"])
                lora_opts = o.get("options", [])
            turbo = "turbo" in label.lower()
            if turbo:  # a "Turbo LoRA" group lists only speed-up LoRAs and starts switched off
                lora_opts = [o for o in lora_opts if TURBO_RE.search(o)] or lora_opts
            current = node["inputs"].get("lora_name")
            default = []
            if current and current in lora_opts:
                default = [{"name": current, "strength": node["inputs"].get("strength_model", 1.0), "enabled": not turbo}]
            fields.append({"key": f"{node_id}.__loras", "node": node_id, "input": "__loras", "label": label,
                           "kind": "loras", "options": lora_opts, "value": default,
                           "clip": "clip" in node["inputs"], "group": label})
            groups.append(group)
            continue

        added = False
        for name, value in node.get("inputs", {}).items():
            if _is_link(value):
                continue
            if only and name not in only:
                continue
            f = _field(node_id, cls, name, value, spec.get(name))
            if f:
                f["group"] = label
                if cls.startswith("Primitive"):  # "Value" says nothing; the node's title does
                    f["label"] = label
                fields.append(f)
                added = True
        if added:
            groups.append(group)

    # several nodes may share one group label ("@2 References" on four LoadImage nodes):
    # keep the group once and number the fields that would otherwise look identical
    seen = set()
    groups = [g for g in groups if not (g["label"] in seen or seen.add(g["label"]))]
    dupes = {}
    for f in fields:
        dupes.setdefault((f["group"], f["label"]), []).append(f)
    for same in dupes.values():
        if len(same) > 1:
            for i, f in enumerate(same, 1):
                f["label"] = f"{f['label']} {i}"

    groups.sort(key=lambda g: (g["order"][0] if g["order"][0] is not None else 999, g["order"][1], g["order"][2]))
    rank = {g["label"]: i for i, g in enumerate(groups)}
    fields.sort(key=lambda f: rank.get(f["group"], 999))
    for g in groups:
        g.pop("order")
    if any(n.get("class_type") in editsize.UPSCALE_CLASSES for n in t.workflow.values()):
        for f in fields:  # an upscaler wants the picked image at full size, not capped to 1 MP
            if f["kind"] == "image":
                f["mp"] = 0
    if t.workflow:  # edit models size their output from Image 1: offer a size for it
        fields += editsize.fields(t.workflow, fields)
        fields += maskcomp.fields(t.workflow, fields)   # a mask painted on the first picture (after the Size: Crop to mask needs it)
    adv = accel.fields(t.workflow, object_info) if t.workflow else []
    if adv:  # attention backend / Veda: offered on every template, applied in accel.inject
        fields += adv
        groups.append({"label": "Advanced", "node": "__deck", "class": ""})
    if not fields and not t.error:
        warnings.append("No @-tagged nodes found. Rename nodes in ComfyUI (e.g. '@Prompt') and re-export.")
    return {"id": t.id, "name": t.name, "error": t.error, "warnings": warnings, "tag_style": tag_style(t.workflow),
            "media": media_kind(t.workflow), "family": family(t.id, t.workflow),
            "groups": groups, "fields": fields, "node_titles": node_titles}


# ---------------------------------------------------------------------------
# apply: template + values -> runnable workflow
# ---------------------------------------------------------------------------
def apply(workflow: dict, values: dict) -> dict:
    wf = copy.deepcopy(workflow)
    lora_ops, empty_images, box_ops = [], [], []
    for key, val in values.items():
        node_id, _, inp = key.rpartition(".")
        if node_id not in wf:
            continue
        if inp == "__loras":
            lora_ops.append((node_id, val))
        elif inp == "__boxes":
            box_ops.append((node_id, val))
        elif inp == maskcomp.MASK:   # applied after editsize (maskcomp.inject)
            continue
        elif (inp == "image" and wf[node_id]["class_type"] in IMAGE_CLASSES
              or inp == "video" and wf[node_id]["class_type"] in VIDEO_CLASSES
              or inp == "audio_file" and wf[node_id]["class_type"] in AUDIO_CLASSES) and not val:
            empty_images.append(node_id)
        else:
            wf[node_id]["inputs"][inp] = val
    for node_id, loras in lora_ops:
        expand_loras(wf, node_id, loras or [])
    for node_id in empty_images:
        drop_node(wf, node_id)
    for node_id, boxes in box_ops:  # after the drops, so reference numbers match what's sent
        boxes = attach_box_refs(wf, boxes or [])
        # list values must be wrapped, or ComfyUI reads a bare list as a link
        wf[node_id]["inputs"].update(width=BOX_GRID, height=BOX_GRID, editor_state={"__value__": boxes_to_state(boxes)},
                                     last_incoming={"__value__": []})
    sync_layout_size(wf)
    return wf


def ref_target(wf: dict):
    """The node that takes numbered reference images (images.image0, image1…), if any."""
    return next((n for n in wf.values() if n["class_type"] in REF_CLASSES), None)


def attach_box_refs(wf: dict, boxes: list) -> list:
    """Boxes may carry a reference image ("ref"). Each one is loaded, added as the next reference
    image, and the box description points at it ("matching <ref_image_N>")."""
    target = ref_target(wf)
    if not target or not any(isinstance(b, dict) and b.get("ref") for b in boxes):
        return boxes
    n = sum(1 for k, v in target["inputs"].items() if k.startswith("images.image") and _is_link(v))
    next_id = max((int(k) for k in wf if k.isdigit()), default=0) + 1
    index, out = {}, []
    for b in boxes:
        b = dict(b)
        ref = b.get("ref")
        if ref:
            if ref not in index:
                nid = str(next_id)
                next_id += 1
                wf[nid] = {"class_type": "LoadImage", "inputs": {"image": ref}, "_meta": {"title": f"Box reference {n}"}}
                target["inputs"][f"images.image{n}"] = [nid, 0]
                index[ref] = n
                n += 1
            b["desc"] = f"{(b.get('desc') or '').strip()} matching <ref_image_{index[ref]}>".strip()
        out.append(b)
    return out


VIDEO_OUT = {"SaveVideo", "VHS_VideoCombine", "CreateVideo", "SaveWEBM", "SaveAnimatedWEBP"}
IMAGE_OUT = {"SaveImage", "PreviewImage"}
# a template's model family, from its id (deck-<family>-…): what the Generate tab's Model filter shows
FAMILIES = [("ltx", "LTX-2.5"), ("h3", "MiniMax H3"), ("qwen", "Qwen Image"), ("klein", "Flux Klein"), ("krea", "Krea"),
            ("moss", "MOSS"), ("ace", "ACE-Step"), ("depth", "Depth"), ("sam3", "SAM3"), ("pose", "Pose"),
            ("mocap", "Motion"), ("motion", "Motion"), ("upscale", "Upscale")]


def media_kind(wf: dict) -> str:
    """What a template makes: video, image, audio, or other (a motion file…). A run that saves a video and stills
    (a character sheet) counts as video."""
    classes = {n.get("class_type", "") for n in wf.values()}
    if classes & VIDEO_OUT:
        return "video"
    if classes & IMAGE_OUT:
        return "image"
    if any(c.startswith("SaveAudio") for c in classes):
        return "audio"
    return "other"


def family(tid: str, wf: dict) -> str:
    parts = tid.lower().replace("_", "-").split("-")
    words = parts[1:] if parts[0] == "deck" else parts
    for key, label in FAMILIES:
        if words and words[0].startswith(key):
            return label
    classes = " ".join(n.get("class_type", "") for n in wf.values()).lower()
    for key, label in FAMILIES:   # a template of the user's own: by its nodes
        if key in classes:
            return label
    return "Other"


def tag_style(wf: dict) -> str | None:
    """How this model refers to reference images in prompts, for the tablet's tag shortcuts."""
    classes = {n.get("class_type", "") for n in wf.values()}
    if any(c.startswith("MiniMaxH3") for c in classes):
        return "h3"          # <Picture 1>, <Video 1>, <Audio 1>
    if classes & {"Flux3LayoutPrompt", "ReferenceMultiLatent"}:
        return "klein"       # <ref_image_0>, <obj_1>
    if "TextEncodeQwenImage21" in classes and any(
            k.startswith("images.") for n in wf.values() if n.get("class_type") == "TextEncodeQwenImage21" for k in n["inputs"]):
        return "qwen"        # Picture 1
    return None


def boxes_to_state(boxes) -> list:
    """Tablet boxes ({x, y, w, h} as 0..1 fractions, type, desc, text) -> CreateBoundingBoxes state.
    The layout nodes turn boxes into fractions of the canvas again, so a fixed square grid works
    for any output size."""
    out = []
    for b in boxes or []:
        if not isinstance(b, dict) or float(b.get("w", 0)) <= 0 or float(b.get("h", 0)) <= 0:
            continue
        kind = "text" if b.get("type") == "text" else "obj"
        out.append({"x": round(float(b["x"]) * BOX_GRID), "y": round(float(b["y"]) * BOX_GRID),
                    "width": max(1, round(float(b["w"]) * BOX_GRID)), "height": max(1, round(float(b["h"]) * BOX_GRID)),
                    "metadata": {"type": kind, "text": str(b.get("text") or "") if kind == "text" else "",
                                 "desc": str(b.get("desc") or ""), "palette": []}})
    return out


def sync_layout_size(wf: dict):
    """MOSS places boxes in output pixels, so its layout node must know the latent's size."""
    size = next((n["inputs"] for n in wf.values() if n["class_type"].startswith("Empty")
                 and isinstance(n["inputs"].get("width"), int) and isinstance(n["inputs"].get("height"), int)), None)
    if not size:
        return
    for n in wf.values():
        if n["class_type"] in LAYOUT_SIZED:
            n["inputs"]["width"], n["inputs"]["height"] = size["width"], size["height"]


def drop_node(wf: dict, nid: str):
    """Remove a node and unplug every input it fed. Used for image slots left empty, which only
    works when the inputs they feed are optional (reference images, first/last frames).
    A node that loses an input can say what to do in its _meta: "deck_passthrough": "<input>" drops it
    and hands that input's link to whatever it fed (an optional start image on a latent), or a list of
    inputs, one per output (a voice reference passing on model, positive, negative), and
    "deck_drop": true drops it too (a resize that only served the empty image)."""
    if nid not in wf:
        return
    del wf[nid]
    follow = []
    for oid, other in list(wf.items()):
        inputs = other["inputs"]
        removed = [k for k, v in inputs.items() if _is_link(v) and v[0] == nid]
        for k in removed:
            del inputs[k]
        meta = other.get("_meta") or {}
        if removed and (meta.get("deck_passthrough") or meta.get("deck_drop")):
            follow.append(oid)
        # autogrow inputs ("ref_images.ref_image_0", "_1"…) must stay contiguous: close the gap
        for k in removed:
            m = AUTOGROW_RE.match(k)
            if not m:
                continue
            siblings = sorted((int(mm.group("n")), kk) for kk in inputs
                              if (mm := AUTOGROW_RE.match(kk)) and mm.group("stem") == m.group("stem"))
            start = min([int(m.group("n"))] + [n for n, _ in siblings])
            moved = {kk: inputs.pop(kk) for _, kk in siblings}
            for i, (_, kk) in enumerate(siblings):
                inputs[f"{m.group('stem')}{start + i}"] = moved[kk]
    for oid in follow:
        node = wf.get(oid)
        if not node:
            continue
        names = (node.get("_meta") or {}).get("deck_passthrough") or []
        names = [names] if isinstance(names, str) else names
        for out, name in enumerate(names):   # its users take what it was passing on
            through = node["inputs"].get(name)
            if not _is_link(through):
                continue
            for other in wf.values():
                for k, v in other["inputs"].items():
                    if _is_link(v) and v[0] == oid and v[1] == out:
                        other["inputs"][k] = list(through)
        drop_node(wf, oid)


def expand_loras(wf: dict, nid: str, loras: list):
    """Replace one LoraLoader node with a chain of 0..n LoraLoaders, rewiring consumers."""
    node = wf[nid]
    cls = node["class_type"]
    with_clip = "clip" in node["inputs"]
    src_model = node["inputs"].get("model")
    src_clip = node["inputs"].get("clip")
    active = [l for l in loras if isinstance(l, dict) and l.get("name") and l.get("enabled", True) is not False]

    if not active:  # bypass: consumers connect straight to the loader's own inputs
        del wf[nid]
        for other in wf.values():
            for k, v in list(other["inputs"].items()):
                if _is_link(v) and v[0] == nid:
                    other["inputs"][k] = copy.copy(src_model if v[1] == 0 else src_clip)
        return

    base = max((int(k) for k in wf if k.isdigit()), default=0) + 1
    ids = [nid] + [str(base + i) for i in range(len(active) - 1)]

    for oid, other in wf.items():  # whatever used the loader now uses the end of the chain
        if oid == nid:
            continue
        for k, v in list(other["inputs"].items()):
            if _is_link(v) and v[0] == nid:
                other["inputs"][k] = [ids[-1], v[1]]

    for i, (cid, l) in enumerate(zip(ids, active)):
        strength = float(l.get("strength", 1.0))
        inputs = {
            "model": copy.copy(src_model) if i == 0 else [ids[i - 1], 0],
            "lora_name": l["name"],
            "strength_model": strength,
        }
        if with_clip:
            inputs["clip"] = copy.copy(src_clip) if i == 0 else [ids[i - 1], 1]
            inputs["strength_clip"] = float(l.get("strength_clip", strength))
        wf[cid] = {"class_type": cls, "inputs": inputs, "_meta": {"title": f"LoRA {i + 1}"}}
