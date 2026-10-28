"""Civitai: find LoRAs for a model family and download them into ComfyUI's LoRA folder for that family.

The API key (optional for most LoRAs, needed for some and for early-access ones) is kept on the server only, in
data/secrets.json (mode 600). It is never sent back to a browser and never written to a log: requests carry it in
an Authorization header (not ?token=), and any error text that could hold it is scrubbed.

Search proxies civitai.com/api/v1/models (types=LORA, the family's base models, cursor paging) and returns compact
cards. A download runs as a clip-importer job (GET /api/clip/job/{id} polls it): the file streams into
<loras root>/<family>/ as .part and is renamed when complete, with <file>.civitai.json beside it (ids, trained
words, preview, base model) so the app can show trigger words and mark the version as downloaded."""
import asyncio
import hashlib
import json
import os
import re
import time
from pathlib import Path

import httpx
from fastapi import APIRouter, Body, HTTPException

from . import clipimport, config

router = APIRouter(prefix="/api/civitai")

API = "https://civitai.com/api/v1"
SECRETS = config.DATA_DIR / "secrets.json"
TRANSPORT = None              # tests put an httpx.MockTransport here
MAX_BYTES = 4 * 1024 ** 3     # bigger files need {confirm: true}
SIDECAR = ".civitai.json"
PAGE = 24

# The app's LoRA folders (ComfyUI models/loras/<folder>) -> Civitai baseModel names, as the live API spells them
# (2026-10-28). The first list is searched by default; "more" are related bases the browser can switch on.
BASES = {
    "h3": (["MiniMax H3"], []),
    "krea": (["Krea 2"], []),
    "klein": (["Flux.2 Klein 9B", "Flux.2 Klein 9B-base"], ["Flux.2 Klein 4B", "Flux.2 Klein 4B-base"]),
    "qwen": (["Qwen 2.1"], ["Qwen"]),
    "moss": (["MOSS Image"], []),
    "ltx2.5": (["LTXV 2.5"], ["LTXV 2.3"]),
    "ltx2.3": (["LTXV 2.3"], ["LTXV 2.5", "LTXV2"]),
    "ltx": (["LTXV 2.5", "LTXV 2.3"], ["LTXV2", "LTXV"]),
    "flux": (["Flux.1 D"], ["Flux.1 Kontext", "Flux.2 D"]),
    "wan": (["Wan Video 14B t2v", "Wan Video 14B i2v 720p"], []),
}
SORTS = {"rated": "Highest Rated", "downloads": "Most Downloaded", "newest": "Newest"}


def bases_for(family: str) -> tuple[list[str], list[str]]:
    """A LoRA folder name -> (default base models, more). Exact name first, then the longest known prefix
    (ltx2.4 -> ltx), else none (the search falls back to a text query)."""
    f = (family or "").strip().lower()
    if f in BASES:
        return list(BASES[f][0]), list(BASES[f][1])
    for k in sorted(BASES, key=len, reverse=True):
        if f.startswith(k):
            return list(BASES[k][0]), list(BASES[k][1])
    return [], []


# ---- the key ------------------------------------------------------------------------------------------------
def _secrets() -> dict:
    try:
        return json.loads(SECRETS.read_text())
    except (OSError, ValueError):
        return {}


def _save_secrets(d: dict):
    tmp = SECRETS.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(d, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, SECRETS)


def get_key() -> str:
    return (_secrets().get("civitai") or {}).get("key") or ""


def scrub(text, key: str | None = None) -> str:
    """Error text with the key (and any ?token=...) taken out."""
    s = str(text)
    for k in {key, get_key()} - {None, ""}:
        s = s.replace(k, "***")
    return re.sub(r"(token=)[^&\s'\"]+", r"\1***", s)


def _headers(key: str | None = None) -> dict:
    key = get_key() if key is None else key
    h = {"User-Agent": "ComfyChair"}
    if key:
        h["Authorization"] = f"Bearer {key}"
    return h


