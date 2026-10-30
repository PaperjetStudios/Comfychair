"""The 3D object templates: tags, links and the empty-view drop. Run with pytest tests."""
import os
import tempfile

os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
COMFY = tempfile.mkdtemp(prefix="deck-test-comfy-")
for d in ("output/comfydeck/Sandbox", "input/comfydeck"):
    os.makedirs(os.path.join(COMFY, d))
os.environ["DECK_COMFY_DIR"] = COMFY

from pathlib import Path  # noqa: E402

TEMPLATES = Path(__file__).resolve().parent.parent / "templates"


def load(tid):
    from app import templates as tpl   # (imported inside: app.config must see the env test_core sets)
    t = tpl.get(TEMPLATES, tid)
    assert t is not None, f"{tid} is missing"
    assert not t.error, t.error
    return t


def links(wf):
    for nid, node in wf.items():
        for name, v in node["inputs"].items():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str):
                yield nid, name, v[0], v[1]


def test_templates_are_valid_api_workflows():
    for tid in ("deck-3d-object", "deck-3d-object-multi", "deck-3d-object-trellis"):
        t = load(tid)
        wf = t.workflow
        for nid, name, src, slot in links(wf):
            assert src in wf, f"{tid}: {nid}.{name} points at a missing node {src}"
            assert isinstance(slot, int) and slot >= 0
        # one save node, writing where the 3D tab looks
        saves = [n for n in wf.values() if n["class_type"] == "Save3DAdvanced"]
        assert len(saves) == 1, tid
        assert saves[0]["inputs"]["filename_prefix"] == "deck/object3d", tid


def _describe(t):
    from app import templates as tpl
    return tpl.describe(t, None)["fields"]


def test_fields_are_tagged():
    single = load("deck-3d-object")
    fields = _describe(single)
    kinds = {(f["group"], f["label"]): f["kind"] for f in fields}
    assert kinds[("Front", "Image")] == "image"
    assert kinds[("Cut out", "Switch")] == "bool"
    assert kinds[("Texture", "Texture")] == "bool"
    assert kinds[("Detail (steps)", "Detail (steps)")] == "int"
    assert any(f["kind"] == "int" and f["group"] == "Seed" for f in fields)
    multi = _describe(load("deck-3d-object-multi"))
    groups = {f["group"] for f in multi if f["kind"] == "image"}
    assert groups == {"Front", "Back", "Left", "Right"}


def test_empty_views_are_dropped():
    t = load("deck-3d-object-multi")
    imgs = [f for f in _describe(t) if f["kind"] == "image"]
    front = next(f for f in imgs if f["group"] == "Front")
    from app import templates as tpl
    wf = tpl.apply(t.workflow, {f["key"]: ("front.png" if f is front else "") for f in imgs})
    imagers = [nid for nid, n in wf.items() if n["class_type"] == "LoadImage"]
    assert len(imagers) == 1, "only the picked view is read"
    cond = [n for n in wf.values() if n["class_type"] == "Pixal3DMultiViewConditioning"][0]
    assert "front" in cond["inputs"] and "back" not in cond["inputs"]
    for nid, name, src, slot in links(wf):
        assert src in wf, f"{nid}.{name} points at {src}, which was dropped"


def test_single_front_is_required():
    t = load("deck-3d-object")
    front = next(f for f in _describe(t) if f["kind"] == "image")
    from app import templates as tpl
    wf = tpl.apply(t.workflow, {front["key"]: ""})
    # an empty front drops the LoadImage, so nothing may point at it any more
    assert not any(n["class_type"] == "LoadImage" for n in wf.values())
    for nid, name, src, slot in links(wf):
        assert src in wf, f"{nid}.{name} points at {src}"


def _upstream(wf, nid):
    """The class types a node's MESH comes through, nearest first."""
    out = []
    while nid in wf:
        node = wf[nid]
        out.append(node["class_type"])
        src = node["inputs"].get("mesh") or node["inputs"].get("voxel")
        if not (isinstance(src, list) and len(src) == 2):
            break
        nid = src[0]
    return out


def test_the_model_is_the_full_shape_not_the_voxel_preview():
    # VoxelToMesh on the 32-voxel structure decode is a blocky preview: the saved model must be the full shape decode,
    # remeshed and decimated, with and without the texture
    for tid in ("deck-3d-object", "deck-3d-object-multi", "deck-3d-object-trellis"):
        wf = load(tid).workflow
        for start in ("196", "plainfile"):
            chain = _upstream(wf, start)
            assert "VoxelToMesh" not in chain, (tid, start, chain)
            assert chain[-3:] == ["DecimateMesh", "RemeshMesh", "VaeDecodeShapeTrellis"], (tid, start, chain)


def test_rig_mesh_path_skips_the_startup_list():
    # UniRig's isolated loader lists input/3d only when ComfyUI starts: a typed file_path sent after that is refused,
    # so the path comes through an any-type switch from a text field
    for tid in ("deck-autorig-human", "deck-autorig-any"):
        t = load(tid)
        src = t.workflow["mesh"]["inputs"]["file_path"]
        assert isinstance(src, list) and t.workflow[src[0]]["class_type"] == "LazySwitchKJ", tid
        model = [f for f in _describe(t) if f["group"] == "Model"]
        assert [f["kind"] for f in model] == ["text"], tid
