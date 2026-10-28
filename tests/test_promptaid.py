"""Prompt helper: kept tags, family guidance, device choice and the GPU lock, all with the model mocked.
Run: .venv/bin/python -m unittest discover tests"""
import io
import json
import os
import tempfile
import unittest
from unittest import mock

from fastapi import HTTPException

pa = None


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global pa
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    from app import promptaid
    pa = promptaid


def answer(*variants):
    return {"message": {"content": json.dumps({"variants": list(variants)})}}


class Tags(unittest.TestCase):
    def test_reference_tags_of_every_family(self):
        text = ("<Subject 1> is the woman in <Picture 1>. <ref_image_0> and <obj_2>, Picture 2, image 1, "
                "the first image beside the right half of the second image, @Mara, {red|blue} coat")
        self.assertEqual(pa.protected(text), ["<Subject 1>", "<Picture 1>", "<ref_image_0>", "<obj_2>", "Picture 2",
                                              "image 1", "the first image", "the right half of the second image",
                                              "@Mara", "{red|blue}"])

    def test_h3_structure(self):
        text = ("[Shot 1] A wide shot. <Subject 1> says: <d>Hello there.</d>\n[Shot 2] At 00:03.000, the camera cuts to "
                "a close-up.\noverall_soundscape: rain\nnon_diegetic_music: N/A")
        self.assertEqual(pa.protected(text), ["[Shot 1]", "<Subject 1>", "<d>Hello there.</d>", "[Shot 2] At 00:03.000",
                                              "overall_soundscape:", "non_diegetic_music:"])

    def test_missing(self):
        self.assertEqual(pa.missing("a woman like the first image", ["the first image", "@Mara"]), ["@Mara"])

    def test_clean(self):
        self.assertEqual(pa.clean('Prompt: "a red fox"'), "a red fox")


class Families(unittest.TestCase):
    def test_keys(self):
        self.assertEqual(pa.family_key("Krea", "krea", "image"), "krea")
        self.assertEqual(pa.family_key("Flux Klein", "klein"), "klein")
        self.assertEqual(pa.family_key("MiniMax H3", "h3", "video"), "h3")
        self.assertEqual(pa.family_key("LTX-2.5", "", "video"), "ltx")
        self.assertEqual(pa.family_key("Inpaint", "", "image"), "image")
        self.assertEqual(pa.family_key("Other", "", "video"), "video")
        self.assertEqual(pa.family_key("", "qwen", "image"), "qwen")

    def test_system_prompt(self):
        s = pa._system("krea", "improve", True, False, ["the first image"], 3)
        self.assertIn("Krea 2", s)
        self.assertIn("edit instruction", s)
        self.assertIn('"the first image"', s)
        self.assertIn("3 different versions", s)
        h3 = pa._system("h3", "expand", True, False, [], 2)
        self.assertIn("overall_soundscape", h3)
        self.assertNotIn("edit instruction", h3)   # (a video model never gets the picture-edit rule)
        self.assertIn("motion", pa._system("ltx", "improve", False, True, [], 3))


class Improve(unittest.TestCase):
    def test_variants_keep_tags_first(self):
        with mock.patch.object(pa, "chat", return_value=({"variants": ["a woman", "a woman like the first image"]}, "gpu")):
            r = pa.improve("woman like the first image", "Krea", "krea", "image")
        self.assertEqual(r["family"], "krea")
        self.assertEqual(r["variants"][0], {"text": "a woman like the first image", "missing": []})
        self.assertEqual(r["variants"][1]["missing"], ["the first image"])

    def test_asks_again_when_every_variant_lost_a_tag(self):
        calls = []

        def fake(msgs, device="auto", temperature=0.8, lines=False):
            calls.append(msgs)
            return ({"variants": ["no tag"]} if len(calls) == 1 else {"variants": ["@Mara at the window"]}), "cpu"
        with mock.patch.object(pa, "chat", side_effect=fake):
            r = pa.improve("@Mara window", "Krea")
        self.assertEqual(len(calls), 2)
        self.assertIn('"@Mara"', calls[1][-1]["content"])
        self.assertEqual(r["variants"][0]["text"], "@Mara at the window")
        self.assertEqual(r["device"], "cpu")

    def test_h3_lines_become_one_prompt(self):
        lines = ["[Shot 1] She runs.", "overall_soundscape: rain", "non_diegetic_music: N/A"]
        squashed = '{\n"[Shot 1] She runs.",\n"overall_soundscape: rain\\nnon_diegetic_music: N/A"\n}'
        with mock.patch.object(pa, "chat", return_value=({"variants": [lines, squashed]}, "gpu")) as chat:
            r = pa.improve("[Shot 1] she runs\noverall_soundscape: rain\nnon_diegetic_music: N/A", "MiniMax H3", "h3")
        self.assertTrue(chat.call_args.kwargs["lines"])
        self.assertEqual([v["text"] for v in r["variants"]], ["\n".join(lines)])   # (the second is the same, once joined)

    def test_empty_and_bad_mode(self):
        with self.assertRaises(HTTPException):
            pa.improve("  ")
        with self.assertRaises(HTTPException):
            pa.improve("x", mode="nope")