def _client(timeout=30.0, **kw) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=TRANSPORT, timeout=timeout, follow_redirects=True, **kw)


@router.get("/key")
async def key_status():
    c = _secrets().get("civitai") or {}
    return {"set": bool(c.get("key")), "user": c.get("user") if c.get("key") else None}


@router.put("/key")
async def key_set(body: dict = Body(...)):
    key = str(body.get("key") or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9_\-.]{16,200}", key):
        raise HTTPException(400, "That doesn't look like a Civitai API key")
    try:
        async with _client() as c:
            r = await c.get(f"{API}/me", headers=_headers(key))
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Couldn't reach Civitai to check the key: {scrub(e, key)}")
    if r.status_code in (401, 403):
        raise HTTPException(400, "Civitai didn't accept that key")
    if r.status_code >= 400:
        raise HTTPException(502, f"Civitai answered {r.status_code} while checking the key")
    try:
        me = r.json()
    except ValueError:
        me = {}
    user = (me.get("username") or me.get("name") or "") if isinstance(me, dict) else ""
    d = _secrets()
    d["civitai"] = {"key": key, "user": user, "t": time.time()}
    _save_secrets(d)
    return {"set": True, "user": user or None}


@router.delete("/key")
async def key_delete():
    d = _secrets()
    if d.pop("civitai", None) is not None:
        _save_secrets(d)
    return {"set": False, "user": None}


# ---- where LoRAs go -----------------------------------------------------------------------------------------
def _comfy_dir() -> Path | None:
    if config.COMFY_DIR:
        return config.COMFY_DIR
    p = config.BASE_DIR.parent / "ComfyUI"
    return p if p.is_dir() else None


def lora_roots() -> list[Path]:
    """Every folder ComfyUI reads LoRAs from, the one new downloads go to first: DECK_LORA_DIR, else the
    extra_model_paths.yaml entries (the data drive), else ComfyUI/models/loras."""
    env = os.environ.get("DECK_LORA_DIR")
    if env:
        return [Path(env).expanduser().resolve()]
    roots: list[Path] = []
    comfy = _comfy_dir()
    if comfy:
        try:
            import yaml
            extra = yaml.safe_load((comfy / "extra_model_paths.yaml").read_text()) or {}
        except Exception:   # no file, or not readable: ComfyUI's own folder only
            extra = {}
        for sec in extra.values() if isinstance(extra, dict) else []:
            if not isinstance(sec, dict) or not sec.get("loras"):
                continue
            base = Path(str(sec.get("base_path") or comfy)).expanduser()
            for line in str(sec["loras"]).splitlines():
                if line.strip():
                    p = Path(line.strip()).expanduser()
                    roots.append(p if p.is_absolute() else base / p)
        roots.append(comfy / "models" / "loras")
    seen, out = set(), []
    for p in roots:
        if p.is_dir() and p.resolve() not in seen:
            seen.add(p.resolve())
            out.append(p.resolve())
    return out


def family_dir(family: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._\-]{0,40}", family or "") or ".." in family:
        raise HTTPException(400, "Pick a model family (LoRA folder) for the download")
    roots = lora_roots()
    if not roots:
        raise HTTPException(500, "ComfyUI's LoRA folder wasn't found (set DECK_LORA_DIR)")
    return roots[0] / family


def safe_filename(name: str) -> str:
    """A Civitai file name -> a plain file name: no folders, no odd characters, ends in .safetensors."""
    base = re.split(r"[\\/]", str(name or ""))[-1]
    base = re.sub(r"[^A-Za-z0-9._\-()+ ]", "_", base)
    stem = re.sub(r"\.safetensors$", "", base, flags=re.I).strip(" .") or "lora"
    stem = re.sub(r"_{2,}", "_", stem)[:150]
    return f"{stem}.safetensors"


