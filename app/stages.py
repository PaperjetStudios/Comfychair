"""Friendly progress for the tablet: which stage of a run a node belongs to (loading models,
encoding the prompt, sampling…), worked out from the workflow that is actually running."""

import re

STAGES = ["Loading models", "Preparing images", "Encoding prompt", "Sampling", "Decoding", "Saving"]


def stage_of(cls: str) -> str | None:
    c = cls.lower()
    if c in ("vaedecode", "vaedecodetiled", "vaedecodeaudio") or "decode" in c and "vae" in c:
        return "Decoding"
    if c.startswith("save") or c in ("vhs_videocombine", "createvideo", "previewimage"):
        return "Saving"
    if "loader" in c or "loadermodelonly" in c or c in ("modelattentionbackend", "vedasparseattention",
                                                         "skiplayerguidanceditsimple", "modelsamplingsd3"):
        return "Loading models"
    if c in ("loadimage", "loadimagemask", "imagescale", "imagescaletototalpixels", "vaeencode", "getimagesize",
             "batchimagesnode") or "imagescale" in c:
        return "Preparing images"
    if ("encode" in c or "conditioning" in c or "prompt" in c or c.endswith("tovideo") or "referencelatent" in c
            or "referencemultilatent" in c or "boundingboxes" in c or c.startswith("emptyl") or c.startswith("empty")):
        return "Encoding prompt"
    if "sampler" in c or "guider" in c or "scheduler" in c or "sigmas" in c or c == "randomnoise":
        return "Sampling"
    return None


def describe_node(workflow: dict, node_id: str) -> dict:
    node = workflow.get(str(node_id)) or {}
    cls = node.get("class_type", "")
    title = re.sub(r"\s*\[[^\]]*\]\s*$", "", ((node.get("_meta") or {}).get("title") or cls).lstrip("@").strip())
    title = title.split(" ", 1)[1] if title[:1].isdigit() and " " in title else title  # "@4 Sampler" -> "Sampler"
    return {"node": node_id, "class": cls, "title": title, "stage": stage_of(cls)}


def stages_in(workflow: dict) -> list[str]:
    found = {stage_of(n.get("class_type", "")) for n in workflow.values()}
    return [s for s in STAGES if s in found]
