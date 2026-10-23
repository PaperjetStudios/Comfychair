"""Options every template gets, shown in an "Advanced" group: the attention backend, for video
the kind of live preview, and for MiniMax H3 Veda sparse attention.

They aren't nodes in the template. At generate time the patch nodes are put on the MODEL wire
right before whatever samples (samplers, guiders, schedulers), after any LoRA loaders.
"""
import copy

from . import comfy

ATTENTION = "__deck.attention"
VEDA = "__deck.veda"
PREVIEW = "__deck.preview"
PREVIEWS = ["animated (low-res)", "sharp still (TAE)", "off"]
SAGE = "sage (launch default)"
BACKENDS = {"comfy kitchen": "comfy kitchen attention", "pytorch": "pytorch attention"}
SINK_WORDS = ("sampler", "guider", "scheduler")


def _is_link(v) -> bool:
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int)


def is_video(workflow: dict) -> bool:
    return comfy.is_video(workflow)


def is_h3(workflow: dict) -> bool:
    return any(n["class_type"].startswith("MiniMaxH3") for n in workflow.values())


def fields(workflow: dict, object_info: dict | None) -> list[dict]:
    """The Advanced fields this template can offer with the nodes installed."""
    out = []
    if object_info is None or "ModelAttentionBackend" in object_info:
        out.append({"key": ATTENTION, "node": "__deck", "input": "attention", "label": "Attention",
                    "kind": "choice", "options": [SAGE, *BACKENDS], "value": SAGE, "group": "Advanced"})
    if is_video(workflow):
        out.append({"key": PREVIEW, "node": "__deck", "input": "preview", "label": "Live preview",
                    "kind": "choice", "options": PREVIEWS, "value": PREVIEWS[0], "group": "Advanced"})
    if is_h3(workflow) and (object_info is None or "VedaSparseAttention" in object_info):
        out.append({"key": VEDA, "node": "__deck", "input": "veda", "label": "Veda sparse attention (faster, experimental)",
                    "kind": "bool", "value": False, "group": "Advanced"})
    return out


def inject(wf: dict, values: dict) -> dict:
    """Insert the chosen patches on every MODEL wire feeding a sampler/guider/scheduler."""
    chain = []
    backend = BACKENDS.get(values.get(ATTENTION) or SAGE)
    if backend:
        chain.append(("ModelAttentionBackend", {"attention": backend}, "Attention backend"))
    if values.get(VEDA):
        ref = any(n["class_type"] == "MiniMaxH3ReferenceToVideo" for n in wf.values())
        predictor = ("minimax_h3_r2va_veda_preview_fp8.safetensors" if ref
                     else "minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors")
        chain.append(("VedaSparseAttention", {"predictor": predictor, "generated_sparsity": "32",
                                              "reference_sparsity": "32", "full_attention_layers": "",
                                              "full_attention_steps": "", "verbose": False}, "Veda sparse attention"))
    if not chain:
        return wf

    next_id = max((int(k) for k in wf if k.isdigit()), default=0) + 1
    patched = {}  # original model link -> end of its patch chain
    for node in list(wf.values()):
        if not any(w in node["class_type"].lower() for w in SINK_WORDS):
            continue
        src = node["inputs"].get("model")
        if not _is_link(src):
            continue
        key = tuple(src)
        if key not in patched:
            prev = copy.copy(src)
            for cls, inputs, title in chain:
                nid = str(next_id)
                next_id += 1
                wf[nid] = {"class_type": cls, "inputs": {"model": prev, **inputs}, "_meta": {"title": title}}
                prev = [nid, 0]
            patched[key] = prev
        node["inputs"]["model"] = copy.copy(patched[key])
    return wf
