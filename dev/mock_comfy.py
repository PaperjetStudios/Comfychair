"""A fake ComfyUI for working on ComfyDeck's UI without a GPU.

    python dev/mock_comfy.py --port 8199 [--animated]
    COMFY_URL=http://127.0.0.1:8199 ./run.sh

It implements just enough of the API (object_info, prompt, ws progress + binary previews,
history, view, upload, interrupt). --animated also emits VHS-style animated preview frames.
"""
import argparse
import asyncio
import io
import json
import math
import struct
import time
import uuid

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response
from PIL import Image, ImageDraw

app = FastAPI()
sockets: dict[str, WebSocket] = {}
history: dict[str, dict] = {}
files: dict[tuple[str, str, str], bytes] = {}
queue: asyncio.Queue = asyncio.Queue()
interrupted = {"flag": False}
pending: dict[str, int] = {}  # prompt_id -> queue number, for GET /queue
cancelled: set[str] = set()
running = {"pid": None}
counter = {"n": 0}
ANIMATED = {"on": False}

OBJECT_INFO = {
    "CheckpointLoaderSimple": {"input": {"required": {"ckpt_name": [["sd_xl_base_1.0.safetensors", "juggernautXL.safetensors"]]}}},
    "LoraLoader": {"input": {"required": {
        "model": ["MODEL"], "clip": ["CLIP"],
        "lora_name": [["detail_tweaker.safetensors", "film_grain.safetensors", "char_kb.safetensors"]],
        "strength_model": ["FLOAT", {"default": 1.0, "min": -100, "max": 100, "step": 0.01}],
        "strength_clip": ["FLOAT", {"default": 1.0, "min": -100, "max": 100, "step": 0.01}]}}},
    "CLIPTextEncode": {"input": {"required": {"text": ["STRING", {"multiline": True}], "clip": ["CLIP"]}}},
    "EmptyLatentImage": {"input": {"required": {
        "width": ["INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}],
        "height": ["INT", {"default": 1024, "min": 16, "max": 16384, "step": 8}],
        "batch_size": ["INT", {"default": 1, "min": 1, "max": 4096}]}}},
    "KSampler": {"input": {"required": {
        "model": ["MODEL"],
        "seed": ["INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True}],
        "steps": ["INT", {"default": 20, "min": 1, "max": 10000}],
        "cfg": ["FLOAT", {"default": 8.0, "min": 0.0, "max": 100.0, "step": 0.1, "round": 0.01}],
        "sampler_name": [["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "uni_pc"]],
        "scheduler": [["normal", "karras", "simple", "beta"]],
        "positive": ["CONDITIONING"], "negative": ["CONDITIONING"], "latent_image": ["LATENT"],
        "denoise": ["FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}]}}},
    "VAEDecode": {"input": {"required": {"samples": ["LATENT"], "vae": ["VAE"]}}},
    "SaveImage": {"input": {"required": {"images": ["IMAGE"], "filename_prefix": ["STRING", {"default": "ComfyUI"}]}}},
    "LoadImage": {"input": {"required": {"image": [["example.png"], {"image_upload": True}]}}},
}


PROMPTS: list = []
LENIENT = {"on": False}


def frame(seed: int, step: int, steps: int, w=320, h=320, t=0.0, label="") -> Image.Image:
    im = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(im)
    k = step / max(1, steps)
    for y in range(0, h, 8):
        c = int(127 + 127 * math.sin(y / 30 + seed % 97 + t * 2))
        d.rectangle([0, y, w, y + 8], fill=(c, int(c * k), 255 - c))
    d.ellipse([w * .3 + 40 * math.sin(t * 3), h * .3, w * .7 + 40 * math.sin(t * 3), h * .7], outline="white", width=4)
    d.text((10, 10), f"{label} step {step}/{steps}", fill="white")
    return im


def jpeg(im) -> bytes:
    b = io.BytesIO()
    im.save(b, "JPEG", quality=70)
    return b.getvalue()


async def send(cid, obj):
    ws = sockets.get(cid)
    if ws:
        try:
            if isinstance(obj, bytes):
                await ws.send_bytes(obj)
            else:
                await ws.send_text(json.dumps(obj))
        except Exception:
            pass


async def broadcast_status():
    for cid in list(sockets):
        await send(cid, {"type": "status", "data": {"status": {"exec_info": {"queue_remaining": queue.qsize()}}}})


async def worker():
    while True:
        pid, prompt, cid = await queue.get()
        if pid in cancelled:  # deleted from the queue while waiting
            cancelled.discard(pid)
            pending.pop(pid, None)
            continue
        pending.pop(pid, None)
        running["pid"] = pid
        interrupted["flag"] = False
        await send(cid, {"type": "execution_start", "data": {"prompt_id": pid}})
        sampler = next((k for k, v in prompt.items() if v["class_type"] == "KSampler"), None)
        steps = int(prompt[sampler]["inputs"]["steps"]) if sampler else 10
        seed = int(prompt[sampler]["inputs"]["seed"]) if sampler else 0
        for nid in prompt:
            await send(cid, {"type": "executing", "data": {"node": nid, "prompt_id": pid}})
            if nid == sampler:
                if ANIMATED["on"]:
                    await send(cid, {"type": "VHS_latentpreview", "data": {"length": 12, "rate": 12, "id": nid}})
                for s in range(1, steps + 1):
                    if interrupted["flag"]:
                        break
                    await send(cid, {"type": "progress", "data": {"value": s, "max": steps, "node": nid, "prompt_id": pid}})
                    n = 12 if ANIMATED["on"] else 1
                    for fi in range(n):
                        await send(cid, struct.pack(">II", 1, 1) + jpeg(frame(seed, s, steps, t=fi / 12, label=f"f{fi}")))
                    await asyncio.sleep(0.15)
            await asyncio.sleep(0.02)
            if interrupted["flag"]:
                break
        if interrupted["flag"]:
            await send(cid, {"type": "execution_interrupted", "data": {"prompt_id": pid}})
            history[pid] = {"status": {"status_str": "error", "completed": False, "messages": []}, "outputs": {}}
        else:
            name = f"img_{pid[:8]}.png"
            b = io.BytesIO()
            frame(seed, steps, steps, 768, 768, label="final").save(b, "PNG")
            files[(name, "comfydeck", "output")] = b.getvalue()
            out = {"images": [{"filename": name, "subfolder": "comfydeck", "type": "output"}]}
            history[pid] = {"status": {"status_str": "success", "completed": True, "messages": []}, "outputs": {"9": out}}
            await send(cid, {"type": "executed", "data": {"node": "9", "output": out, "prompt_id": pid}})
            await send(cid, {"type": "execution_success", "data": {"prompt_id": pid}})
        running["pid"] = None
        await send(cid, {"type": "executing", "data": {"node": None, "prompt_id": pid}})
        await broadcast_status()


@app.on_event("startup")
async def startup():
    asyncio.create_task(worker())


@app.get("/_prompts")
async def sent_prompts():
    return PROMPTS


@app.get("/object_info")
async def object_info():
    return OBJECT_INFO


@app.get("/object_info/{name}")
async def object_info_one(name: str):  # ComfyDeck lists input images through /object_info/LoadImage
    return {name: OBJECT_INFO[name]} if name in OBJECT_INFO else {}


@app.post("/prompt")
async def prompt(body: dict):
    p = body["prompt"]
    PROMPTS.append(p)   # GET /_prompts: what the deck sent
    errors = {nid: {"class_type": n["class_type"], "errors": [{"message": "Node type not found"}]}
              for nid, n in p.items() if n["class_type"] not in OBJECT_INFO and not LENIENT["on"]}
    if errors:
        return Response(json.dumps({"error": {"message": "Prompt outputs failed validation"}, "node_errors": errors}),
                        status_code=400, media_type="application/json")
    pid = str(uuid.uuid4())
    counter["n"] += 1
    pending[pid] = counter["n"]
    await queue.put((pid, p, body.get("client_id")))
    await broadcast_status()
    return {"prompt_id": pid, "number": queue.qsize(), "node_errors": {}}


@app.get("/history/{pid}")
async def get_history(pid: str):
    return {pid: history[pid]} if pid in history else {}


@app.get("/view")
async def view(filename: str, subfolder: str = "", type: str = "output"):
    data = files.get((filename, subfolder, type))
    if data is None:
        return Response(status_code=404)
    return Response(data, media_type="image/png")


@app.post("/upload/image")
async def upload(image: UploadFile = File(...), subfolder: str = Form(""), type: str = Form("input"), overwrite: str = Form("false")):
    files[(image.filename, subfolder, "input")] = await image.read()
    return {"name": image.filename, "subfolder": subfolder, "type": "input"}


@app.post("/interrupt")
async def interrupt():
    interrupted["flag"] = True
    return {}


@app.get("/queue")
async def get_queue():  # same shape as ComfyUI: [number, prompt_id, ...]
    run = [[0, running["pid"], {}, {}, []]] if running["pid"] else []
    return {"queue_running": run, "queue_pending": [[n, pid, {}, {}, []] for pid, n in pending.items()]}


@app.post("/queue")
async def post_queue(body: dict):
    for pid in body.get("delete", []):
        if pid in pending:
            cancelled.add(pid)
            pending.pop(pid, None)
    await broadcast_status()
    return {}


@app.websocket("/ws")
async def ws(websocket: WebSocket, clientId: str = ""):
    await websocket.accept()
    cid = clientId or uuid.uuid4().hex
    sockets[cid] = websocket
    await send(cid, {"type": "status", "data": {"status": {"exec_info": {"queue_remaining": queue.qsize()}}, "sid": cid}})
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        sockets.pop(cid, None)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8199)
    ap.add_argument("--animated", action="store_true", help="emit VHS-style animated previews")
    ap.add_argument("--lenient", action="store_true", help="queue workflows with node types it doesn't know (e.g. VHS), and list them at /_prompts")
    a = ap.parse_args()
    LENIENT["on"] = a.lenient
    ANIMATED["on"] = a.animated
    uvicorn.run(app, host="127.0.0.1", port=a.port, log_level="warning")
