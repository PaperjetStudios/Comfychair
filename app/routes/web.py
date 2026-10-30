"""App shell, versioned ES modules and static assets."""
import json
import os
import re
from html import escape
from fastapi import APIRouter, FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from .. import config

router = APIRouter()


def ui_version() -> int:
    """Newest change to the UI's files: an open (installed) app compares it with what it loaded
    and offers a reload when they differ."""
    return int(max(f.stat().st_mtime for f in config.WEB_DIR.rglob("*") if f.is_file()))


class AppFiles(StaticFiles):
    """The UI's own files: the browser must check back every time (a cheap 304 when nothing
    changed). Without this, tablets keep an old app.js for hours after an update."""

    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        r.headers["Cache-Control"] = "no-cache"
        return r


APP_NAME = os.environ.get("DECK_NAME", "ComfyChair")   # a second copy (another port) installs as its own app by this name


@router.get("/manifest.webmanifest", include_in_schema=False)
async def manifest():
    """The PWA manifest with this copy's name (DECK_NAME), so two copies on one box are two home-screen apps."""
    m = json.loads((config.WEB_DIR / "manifest.webmanifest").read_text(encoding="utf-8"))
    m["name"] = m["short_name"] = APP_NAME
    return Response(json.dumps(m), media_type="application/manifest+json", headers={"Cache-Control": "no-cache"})


@router.get("/", include_in_schema=False)
@router.get("/index.html", include_in_schema=False)
async def index():
    """index.html with app.js / app.css links that change whenever the UI's files do, so a copy cached
    by an older version can't be reused. app.js gets the newest change over all web/ files, because
    the modules it imports (see module_js) are versioned the same way."""
    html = (config.WEB_DIR / "index.html").read_text(encoding="utf-8")
    if APP_NAME != "ComfyChair":
        html = html.replace("<title>ComfyChair</title>", f"<title>{escape(APP_NAME)}</title>")
    html = html.replace('"app.js"', f'"app.js?v={ui_version()}"')
    v = ui_version()
    html = html.replace('"app.css"', f'"app.css?v={v}"')
    return Response(html, media_type="text/html", headers={"Cache-Control": "no-cache"})


# './x.js' in `from './x.js'` and `import('./x.js')` (not ./vendor/…: those never change)
_JS_IMPORT = re.compile(r"""(\bfrom\s*|\bimport\s*(?:\(\s*)?)(['"])(\./[\w-]+\.js)\2""")
_module_cache: dict[tuple[str, int], str] = {}


@router.get("/{name}.js", include_in_schema=False)
async def module_js(name: str, request: Request):
    """The UI's ES modules (web/*.js) with every relative import carrying ?v=<ui_version>: a change to
    any one of them gives all of them new URLs, so the browser never mixes old and new modules (or
    keeps a stale one) however it caches. ETag/304 keeps unchanged loads cheap."""
    path = config.WEB_DIR / f"{name}.js"
    if "/" in name or not path.is_file():
        raise HTTPException(404)
    # a module asked for at a version keeps its imports at that version: a page opened before an update that
    # loads a module late (a dynamic import) would otherwise import the newer URLs of modules it already has,
    # and run a second copy of each (a second Editor tool strip, a second core.js state). The page is offered
    # a reload when the UI is newer (run.js checkUiVersion).
    asked = request.query_params.get("v", "")
    v = int(asked) if asked.isdigit() else ui_version()
    etag = f'"{name}-{v}"'
    headers = {"Cache-Control": "no-cache", "ETag": etag}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    text = _module_cache.get((name, v))
    if text is None:
        text = _JS_IMPORT.sub(lambda m: f"{m[1]}{m[2]}{m[3]}?v={v}{m[2]}", path.read_text(encoding="utf-8"))
        if len(_module_cache) > 400:   # (pages on older versions ask too: keep a few versions' worth)
            _module_cache.clear()
        _module_cache[(name, v)] = text
    return Response(text, media_type="text/javascript", headers=headers)


def install(app: FastAPI):
    """Mount last, after API routers, so the static fallback cannot shadow endpoints."""
    app.include_router(router)
    app.mount("/files/projects", StaticFiles(directory=config.PROJECTS_DIR), name="projects")
    app.mount("/files/library", StaticFiles(directory=config.LIBRARY_DIR), name="library")
    app.mount("/files/media", StaticFiles(directory=config.MEDIA_DIR), name="media")
    app.mount("/files/generations", StaticFiles(directory=config.GEN_DIR), name="generations")


    app.mount("/", AppFiles(directory=config.WEB_DIR, html=True), name="web")
