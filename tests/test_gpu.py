"""The card's line (app/gpu.py): outside jobs and ComfyUI runs take turns. ComfyUI is faked with httpx.MockTransport."""
import asyncio
import json
import os
import tempfile
import threading
import time
import unittest
from unittest import mock

import httpx


def setUpModule():   # imported late: other test modules set DECK_DATA/DECK_COMFY_DIR before app.config loads
    global gpu, comfy_mod, clipimport, main, db, TestClient
    os.environ.setdefault("DECK_DATA", tempfile.mkdtemp(prefix="deck-test-"))
    os.environ.setdefault("COMFY_URL", "http://127.0.0.1:9")
    from fastapi.testclient import TestClient
    from app import clipimport, comfy as comfy_mod, db, gpu, main


def fake_comfy(refuse=False):
    """A Comfy whose /prompt only records what it was sent."""
    c = comfy_mod.Comfy("http://comfy.test")
    c.posted, c.deleted = [], []

    def handler(request):
        if request.url.path == "/prompt":
            if refuse:
                return httpx.Response(400, json={"error": {"message": "Nope"}})
            body = json.loads(request.content)
            c.posted.append(body["prompt_id"])
            return httpx.Response(200, json={"prompt_id": body["prompt_id"], "number": 1, "node_errors": {}})
        if request.url.path == "/queue" and request.method == "POST":
            c.deleted += json.loads(request.content)["delete"]
            return httpx.Response(200, json={})
        if request.url.path == "/queue":
            return httpx.Response(200, json={"queue_running": [], "queue_pending": []})
        if request.url.path == "/history/none":
            return httpx.Response(200, json={})
        return httpx.Response(200, json={})
    c.http = httpx.AsyncClient(base_url="http://comfy.test", transport=httpx.MockTransport(handler))
    c._last_models = None
    return c


WF = {"1": {"class_type": "KSampler", "inputs": {}}}
TRELLIS = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "trellis_2_int8_convrot.safetensors"}}}
OTHER = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "pixal3d_int8_convrot.safetensors"}}}


class FreeCard(unittest.IsolatedAsyncioTestCase):
    """A Trellis run has the card emptied right before it, in the queue."""
    def comfy(self, node_known=True):
        c = comfy_mod.Comfy("http://comfy.test")
        c.sent, c.freed, c.forgot = [], 0, []

        def handler(request):
            if request.url.path == "/prompt":
                body = json.loads(request.content)
                kinds = [n["class_type"] for n in body["prompt"].values()]
                if not node_known and kinds == [comfy_mod.FREE_NODE]:
                    return httpx.Response(400, json={"error": {"message": "invalid prompt"}})
                c.sent.append(kinds[0])
                return httpx.Response(200, json={"prompt_id": body["prompt_id"], "number": 1, "node_errors": {}})
            if request.url.path == "/free":
                c.freed += 1
            if request.url.path == "/history" and request.method == "POST":
                c.forgot += json.loads(request.content)["delete"]
            if request.url.path.startswith("/history/"):
                return httpx.Response(200, json={request.url.path.rsplit("/", 1)[1]: {}})
            return httpx.Response(200, json={})
        c.http = httpx.AsyncClient(base_url="http://comfy.test", transport=httpx.MockTransport(handler))
        c._last_models = None
        self.addAsyncCleanup(self.stop_tasks, c)
        return c

    async def stop_tasks(self, c):
        for t in list(c._checks):
            t.cancel()

    async def test_every_trellis_run_gets_it_even_with_the_same_models(self):
        c = self.comfy()
        for _ in range(2):
            await c.queue(json.loads(json.dumps(TRELLIS)))
        self.assertEqual(c.sent, [comfy_mod.FREE_NODE, "UNETLoader"] * 2)
        self.assertEqual(c.freed, 0)

    async def test_other_runs_only_on_a_change_of_models(self):
        c = self.comfy()
        for _ in range(2):
            await c.queue(json.loads(json.dumps(OTHER)))
        self.assertEqual(c.sent, ["UNETLoader"] * 2)
        self.assertEqual(c.freed, 0)

    async def test_without_the_node_it_asks_free_and_the_run_still_goes(self):
        c = self.comfy(node_known=False)
        await c.queue(json.loads(json.dumps(TRELLIS)))
        self.assertEqual(c.sent, ["UNETLoader"])
        self.assertEqual(c.freed, 1)

    async def test_the_button_says_when_it_could_not_stop_the_workers(self):
        self.assertEqual(await self.comfy().free_card(), {"workers": True})
        c = self.comfy(node_known=False)
        self.assertEqual(await c.free_card(), {"workers": False})
        self.assertEqual(c.freed, 1)

    async def test_comfyui_keeps_no_history_of_it(self):
        c = self.comfy()
        await c.free_card()
        real = asyncio.sleep

        async def quick(_):
            await real(0)
        with mock.patch.object(comfy_mod.asyncio, "sleep", quick):
            for _ in range(200):
                if c.forgot:
                    break
                await real(0)
        self.assertEqual(len(c.forgot), 1)
        await real(0)
        self.assertEqual(c.freeing, set())


