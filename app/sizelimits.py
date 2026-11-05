"""How big a run is, against the largest run of its kind that has finished on this card.

A run's size is its output pixels x frames x batch, read from its own fields: width/height inputs (or a Width / Height
primitive, or a "Resolution (short side)" one), a `length` input in frames or a "Length (seconds)" primitive, and
`batch_size`. The limit is learned, not typed: the largest size of the same template that finished, or, for a template
with no finished run yet, of its family (the template id's first two parts: deck-h3, deck-krea2...). With neither there
is nothing to go by and every size passes.

/api/generate asks check() before queueing: over the limit it answers 409 with `tooBig` so the page can ask (Run anyway
sends `force`); at HARD times the limit it refuses even with `force`, since that can't fit.
"""
import json

from . import db

SLACK = 1.05        # a little over the largest that fitted is the same run
HARD = 3.0          # this many times the largest that fitted: refused even when asked to run anyway
FPS = 24            # "Length (seconds)" in frames, for comparing runs of one template with each other
SKIP_NODES = {"CreateBoundingBoxes", "MOSSImageLayoutPrompt"}   # width/height inputs that aren't the output's size


def family(template_id: str) -> str:
    return "-".join(template_id.split("-")[:2])


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def measure(params: dict, fields: list, workflow: dict) -> dict | None:
    """The run's size from its values: {"size", "w", "h", "frames", "batch"}, or None when nothing in it sets a size."""
    sides, area, frames, batch = {}, 0.0, 1.0, 1.0
    for f in fields:
        v = _num(params.get(f["key"], f.get("value")))
        if v is None or v <= 0:
            continue
        inp, group = f.get("input"), str(f.get("group") or "").lower()
        node = f.get("node")
        cls = (workflow.get(node) or {}).get("class_type", "")
        if inp in ("width", "height") and f.get("kind") == "int" and cls not in SKIP_NODES:
            sides.setdefault(node, {})[inp] = v
        elif inp == "value" and group in ("width", "height"):
            sides.setdefault("__primitive", {})[group] = v
        elif inp == "value" and group.startswith("resolution (short side)"):
            sides.setdefault("__short", {}).update(width=v * 16 / 9, height=v)
        elif inp == "length" and f.get("kind") == "int":
            frames = max(frames, v)
        elif inp == "value" and group.startswith("length (seconds)"):
            frames = max(frames, v * FPS)
        elif inp == "batch_size":
            batch = max(batch, v)
    best = None
    for s in sides.values():
        if "width" in s and "height" in s and s["width"] * s["height"] > area:
            area, best = s["width"] * s["height"], s
    if not best:
        return None
    return {"size": area * frames * batch, "w": round(best["width"]), "h": round(best["height"]),
            "frames": round(frames), "batch": round(batch)}


def largest(template_id: str, fields: list, workflow: dict) -> tuple[dict | None, str]:
    """The largest finished run of this template, else of its family: (its measure, "template" | "family")."""
    for sql, arg, scope in (("template=?", template_id, "template"), ("template LIKE ?", family(template_id) + "-%", "family")):
        best = None
        for (raw,) in db._q(f"SELECT params FROM generations WHERE status='done' AND {sql}", (arg,)):
            try:
                p = json.loads(raw)
            except (TypeError, ValueError):
                continue
            m = measure(p, fields, workflow) if isinstance(p, dict) else None
            if m and (not best or m["size"] > best["size"]):
                best = m
        if best:
            return best, scope
    return None, ""


def describe(m: dict) -> str:
    s = f"{m['w']}×{m['h']}"
    if m["frames"] > 1:
        s += f", {m['frames']} frames"
    if m["batch"] > 1:
        s += f", {m['batch']} at once"
    return s


def check(template_id: str, name: str, params: dict, fields: list, workflow: dict) -> dict | None:
    """None when the run is inside what has fitted (or nothing is known). Else {"message", "ratio", "hard"}."""
    m = measure(params, fields, workflow)
    if not m:
        return None
    best, scope = largest(template_id, fields, workflow)
    if not best or m["size"] <= best["size"] * SLACK:
        return None
    ratio = m["size"] / best["size"]
    kind = name if scope == "template" else f"{family(template_id).removeprefix('deck-')} model"
    msg = (f"This run ({describe(m)}) is about {ratio:.1f}× the largest {kind} run that has finished on this card "
           f"({describe(best)}).")
    hard = ratio >= HARD
    msg += " That can't fit: make it smaller." if hard else " It may run out of memory."
    return {"message": msg, "ratio": round(ratio, 2), "hard": hard}
