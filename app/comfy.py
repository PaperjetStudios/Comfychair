"""Thin async client for the ComfyUI HTTP + websocket API."""
import asyncio
import json
import logging
import uuid

import httpx
import websockets

from . import config

log = logging.getLogger("comfydeck.comfy")

VIDEO_NODES = ("VHS_VideoCombine", "SaveVideo", "CreateVideo", "SaveWEBM", "SaveAnimatedWEBP")


def is_video(workflow: dict) -> bool:
    return any(n.get("class_type", "") in VIDEO_NODES or n.get("class_type", "").startswith("MiniMaxH3")
               for n in workflow.values())


class ComfyError(Exception):
    def __init__(self, payload):
        self.payload = payload
        super().__init__(format_error(payload))


def format_error(j) -> str:
    """Turn ComfyUI's /prompt validation error JSON into readable text."""
    if not isinstance(j, dict):
        return str(j)
    parts = []
    e = j.get("error")
    if isinstance(e, dict):
        msg = e.get("message", "")
        if e.get("details"):
            msg += f": {e['details']}"
        parts.append(msg)
    elif e:
        parts.append(str(e))
    for nid, ne in (j.get("node_errors") or {}).items():
        for err in ne.get("errors", []):
            parts.append(
                f"Node {nid} ({ne.get('class_type', '?')}): {err.get('message', '')} {err.get('details', '')}".strip()
            )
    return "\n".join(p for p in parts if p) or json.dumps(j)


def _client_id() -> str:
    """ComfyUI sends a job's live previews only to the client id that queued it, so keep one id across
    restarts: jobs queued before a restart still preview afterwards."""
    path = config.DATA_DIR / "comfy_client_id"
    try:
        cid = path.read_text().strip()
        if cid:
            return cid
    except OSError:
        pass
    cid = uuid.uuid4().hex
    path.write_text(cid)
    return cid