def downloaded_index() -> dict:
    """{versionIds: {id: "<folder>/<file>"}, files: {lower-case file name: "<folder>/<file>"}} over every LoRA root."""
    vids, files = {}, {}
    for root in lora_roots():
        for dirpath, _dirs, names in os.walk(root):
            rel = Path(dirpath).relative_to(root)
            for n in names:
                name = (rel / n).as_posix()
                if n.endswith(".safetensors"):
                    files.setdefault(n.lower(), name)
                elif n.endswith(SIDECAR):
                    try:
                        vid = json.loads((Path(dirpath) / n).read_text()).get("versionId")
                    except (OSError, ValueError):
                        continue
                    lora = name[: -len(SIDECAR)]
                    if vid and (Path(dirpath) / n[: -len(SIDECAR)]).exists():
                        vids[int(vid)] = lora
    return {"versionIds": vids, "files": files}


# ---- search -------------------------------------------------------------------------------------------------
def media_url(url: str, params: str) -> str:
    """A Civitai image/video URL at another size: its /<params>/ segment (original=true, width=...) replaced."""
    m = re.match(r"^(https://image\.civitai\.com/[^/]+/[^/]+)/(?:[^/]*=[^/]*/)?([^/]+)$", url or "")
    return f"{m.group(1)}/{params}/{m.group(2)}" if m else url


def _image(i: dict) -> dict:
    video = i.get("type") == "video"
    u = i.get("url") or ""
    return {"url": media_url(u, "transcode=true,width=720" if video else "width=1024"),
            "thumb": media_url(u, "anim=false,transcode=true,width=450" if video else "width=450"),
            "type": "video" if video else "image", "nsfwLevel": i.get("nsfwLevel") or 0,
            "w": i.get("width"), "h": i.get("height")}


def _version(v: dict, have: dict) -> dict:
    files = [{"id": f.get("id"), "name": f.get("name"), "sizeKB": f.get("sizeKB"), "type": f.get("type"),
              "primary": bool(f.get("primary")), "format": (f.get("metadata") or {}).get("format"),
              "safetensors": str(f.get("name") or "").lower().endswith(".safetensors")}
             for f in v.get("files") or [] if f.get("type") in ("Model", None)]
    vid = v.get("id")
    local = have["versionIds"].get(vid)
    if not local:
        for f in files:
            n = safe_filename(f["name"]).lower()
            if f["safetensors"] and n in have["files"]:
                local = have["files"][n]
                break
    return {"id": vid, "name": v.get("name"), "baseModel": v.get("baseModel"), "trainedWords": v.get("trainedWords") or [],
            "earlyAccess": v.get("availability") == "EarlyAccess", "files": files,
            "images": [_image(i) for i in (v.get("images") or [])[:12]], "downloaded": local}


def card(m: dict, bases: list[str], have: dict) -> dict:
    vs = m.get("modelVersions") or []
    fit = [v for v in vs if not bases or v.get("baseModel") in bases]
    stats = m.get("stats") or {}
    return {"id": m.get("id"), "name": m.get("name"), "creator": (m.get("creator") or {}).get("username"),
            "nsfw": bool(m.get("nsfw")), "nsfwLevel": m.get("nsfwLevel") or 0, "tags": (m.get("tags") or [])[:8],
            "stats": {"downloads": stats.get("downloadCount", 0), "likes": stats.get("thumbsUpCount", 0)},
            "link": f"https://civitai.com/models/{m.get('id')}",
            "versions": [_version(v, have) for v in (fit or vs)], "otherVersions": len(vs) - len(fit) if fit else 0}


_cache: dict[str, tuple[float, dict]] = {}


async def _get_json(url: str, params, cache=True) -> dict:
    ck = url + "?" + json.dumps(params, sort_keys=True) + ("#k" if get_key() else "")
    hit = _cache.get(ck)
    if cache and hit and time.time() - hit[0] < 120:
        return hit[1]
    try:
        async with _client() as c:
            r = await c.get(url, params=params, headers=_headers())
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Couldn't reach Civitai: {scrub(e)}")
    if r.status_code in (401, 403):
        raise HTTPException(r.status_code, "Civitai refused: the API key in Settings may be wrong")
    if r.status_code >= 400:
        raise HTTPException(502, f"Civitai answered {r.status_code}: {scrub(r.text[:200])}")
    try:
        data = r.json()
    except ValueError:
        raise HTTPException(502, "Civitai sent something that isn't JSON")
    if len(_cache) > 200:
        _cache.clear()
    _cache[ck] = (time.time(), data)
    return data