class Device(unittest.TestCase):
    def run_chat(self, device, busy=False, locked=False, free_mb=12000):
        posted = []

        def post(payload, timeout):
            posted.append(payload)
            return answer("one", "two")
        if locked:
            pa.voice._gpu.acquire()
        try:
            with mock.patch.object(pa, "ensure_server"), mock.patch.object(pa, "_comfy_busy", return_value=busy), \
                    mock.patch.object(pa, "_vram_free_mb", return_value=free_mb), \
                    mock.patch.object(pa.voice, "_free_gpu") as free, mock.patch.object(pa, "_post", side_effect=post):
                data, used = pa.chat([{"role": "user", "content": "x"}], device)
        finally:
            if locked:
                pa.voice._gpu.release()
        return data, used, posted, free

    def test_auto_uses_the_card_and_unloads_after(self):
        data, used, posted, free = self.run_chat("auto")
        self.assertEqual((used, data["variants"]), ("gpu", ["one", "two"]))
        self.assertEqual(posted[0]["keep_alive"], 0)
        self.assertNotIn("num_gpu", posted[0]["options"])
        free.assert_not_called()   # (enough room beside ComfyUI's models: they stay loaded)

    def test_frees_comfy_when_the_card_is_full(self):
        _, used, _, free = self.run_chat("gpu", free_mb=2000)
        self.assertEqual(used, "gpu")
        free.assert_called_once()

    def test_auto_falls_back_to_the_processor(self):
        _, used, posted, _ = self.run_chat("auto", busy=True)
        self.assertEqual((used, posted[0]["options"]["num_gpu"]), ("cpu", 0))
        _, used, posted, _ = self.run_chat("auto", locked=True)
        self.assertEqual((used, posted[0]["options"]["num_gpu"]), ("cpu", 0))

    def test_cpu(self):
        _, used, posted, free = self.run_chat("cpu")
        self.assertEqual(used, "cpu")
        free.assert_not_called()


class Describe(unittest.TestCase):
    def test_sends_a_small_jpeg(self):
        from PIL import Image
        buf = io.BytesIO()
        Image.new("RGB", (3000, 1500), "red").save(buf, "PNG")
        seen = {}

        def fake(msgs, device="auto", temperature=0.8, lines=False):
            seen["msgs"] = msgs
            return {"variants": ["A red field.", "Red."]}, "gpu"
        with mock.patch.object(pa, "chat", side_effect=fake):
            r = pa.describe(buf.getvalue(), "style", "LTX-2.5", "", "video")
        self.assertEqual([v["text"] for v in r["variants"]], ["A red field.", "Red."])
        self.assertIn("Don't mention the subject", seen["msgs"][0]["content"])
        img = Image.open(io.BytesIO(__import__("base64").b64decode(seen["msgs"][1]["images"][0])))
        self.assertEqual((img.format, max(img.size)), ("JPEG", 1024))

    def test_not_a_picture(self):
        with self.assertRaises(HTTPException):
            pa.describe(b"nope", "full")


class Server(unittest.TestCase):
    def test_clear_error_when_ollama_is_missing(self):
        with mock.patch.object(pa, "_up", return_value=False), mock.patch.object(pa, "ollama_bin", return_value=None):
            with self.assertRaises(HTTPException) as e:
                pa.ensure_server()
        self.assertEqual(e.exception.status_code, 503)
        self.assertIn("isn't installed", e.exception.detail)


if __name__ == "__main__":
    unittest.main()
