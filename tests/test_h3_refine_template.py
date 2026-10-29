"""deck-h3-refine's Regenerate controls: an off-by-default refiner LoRA and a switch to the exact schedule."""
import os
import tempfile
from pathlib import Path

os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
os.environ.setdefault("DECK_COMFY_DIR", "")

TEMPLATES = Path(__file__).resolve().parent.parent / "templates"


def load():
    from app import templates as tpl
    t = tpl.get(TEMPLATES, "deck-h3-refine")
    assert t and not t.error, t.error if t else "missing"
    return tpl, t


def test_it_ships_the_regen_controls():
    tpl, t = load()
    wf = t.workflow
    assert wf["rglora"]["class_type"] == "LoraLoaderModelOnly"
    assert wf["rglora"]["inputs"]["model"] == ["30", 0]          # after the run's turbo LoRA
    assert wf["rgon"]["class_type"] == "PrimitiveBoolean"
    assert wf["rgon"]["inputs"]["value"] is False                # off by default
    assert wf["rgsig"]["inputs"]["sigmas"] == "0.7000, 0.4941, 0.0000"
    assert wf["rgsw"]["inputs"] == {"switch": ["rgon", 0], "on_false": ["10", 0], "on_true": ["rgsig", 0]}
    assert wf["12"]["inputs"]["sigmas"] == ["rgsw", 0]
    assert wf["51"]["inputs"]["model"] == ["rglora", 0]
    fields = {f["group"]: f for f in tpl.describe(t, None)["fields"]}
    assert fields["Regenerate"]["kind"] == "bool"
    assert fields["Regenerate LoRA"]["kind"] == "loras"


def test_empty_refiner_bypasses_and_the_switch_stays():
    tpl, t = load()
    wf = tpl.apply(t.workflow, {"rglora.__loras": [], "rgon.value": True})
    assert "rglora" not in wf, "an empty stack is bypassed"
    assert wf["51"]["inputs"]["model"] == ["30", 0], "the ControlNet takes the turbo's model"
    assert wf["12"]["inputs"]["sigmas"] == ["rgsw", 0], "the sampler still reads the switch"
    for nid, node in wf.items():
        for name, v in node.get("inputs", {}).items():
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and v[0].isdigit():
                assert v[0] in wf, f"{nid}.{name} points at dropped {v[0]}"


def test_a_refiner_goes_into_the_model_chain():
    tpl, t = load()
    wf = tpl.apply(t.workflow, {"rglora.__loras": [{"name": "reg.safetensors", "strength": 1.0, "enabled": True}],
                                "rgon.value": True})
    assert wf["rglora"]["inputs"]["lora_name"] == "reg.safetensors"
    assert wf["51"]["inputs"]["model"] == ["rglora", 0]
