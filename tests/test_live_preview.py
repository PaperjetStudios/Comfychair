"""The server keeps the running job's last live previews and replays them to a client that resyncs (app/main.py LIVE):
a page that reloads mid-run shows the sampler preview at once, animated when it was."""
import asyncio
import os
import tempfile
import unittest
from unittest import mock

main = None


def setUpModule():
    global main
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("DECK_COMFY_DIR", "")
    from app import config, main as m
    main = m
    assert not str(config.DATA_DIR).startswith(str(config.BASE_DIR / "data")), config.DATA_DIR


def vhs_frame(i: int) -> bytes:
    return (1).to_bytes(4, "big") + (1).to_bytes(4, "big") + (1).to_bytes(4, "big") + i.to_bytes(4, "big") + b"n" * 16 + b"\xff\xd8\xff" + bytes([i])


STILL = (1).to_bytes(4, "big") + (1).to_bytes(4, "big") + b"\xff\xd8\xff\xe0still"


class LivePreview(unittest.TestCase):
    def setUp(self):
        main._live_reset(None)
        self.sent = mock.patch.object(main, "broadcast", mock.AsyncMock()).start()
        self.addCleanup(mock.patch.stopall)

    def run_events(self, *events):
        async def go():
            for kind, payload in events:
                await main.on_comfy(kind, payload)
        asyncio.run(go())

    def replay(self):
        ws = mock.AsyncMock()
        asyncio.run(main.live_replay(ws))
        return [c.args[0] for c in ws.send_text.call_args_list], [c.args[0] for c in ws.send_bytes.call_args_list]

    def test_animated_frames_and_their_layout_are_kept_in_slot_order(self):
        meta = {"type": "VHS_latentpreview", "data": {"prompt_id": "p1", "length": 3, "rate": 8}}
        self.run_events(("json", {"type": "execution_start", "data": {"prompt_id": "p1"}}), ("json", meta),
                        ("binary", vhs_frame(2)), ("binary", vhs_frame(0)), ("binary", vhs_frame(0)))
        texts, frames = self.replay()
        self.assertEqual(len(texts), 1)
        self.assertIn('"VHS_latentpreview"', texts[0])
        self.assertEqual(frames, [vhs_frame(0), vhs_frame(2)])
        self.assertEqual(self.sent.await_count, 6, "everything is still forwarded live")

    def test_a_still_replaces_the_frames_and_the_run_ending_clears_it(self):
        self.run_events(("json", {"type": "execution_start", "data": {"prompt_id": "p1"}}), ("binary", vhs_frame(0)), ("binary", STILL))
        self.assertEqual(self.replay(), ([], [STILL]))
        self.run_events(("json", {"type": "executing", "data": {"prompt_id": "p1", "node": None}}))
        self.assertEqual(self.replay(), ([], []))

    def test_frames_before_any_run_started_are_not_kept(self):
        self.run_events(("binary", STILL))
        self.assertEqual(self.replay(), ([], []))