@router.get("/families")
async def families():
    return {k: {"bases": v[0], "more": v[1]} for k, v in BASES.items()}


@router.get("/search")
async def search(q: str = "", family: str = "", base: str = "", sort: str = "rated", nsfw: str = "soft", cursor: str = ""):
    bases = [b for b in base.split("|") if b.strip()] if base else bases_for(family)[0]
    params: list[tuple[str, str]] = [("types", "LORA"), ("limit", str(PAGE)), ("sort", SORTS.get(sort, SORTS["rated"]))]
    query = q.strip()
    if bases:
        params += [("baseModels", b) for b in bases]
    elif family and not query:
        query = family   # a family Civitai has no base model for: search its name
    if query:
        params.append(("query", query[:120]))
    if nsfw == "off":
        params.append(("nsfw", "false"))
    if cursor:
        params.append(("cursor", cursor))
    data = await _get_json(f"{API}/models", params)
    have = await asyncio.to_thread(downloaded_index)
    items = [card(m, bases, have) for m in data.get("items") or [] if m.get("type", "LORA") == "LORA"]
    meta = data.get("metadata") or {}
    return {"items": [c for c in items if c["versions"]], "next": meta.get("nextCursor"), "bases": bases,
            "query": query, "keySet": bool(get_key())}


@router.get("/model/{mid}")
async def model(mid: int, family: str = "", base: str = ""):
    bases = [b for b in base.split("|") if b.strip()] if base else bases_for(family)[0]
    m = await _get_json(f"{API}/models/{mid}", [])
    have = await asyncio.to_thread(downloaded_index)
    c = card(m, bases, have)
    c["description"] = (m.get("description") or "")[:20000]
    return c


# ---- download -----------------------------------------------------------------------------------------------
def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _same(p: Path, size: int | None, sha: str | None) -> bool:
    if not p.exists():
        return False
    if size and abs(p.stat().st_size - size) > 1024:
        return False
    return not sha or _sha256(p).lower() == sha.lower()


def _refused(status: int, early: bool) -> str:
    if early:
        return "This version is in early access on Civitai: it can only be downloaded after buying access there"
    if status == 401 or not get_key():
        return "Civitai needs an API key for this download: add yours in Settings (Civitai)"
    return "Civitai refused the download (403): it may be early access, or need you to accept its terms on civitai.com"


def _download(job: dict, url: str, dest: Path, size: int | None, early: bool, meta: dict) -> dict:
    """Stream url into dest via dest.part. Runs in the job's thread."""
    key = get_key()
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    try:
        with httpx.Client(transport=TRANSPORT, timeout=httpx.Timeout(60.0, read=120.0), follow_redirects=True) as c:
            with c.stream("GET", url, headers=_headers(key)) as r:
                if r.status_code in (401, 403):
                    raise RuntimeError(_refused(r.status_code, early))
                if r.status_code >= 400:
                    raise RuntimeError(f"Civitai answered {r.status_code} for the download")
                if "text/html" in r.headers.get("content-type", ""):
                    raise RuntimeError(_refused(401, early))   # a login page, not the file
                total = int(r.headers.get("content-length") or 0) or size or 0
                if total > MAX_BYTES and not meta.get("_confirm"):
                    raise RuntimeError("The file is bigger than 4 GB")
                got = 0
                with part.open("wb") as f:
                    for chunk in r.iter_bytes(1 << 20):
                        if job["cancel"]:
                            raise RuntimeError("Cancelled")
                        f.write(chunk)
                        got += len(chunk)
                        if total:
                            job["progress"] = min(0.99, got / total)
                if total and got < total:
                    raise RuntimeError(f"The download stopped early ({got} of {total} bytes)")
        with part.open("rb") as f:   # a safetensors file starts with its header length, then "{"
            head = f.read(9)
        if len(head) < 9 or head[8:9] != b"{":
            raise RuntimeError("What Civitai sent isn't a .safetensors file")
        os.replace(part, dest)
    except httpx.HTTPError as e:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"Download failed: {scrub(e, key)}") from None
    except Exception as e:
        part.unlink(missing_ok=True)
        raise RuntimeError(scrub(e, key)) from None
    return _finish(dest, meta, skipped=False)


