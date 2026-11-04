"""A run of its own that empties the card, queued right before a run that needs all of it (app/comfy.py free_card). It runs in
ComfyUI's queue, on its one execution thread, so it comes exactly between the runs either side and no worker is in use.

ComfyUI's own POST /free applies once, after whatever job is running when it arrives, so it can't sit between queued runs."""
import comfy.model_management as mm
from server import PromptServer


def stop_workers() -> int:
    """SAM3, UniRig and the like run in processes of their own (comfy_env), which keep their graphics memory until ComfyUI
    restarts and which unload_all_models can't reach. Each starts again by itself when next needed. How many were stopped."""
    n = 0
    try:
        from comfy_env.isolation import wrap
        for key in list(wrap._WORKER_POOL):
            wrap._cleanup_stale_patchers(key)
            wrap._remove_worker(key)
            n += 1
    except Exception as e:
        print(f"[DeckFreeVRAM] Couldn't stop the idle workers: {e}", flush=True)
    return n


class DeckFreeVRAM:
    CATEGORY = "ComfyChair"
    FUNCTION = "free"
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"nonce": ("STRING", {"default": ""})}}   # (each one differs, so it's never answered from the cache)

    def free(self, nonce):
        mm.unload_all_models()   # (first: unloading a worker's model talks to its worker, and would start a stopped one again)
        stopped = stop_workers()
        mm.soft_empty_cache()
        # the queue's flag clears ComfyUI's stored node results too, as soon as this job ends and before the next one starts
        PromptServer.instance.prompt_queue.set_flag("free_memory", True)
        print(f"[DeckFreeVRAM] Models unloaded, {stopped} idle worker(s) stopped", flush=True)
        return ()


NODE_CLASS_MAPPINGS = {"DeckFreeVRAM": DeckFreeVRAM}
NODE_DISPLAY_NAME_MAPPINGS = {"DeckFreeVRAM": "Free VRAM (ComfyChair)"}
