from pathlib import Path

from app.templates import display_name, load_all


def test_names_read_properly():
    assert display_name("deck-h3-ref2v") == "H3 Ref2V"
    assert display_name("deck-klein9b-edit") == "Klein 9B Edit"
    assert display_name("deck-qwen21-i2i") == "Qwen 2.1 I2I"
    assert display_name("deck-3d-object") == "3D Object"
    assert display_name("my_own-flow") == "My Own Flow"
    assert display_name("deck") == "Deck"


def test_no_template_is_called_deck():
    for t in load_all(Path(__file__).parent.parent / "templates"):
        assert not t.name.lower().startswith("deck ")
        assert t.name[0] == t.name[0].upper()