class Comfy:
    def __init__(self, base_url: str):
        self.base = base_url
        self.client_id = _client_id()
        self.http = httpx.AsyncClient(base_url=base_url, timeout=httpx.Timeout(120, connect=5))
        self.listeners = set()  # async callables(kind: "text"|"binary", payload)
        self.connected = False
        self._object_info = None
        self._task = None
        self._ws = None
        self._last_msg = 0.0  # loop time of the last websocket message
        self._checks = set()

    # ---- lifecycle -------------------------------------------------------
    async def start(self):
        self._task = asyncio.create_task(self._ws_loop())

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        await self.http.aclose()

    async def _ws_loop(self):
        scheme_swapped = self.base.replace("https://", "wss://", 1).replace("http://", "ws://", 1)
        ws_url = f"{scheme_swapped}/ws?clientId={self.client_id}"
        while True:
            try:
                async with websockets.connect(ws_url, max_size=None, ping_interval=20) as ws:
                    self._ws = ws
                    self.connected = True
                    log.info("Connected to ComfyUI websocket at %s", ws_url)
                    await self._emit("text", {"type": "deck_comfy_status", "data": {"connected": True}})
                    async for msg in ws:
                        self._last_msg = asyncio.get_running_loop().time()
                        if isinstance(msg, (bytes, bytearray)):
                            await self._emit("binary", bytes(msg))
                        else:
                            try:
                                data = json.loads(msg)
                            except ValueError:
                                continue
                            await self._emit("text", data)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # connection refused, dropped, etc.
                if self.connected:
                    log.warning("ComfyUI websocket lost: %s", e)
                self.connected = False
                self._object_info = None
                await self._emit("text", {"type": "deck_comfy_status", "data": {"connected": False}})
                await asyncio.sleep(3)
            else:
                self.connected = False
                await asyncio.sleep(1)
            finally:
                self._ws = None

    async def _check_listening(self, since: float):
        """ComfyUI forgets a client id when any socket using it closes (e.g. a second ComfyChair run on
        the same data dir), leaving ours open and answering pings but sent nothing: no progress, no
        previews. Queueing always broadcasts a status message, so if none arrives, reconnect."""
        await asyncio.sleep(5)
        ws = self._ws
        if ws is not None and self._last_msg < since:
            log.warning("ComfyUI websocket went quiet after queueing; reconnecting")
            await ws.close()

    async def _emit(self, kind, payload):
        for cb in list(self.listeners):
            try:
                await cb(kind, payload)
            except Exception:
                log.exception("listener failed")

    # ---- API -------------------------------------------------------------
    async def object_info(self, refresh: bool = False) -> dict:
        if self._object_info is None or refresh:
            r = await self.http.get("/object_info")
            r.raise_for_status()
            self._object_info = r.json()
        return self._object_info

    async def lora_info(self, name: str, fetch: bool = False) -> dict | None:
        """Civitai details for a LoRA via rgthree-comfy's model-info API (fetch=True looks it up
        on civitai.com by the file's hash; otherwise only what rgthree already saved)."""
        path = "/rgthree/api/loras/info/refresh" if fetch else "/rgthree/api/loras/info"
        r = await self.http.get(path, params={"files": name}, timeout=180)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        data = r.json().get("data")
        return (data[0] if isinstance(data, list) and data else data) or None

    async def input_images(self) -> list[str]:
        """Fresh list of images in ComfyUI's input folder (cheap: one node's info, not all of them)."""
        r = await self.http.get("/object_info/LoadImage")
        r.raise_for_status()
        return r.json()["LoadImage"]["input"]["required"]["image"][0]

    async def queue(self, workflow: dict, preview: str | None = None) -> dict:
        # Live sampler previews: ComfyUI sends none unless asked. Images use "taesd" (the tiny
        # decoders in models/vae_approx, else latent2rgb). Video uses latent2rgb with VHS's animated
        # preview switch, read from the workflow extras where the desktop UI puts it: the video TAE
        # decoders don't work inside VHS's animated wrapper and cost more time than the sampling.
        if is_video(workflow) and preview and preview.startswith("sharp"):
            extra = {"preview_method": "taesd"}  # one sharp frame per step from the video TAE
        elif is_video(workflow) and preview == "off":
            extra = {"preview_method": "none"}
        elif is_video(workflow):
            extra = {"preview_method": config.VIDEO_PREVIEW_METHOD,
                     "extra_pnginfo": {"workflow": {"extra": {"VHS_latentpreview": True}}}}
        else:
            extra = {"preview_method": config.PREVIEW_METHOD}
        since = asyncio.get_running_loop().time()
        r = await self.http.post("/prompt", json={"prompt": workflow, "client_id": self.client_id, "extra_data": extra})
        if r.status_code < 400:
            task = asyncio.create_task(self._check_listening(since))
            self._checks.add(task)
            task.add_done_callback(self._checks.discard)
        if r.status_code >= 400:
            try:
                payload = r.json()
            except ValueError:
                payload = r.text
            raise ComfyError(payload)
        return r.json()

    async def history(self, prompt_id: str) -> dict:
        r = await self.http.get(f"/history/{prompt_id}")
        r.raise_for_status()
        return r.json()

    async def view(self, filename: str, subfolder: str = "", type_: str = "output"):
        r = await self.http.get("/view", params={"filename": filename, "subfolder": subfolder, "type": type_})
        r.raise_for_status()
        return r.content, r.headers.get("content-type", "application/octet-stream")

    async def upload_image(self, data: bytes, filename: str, subfolder: str = "") -> str:
        """Upload into ComfyUI's input dir. Returns the name to put in a LoadImage node."""
        r = await self.http.post(
            "/upload/image",
            files={"image": (filename, data, "image/png")},
            data={"overwrite": "true", "type": "input", "subfolder": subfolder},
        )
        r.raise_for_status()
        j = r.json()
        return f"{j['subfolder']}/{j['name']}" if j.get("subfolder") else j["name"]

    async def download(self, filename: str, subfolder: str, type_: str, dest):
        """Save a file from ComfyUI straight to disk, in chunks (videos can be big)."""
        params = {"filename": filename, "subfolder": subfolder, "type": type_}
        async with self.http.stream("GET", "/view", params=params) as r:
            r.raise_for_status()
            with open(dest, "wb") as f:
                async for chunk in r.aiter_bytes(1 << 20):
                    f.write(chunk)

    async def interrupt(self):
        r = await self.http.post("/interrupt")
        r.raise_for_status()

    async def queue_state(self) -> dict:
        r = await self.http.get("/queue")
        r.raise_for_status()
        return r.json()

    async def delete_queued(self, prompt_ids: list[str]):
        r = await self.http.post("/queue", json={"delete": prompt_ids})
        r.raise_for_status()
