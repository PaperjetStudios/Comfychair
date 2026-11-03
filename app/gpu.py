"""One line for the graphics card. ComfyUI queues its own runs, but the jobs that use the card outside it (SHARP's splats,
the voice tools, the prompt helper on the card) and Blender's rebuilds know nothing of that queue, and two at once can run
the card or the memory out and crash. So everything takes its turn here, first come, first served:

- Nothing in the way: a ComfyUI run goes straight to ComfyUI, as if this weren't here.
- An outside job (`with card(...)`) waits for its turn and for ComfyUI's queue to empty, then has the machine to itself.
- A ComfyUI run that comes after a job in the line is held here, with its prompt id already chosen, and sent to ComfyUI once
  what's ahead of it is done. Its row in History shows it as queued throughout.

The line is kept in memory: a restart of ComfyChair ends what was waiting (a held run then shows as lost). ComfyUI's own
desktop page can still queue a run directly: an outside job waits for it, but one already running can't hold it back."""
import asyncio
import logging
import threading
import time
from contextlib import contextmanager

import httpx

from . import config

log = logging.getLogger("deck.gpu")
POLL = 0.5
_lock = threading.Lock()
_line: list[dict] = []   # what's waiting, in order: {"job": ...} for an outside job, {"pid": ...} for a held ComfyUI run
_holder: dict | None = None   # the outside job on the card now
_sending = 0   # ComfyUI runs on their way there: an outside job waits for them too
_pump: asyncio.Task | None = None


class Busy(Exception):
    """card(timeout=...) ran out of time waiting for its turn."""


def _comfy_idle() -> bool:
    """ComfyUI has nothing running or waiting (or it's off: then the card is free anyway)."""
    try:
        q = httpx.get(f"{config.COMFY_URL}/queue", timeout=5).json()
        return not (q.get("queue_running") or q.get("queue_pending"))
    except (httpx.HTTPError, ValueError):
        return True


@contextmanager
def card(label: str, job: dict | None = None, timeout: float | None = None):
    """Wait for this job's turn, then hold the machine for the `with` block. Runs in a worker thread (it blocks). `job`: a
    clip-importer style job, whose cancel flag ends the wait and whose label says it's waiting. Raises Busy after `timeout`."""
    global _holder
    t = {"kind": "job", "label": label, "job": job, "since": time.time(), "started": None}
    end = None if timeout is None else time.monotonic() + timeout
    with _lock:
        _line.append(t)
    try:
        while True:
            if job is not None and job.get("cancel"):
                raise RuntimeError("Cancelled")
            with _lock:   # first in the line: no new ComfyUI run can start now, so an empty queue stays empty
                first = _line[0] is t and _holder is None and _sending == 0
            if first and _comfy_idle():
                break
            if end is not None and time.monotonic() > end:
                raise Busy(label)
            if job is not None and job.get("label") != "Waiting for the graphics card":
                job["label"] = "Waiting for the graphics card"
            time.sleep(min(POLL, max(0.01, end - time.monotonic())) if end is not None else POLL)
        with _lock:
            _line.remove(t)
            t["started"], _holder = time.time(), t
        if job is not None:
            job["label"] = label
        yield
    finally:
        with _lock:
            if t in _line:
                _line.remove(t)
            if _holder is t:
                _holder = None


def hold(pid: str, send, failed) -> bool:
    """A ComfyUI run about to be sent. False: nothing's in the way, so send it now and call sent() after. True: it's held
    here, and the async send() runs when its turn comes; if that raises, failed(pid, error) is called."""
    global _sending, _pump
    with _lock:
        if not _line and _holder is None:
            _sending += 1
            return False
        _line.append({"kind": "comfy", "pid": pid, "send": send, "failed": failed, "since": time.time()})
        if _pump is None or _pump.done():
            _pump = asyncio.create_task(_send_held())
    return True


def sent():
    global _sending
    with _lock:
        _sending -= 1


async def _send_held():
    """Send held runs as they reach the front of the line. Ends when none is left."""
    global _sending
    while True:
        with _lock:
            if not any(t["kind"] == "comfy" for t in _line):
                return
            head = _line[0] if _line[0]["kind"] == "comfy" and _holder is None else None
            if head:
                _line.pop(0)
                _sending += 1
        if not head:
            await asyncio.sleep(POLL / 2)
            continue
        try:
            await head["send"]()
        except Exception as e:
            log.warning("held run %s wasn't accepted: %s", head["pid"], e)
            try:
                await head["failed"](head["pid"], e)
            except Exception:
                log.exception("held run %s: reporting its failure", head["pid"])
        finally:
            sent()


def drop(pids) -> set:
    """Take held runs out of the line -> the ids that were held."""
    with _lock:
        gone = {t["pid"] for t in _line if t["kind"] == "comfy" and t["pid"] in pids}
        _line[:] = [t for t in _line if t.get("pid") not in gone]
    return gone


def held_ids() -> list[str]:
    with _lock:
        return [t["pid"] for t in _line if t["kind"] == "comfy"]


def state() -> tuple[dict | None, list[dict]]:
    """(the outside job on the card, or None; a copy of the line in order)."""
    with _lock:
        return _holder, list(_line)


def count() -> int:
    with _lock:
        return len(_line) + (_holder is not None)
