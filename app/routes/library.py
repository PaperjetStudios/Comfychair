"""Library endpoints."""
import asyncio
from fastapi import APIRouter, Body, HTTPException
from .. import db
from .. import projects
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


def _clean_target(project_id) -> int | None:
    """The project a clean-up is for (none: Unsorted); not one being copied, whose files are on their way."""
    pid = int(project_id) if project_id not in (None, "", "null") else None
    if pid is not None and not any(p["id"] == pid for p in db.list_projects()):
        raise HTTPException(404, "No such project")
    if pid in projects._busy_ids():
        raise HTTPException(409, "That project is being copied: wait for the copy to finish")
    return pid


@router.get("/api/storage/unused")
async def storage_unused_list(project_id: str = ""):
    """What this project no longer uses (storage.project_unused). Nothing is deleted."""
    return await asyncio.to_thread(storage.project_unused, _clean_target(project_id))


@router.post("/api/storage/unused")
async def storage_unused_drop(body: dict = Body(...)):
    """Delete these items of the list above; what something uses by now stays (storage.drop_unused)."""
    pid = _clean_target(body.get("project_id"))
    r = await asyncio.to_thread(storage.drop_unused, pid, body.get("ids") or [])
    from ..main import broadcast   # (main imports this module)
    for name in r["pictures"]:
        await broadcast({"type": "deck_input_deleted", "data": {"name": name}})
    return {"count": r["count"], "freed": r["freed"]}