def _finish(dest: Path, meta: dict, skipped: bool) -> dict:
    side = {k: v for k, v in meta.items() if not k.startswith("_")}
    side["file"] = dest.name
    side["downloaded"] = time.time()
    (dest.parent / (dest.name + SIDECAR)).write_text(json.dumps(side, indent=1))
    return {"name": f"{dest.parent.name}/{dest.name}", "file": dest.name, "family": dest.parent.name,
            "trainedWords": meta.get("trainedWords") or [], "skipped": skipped, "modelName": meta.get("modelName")}


@router.post("/download")
async def download(body: dict = Body(...)):
    try:
        vid = int(body.get("versionId"))
    except (TypeError, ValueError):
        raise HTTPException(400, "Which version?")
    folder = family_dir(str(body.get("family") or ""))
    v = await _get_json(f"{API}/model-versions/{vid}", [], cache=False)
    files = [f for f in v.get("files") or [] if f.get("type") in ("Model", None)]
    fid = body.get("fileId")
    f = next((x for x in files if fid is not None and x.get("id") == int(fid)), None) if fid else None
    f = f or next((x for x in files if x.get("primary")), None) or (files[0] if files else None)
    if not f:
        raise HTTPException(404, "That version has no model file")
    if not str(f.get("name") or "").lower().endswith(".safetensors"):
        raise HTTPException(400, f"Only .safetensors files are downloaded ({f.get('name')} isn't one)")
    size = int(round((f.get("sizeKB") or 0) * 1024)) or None
    if size and size > MAX_BYTES and not body.get("confirm"):
        raise HTTPException(409, {"message": f"{f.get('name')} is {size / 1024 ** 3:.1f} GB. Download it anyway?",
                                  "needsConfirm": True, "sizeKB": f.get("sizeKB")})
    url = f.get("downloadUrl") or v.get("downloadUrl")
    if not url or not url.startswith("https://civitai.com/"):
        raise HTTPException(400, "Civitai gave no download link for that file")
    model = v.get("model") or {}
    imgs = [i for i in v.get("images") or [] if i.get("type") != "video"] or v.get("images") or []
    meta = {"source": "civitai", "modelId": v.get("modelId"), "versionId": vid, "fileId": f.get("id"),
            "modelName": model.get("name"), "versionName": v.get("name"), "baseModel": v.get("baseModel"),
            "trainedWords": v.get("trainedWords") or [], "sha256": (f.get("hashes") or {}).get("SHA256"),
            "preview": media_url(imgs[0]["url"], "width=450") if imgs else None,
            "link": f"https://civitai.com/models/{v.get('modelId')}?modelVersionId={vid}",
            "_confirm": bool(body.get("confirm"))}
    early = v.get("availability") == "EarlyAccess"
    name = safe_filename(f.get("name"))
    dest = folder / name

    def work(job):
        if _same(dest, size, meta["sha256"]):
            return _finish(dest, meta, skipped=True)
        d = dest
        if d.exists():   # another file of the same name: keep both
            d = folder / f"{d.stem}_v{vid}.safetensors"
            if _same(d, size, meta["sha256"]):
                return _finish(d, meta, skipped=True)
        return _download(job, url, d, size, early, meta)

    return clipimport._start(work, f"Downloading {model.get('name') or name}")
