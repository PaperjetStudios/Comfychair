"""UI-format ComfyUI workflow -> API format, using a live /object_info for widget order.

Dev tool for templates that ship as a UI workflow (ComfyUI's template library). Run against a
running ComfyUI:

    .venv/bin/python dev/ui_to_api.py <workflow.json> <out-dir> [--comfy URL]

It is not a general exporter: it knows the widget rules this repo needs (control_after_generate,
image upload widgets, preview pass-throughs, collapsing switches) and prints anything it cannot map.
"""
import json
import sys
import urllib.request

WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO", "COMFY_DYNAMICCOMBO_V3", "LOAD_3D"}


def object_info(url="http://127.0.0.1:8188"):
    return json.load(urllib.request.urlopen(url + "/object_info", timeout=120))


def _type_of(spec):
    t = spec[0] if isinstance(spec, (list, tuple)) else spec
    return "COMBO" if isinstance(t, list) else t


def _opts(spec):
    return spec[1] if isinstance(spec, (list, tuple)) and len(spec) > 1 and isinstance(spec[1], dict) else {}


def _widget_inputs(cls, oi):
    """Input names that are widgets, in the order the UI writes widgets_values."""
    s = oi.get(cls)
    if not s:
        return None
    out = []
    for group in ("required", "optional"):
        for name, spec in s["input"].get(group, {}).items():
            t = _type_of(spec)
            o = _opts(spec)
            if t in WIDGET_TYPES or "default" in o:
                out.append((name, o))
    return out


def convert(ui, oi):
    nodes = {n["id"]: n for n in ui["nodes"]}
    links = {l[0]: l for l in ui["links"]}
    api, problems = {}, []
    for nid, n in nodes.items():
        cls = n["type"]
        if cls in ("Note", "MarkdownNote"):
            continue
        wi = _widget_inputs(cls, oi)
        if wi is None:
            problems.append(f"node {nid}: {cls} not in /object_info")
            continue
        linked = {i["name"] for i in n.get("inputs", []) if i.get("link") is not None}
        inputs, vals = {}, list(n.get("widgets_values") or [])
        vi = 0
        for name, opts in wi:
            if vi >= len(vals):
                break
            value = vals[vi]
            vi += 1
            if name not in linked:
                inputs[name] = value
            # a widget the UI turned into an input still keeps its value in the list
            if opts.get("control_after_generate"):
                vi += 1
            if opts.get("image_upload"):
                vi += 1
            option = next((o for o in opts.get("options") or [] if isinstance(o, dict) and o.get("key") == value), None)
            if option:  # a dynamic combo's own sub-widgets follow it
                vi += len(option.get("inputs") or {})
        if vi < len(vals):
            problems.append(f"node {nid} {cls}: {len(vals) - vi} widget value(s) left over: {vals[vi:]}")
        for i in n.get("inputs", []):
            ln = i.get("link")
            if ln is None:
                continue
            src = links.get(ln)
            if not src:
                problems.append(f"node {nid} {cls}: {i['name']} has a dangling link {ln}")
                continue
            inputs[i["name"]] = [str(src[1]), src[2]]
        meta = {}
        if n.get("title"):
            meta["title"] = n["title"]
        api[str(nid)] = {"class_type": cls, "inputs": inputs, **({"_meta": meta} if meta else {})}
    return api, problems


def validate(api, oi):
    """Every class exists, every input name is known, every required link input is wired."""
    bad = []
    for nid, node in api.items():
        cls, inputs = node["class_type"], node["inputs"]
        s = oi.get(cls)
        if not s:
            bad.append(f"{nid}: no class {cls}")
            continue
        known = {}
        required = {}
        for group in ("required", "optional"):
            for name, spec in s["input"].get(group, {}).items():
                known[name] = spec
                if group == "required":
                    required[name] = spec
        for name, v in inputs.items():
            if name not in known:
                bad.append(f"{nid} {cls}: unknown input {name!r}")
        for name, spec in required.items():
            if name in inputs:
                continue
            t = _type_of(spec)
            o = _opts(spec)
            if t in WIDGET_TYPES or "default" in o:
                bad.append(f"{nid} {cls}: missing widget {name!r}")
            else:
                bad.append(f"{nid} {cls}: missing link {name!r}")
        for name, v in inputs.items():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and v[0].isdigit():
                src = api.get(v[0])
                if not src:
                    bad.append(f"{nid} {cls}.{name}: link to a node that was dropped ({v[0]})")
    return bad


def main():
    path, outdir = sys.argv[1], sys.argv[2]
    url = "http://127.0.0.1:8188"
    if "--comfy" in sys.argv:
        url = sys.argv[sys.argv.index("--comfy") + 1]
    ui = json.load(open(path))
    oi = object_info(url)
    api, problems = convert(ui, oi)
    bad = validate(api, oi)
    print(f"{len(api)} nodes converted")
    for p in problems:
        print("PROBLEM", p)
    for b in bad:
        print("INVALID", b)
    if not problems and not bad:
        json.dump(api, open(outdir, "w"), indent=1, sort_keys=True)
        print("wrote", outdir)


if __name__ == "__main__":
    main()
