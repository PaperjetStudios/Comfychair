"""Library endpoints."""
import asyncio
from fastapi import APIRouter, Body, HTTPException
from .. import db
from .. import storage
from .context import RouteServices

router = APIRouter()
services: RouteServices


def configure(runtime: RouteServices):
    global services
    services = runtime


@router.get("/api/snippets")
async def snippets():
    return db.list_snippets()


@router.post("/api/snippets")
async def save_snippet(body: dict = Body(...)):
    category, text = (body.get("category") or "").strip()[:40], (body.get("text") or "").strip()
    if not category or not text:
        raise HTTPException(400, "category and text required")
    name = (body.get("name") or "").strip()[:80] or " ".join(text.split()[:6])
    return db.save_snippet(category, name, text, body.get("id"))


@router.delete("/api/snippets/{sid}")
async def delete_snippet(sid: int):
    db.delete_snippet(sid)
    return {"ok": True}


@router.get("/api/storage/sweep")
async def storage_sweep_list():
    """What a clean-up would delete (storage.sweep): ComfyUI's leftover copies of ComfyChair's files and old
    thumbnails, with sizes. Nothing is deleted."""
    r = await asyncio.to_thread(storage.sweep)
    return {**r, "items": r["items"][:500]}


@router.post("/api/storage/sweep")
async def storage_sweep():
    """Delete what storage_sweep_list lists (files under ten minutes old and sole copies are left)."""
    r = await asyncio.to_thread(storage.sweep, True)
    return {"count": r["count"], "freed": r["freed"]}