class HoldOpen:
    """An outside job in a thread that holds the card until told to go."""
    def __init__(self, job=None, label="Making the splat"):
        self.ready, self.go, self.done = threading.Event(), threading.Event(), threading.Event()
        self.error = None
        self.job, self.label = job, label
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self):
        try:
            with gpu.card(self.label, self.job):
                self.ready.set()
                self.go.wait(10)
        except Exception as e:
            self.error = e
        self.done.set()


class Base(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.assertEqual(gpu.count(), 0)   # (a test that left something behind would hide the others' failures)
        p = mock.patch.object(gpu, "_comfy_idle", return_value=True)
        self.idle = p.start()
        self.addCleanup(p.stop)
        q = mock.patch.object(gpu, "POLL", 0.02)
        q.start()
        self.addCleanup(q.stop)

    async def wait_for(self, check, secs=5):
        end = time.time() + secs
        while not check():
            self.assertLess(time.time(), end, "timed out")
            await asyncio.sleep(0.01)

    async def asyncTearDown(self):
        await self.wait_for(lambda: gpu.count() == 0)


class ComfyRuns(Base):
    async def test_a_clear_line_sends_straight_away(self):
        c = fake_comfy()
        res = await c.queue(dict(WF))
        self.assertEqual(c.posted, [res["prompt_id"]])
        self.assertEqual(gpu._sending, 0)

    async def test_a_refusal_with_a_clear_line_is_still_raised(self):
        with self.assertRaises(comfy_mod.ComfyError):
            await fake_comfy(refuse=True).queue(dict(WF))
        self.assertEqual(gpu._sending, 0)

    async def test_a_run_waits_for_the_job_on_the_card(self):
        c, job = fake_comfy(), HoldOpen()
        await asyncio.to_thread(job.ready.wait, 5)
        res = await c.queue(dict(WF))
        await asyncio.sleep(0.1)
        self.assertEqual(c.posted, [])   # (the crash this is here for: a run started under a splat)
        self.assertEqual(gpu.held_ids(), [res["prompt_id"]])
        job.go.set()
        await self.wait_for(lambda: c.posted == [res["prompt_id"]])   # (ComfyUI gets the id the row was made with)

    async def test_runs_stay_in_order_behind_a_job(self):
        c, job = fake_comfy(), HoldOpen()
        await asyncio.to_thread(job.ready.wait, 5)
        pids = [(await c.queue(dict(WF)))["prompt_id"] for _ in range(3)]
        job.go.set()
        await self.wait_for(lambda: len(c.posted) == 3)
        self.assertEqual(c.posted, pids)

    async def test_cancelling_a_held_run_never_sends_it(self):
        c, job = fake_comfy(), HoldOpen()
        await asyncio.to_thread(job.ready.wait, 5)
        pid = (await c.queue(dict(WF)))["prompt_id"]
        await c.delete_queued([pid])
        self.assertEqual((gpu.held_ids(), c.deleted), ([], []))
        job.go.set()
        await self.wait_for(lambda: gpu.count() == 0)
        self.assertEqual(c.posted, [])

    async def test_a_held_run_comfy_refuses_reports_its_failure(self):
        c, job = fake_comfy(refuse=True), HoldOpen()
        told = []

        async def tell(pid, msg):
            told.append((pid, msg))
        c.on_held_failed = tell
        await asyncio.to_thread(job.ready.wait, 5)
        pid = (await c.queue(dict(WF)))["prompt_id"]
        job.go.set()
        await self.wait_for(lambda: told)
        self.assertEqual(told[0][0], pid)
        self.assertIn("Nope", told[0][1])
        self.assertEqual((await c.history(pid))[pid]["status"]["status_str"], "error")   # (tracking and solves wait on this)
        await c.forget(pid)
        self.assertNotIn(pid, c._failed)

    async def test_a_failed_held_run_marks_its_row(self):
        c, job = fake_comfy(refuse=True), HoldOpen()
        c.on_held_failed = main.held_run_failed
        await asyncio.to_thread(job.ready.wait, 5)
        pid = (await c.queue(dict(WF)))["prompt_id"]
        gid = db.create_generation(None, "t", {}, WF, pid, None)
        job.go.set()
        await self.wait_for(lambda: db.get_generation(gid)["status"] == "error")
        self.assertIn("Nope", db.get_generation(gid)["error"])
        db.update_generation(gid, status="done")


class OutsideJobs(Base):
    async def test_a_job_waits_for_comfy_to_empty(self):
        self.idle.return_value = False
        job = HoldOpen()
        await asyncio.sleep(0.1)
        self.assertFalse(job.ready.is_set())
        self.idle.return_value = True
        await asyncio.to_thread(job.ready.wait, 5)
        self.assertTrue(job.ready.is_set())
        job.go.set()

    async def test_a_run_after_a_waiting_job_goes_behind_it(self):
        self.idle.return_value = False   # ComfyUI is busy: the job waits, and what comes after waits behind it
        c, job = fake_comfy(), HoldOpen()
        await self.wait_for(lambda: gpu.count() == 1)
        pid = (await c.queue(dict(WF)))["prompt_id"]
        await asyncio.sleep(0.1)
        self.assertEqual(c.posted, [])
        self.idle.return_value = True
        await asyncio.to_thread(job.ready.wait, 5)
        await asyncio.sleep(0.1)
        self.assertEqual(c.posted, [])   # (the job went first)
        job.go.set()
        await self.wait_for(lambda: c.posted == [pid])

    async def test_a_job_waits_for_runs_ahead_of_it(self):
        c, first = fake_comfy(), HoldOpen()
        await asyncio.to_thread(first.ready.wait, 5)
        pid = (await c.queue(dict(WF)))["prompt_id"]
        second = HoldOpen()
        await self.wait_for(lambda: gpu.count() == 3)
        first.go.set()
        await self.wait_for(lambda: c.posted == [pid])
        await asyncio.to_thread(second.ready.wait, 5)
        self.assertTrue(second.ready.is_set())
        second.go.set()

    async def test_jobs_never_overlap(self):
        inside, most = [0], [0]

        def work():
            with gpu.card("x"):
                inside[0] += 1
                most[0] = max(most[0], inside[0])
                time.sleep(0.01)
                inside[0] -= 1
        await asyncio.gather(*[asyncio.to_thread(work) for _ in range(6)])
        self.assertEqual(most[0], 1)

    async def test_a_waiting_job_can_be_cancelled(self):
        first = HoldOpen()
        await asyncio.to_thread(first.ready.wait, 5)
        job = {"cancel": False, "label": "Making the splat"}
        second = HoldOpen(job)
        await self.wait_for(lambda: job["label"] == "Waiting for the graphics card")
        job["cancel"] = True
        await asyncio.to_thread(second.done.wait, 5)
        self.assertEqual(str(second.error), "Cancelled")
        self.assertFalse(second.ready.is_set())
        first.go.set()

    async def test_a_job_that_fails_lets_the_next_through(self):
        with self.assertRaises(ValueError):
            with gpu.card("x"):
                raise ValueError("no")
        self.assertEqual(gpu.count(), 0)

    async def test_time_runs_out(self):
        first = HoldOpen()
        await asyncio.to_thread(first.ready.wait, 5)

        def impatient():
            with gpu.card("y", timeout=0.05):
                pass
        with self.assertRaises(gpu.Busy):
            await asyncio.to_thread(impatient)
        first.go.set()


class Stoppable(Base):
    async def test_stop_ends_a_running_program_and_its_children(self):
        from app import sceneasset
        job = {"id": "j", "cancel": False, "proc": None, "state": "running"}
        # (a wrapper with a child holding the pipes open: killing only the wrapper leaves this waiting on the child)
        run = asyncio.create_task(asyncio.to_thread(sceneasset._run_stoppable, job, ["sh", "-c", "sleep 30; true"], 60))
        await self.wait_for(lambda: job["proc"] is not None)
        t0 = time.time()
        job["cancel"] = True
        r = await run
        self.assertNotEqual(r.returncode, 0)
        self.assertLess(time.time() - t0, 5)
        self.assertIsNone(job["proc"])

    async def test_a_program_that_runs_too_long_is_ended(self):
        from app import sceneasset
        import subprocess
        job = {"id": "j", "cancel": False, "proc": None, "state": "running"}
        with self.assertRaises(subprocess.TimeoutExpired):
            await asyncio.to_thread(sceneasset._run_stoppable, job, ["sh", "-c", "sleep 30; true"], 0.2)

    async def test_stop_run_leaves_another_run_alone(self):
        c = fake_comfy()
        with mock.patch.object(c, "interrupt") as stop:
            await c.stop_run("someone-elses-is-running")
        stop.assert_not_called()


class Listing(Base):
    def test_the_queue_shows_the_line(self):
        c = TestClient(main.app)
        job = {"id": "abc", "cancel": False, "label": "Making the splat", "progress": 0.5, "state": "running"}
        first = HoldOpen(job)
        self.assertTrue(first.ready.wait(5))
        waiting = HoldOpen({"id": "def", "cancel": False, "label": "Speaking", "progress": 0.0, "state": "running"}, label="Speaking")
        end = time.time() + 5
        while gpu.count() < 2 and time.time() < end:
            time.sleep(0.01)
        held = {"kind": "comfy", "pid": "held-1", "since": time.time()}
        with gpu._lock:
            gpu._line.append(held)
        try:
            pid = "held-1"
            gid = db.create_generation(None, "my template", {}, WF, pid, None)
            with mock.patch.object(main.comfy, "queue_state", return_value={}):
                active = c.get("/api/jobs").json()["active"]
            self.assertEqual([(a["template"], a["status"]) for a in active],
                             [("Making the splat", "running"), ("Speaking", "queued"), ("my template", "queued")])
            self.assertEqual((active[0]["job"], active[0]["progress"], active[1]["job"]), ("abc", 0.5, "def"))
            self.assertTrue(all(a["line"] for a in active))
            self.assertEqual(active[2]["id"], gid)
            self.assertIsNone(active[0].get("prompt_id"))
        finally:
            gpu.drop({"held-1"})
            db.update_generation(gid, status="done")
            first.go.set(); waiting.go.set()
            first.done.wait(5); waiting.done.wait(5)


if __name__ == "__main__":
    unittest.main()
