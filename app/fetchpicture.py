"""A picture dragged in from another browser window can arrive as only its link, and the browser can't read another
site's picture itself (CORS). This fetches it and hands the bytes straight back: nothing is written here, the page
uploads them like any other picture."""
import asyncio
import io
import ipaddress
import socket
from urllib.parse import urljoin, urlsplit

import httpx
from PIL import Image
from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import Response

router = APIRouter(prefix="/api")

TRANSPORT = None          # tests put an httpx.MockTransport here
MAX_BYTES = 200 << 20     # the same limit as an uploaded image
MAX_HOPS = 5
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def public_host(host: str) -> bool:
    """Every address the name resolves to is on the public internet, so a link can't reach into this machine or LAN."""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False
    return bool(infos) and all(_public(i[4][0]) for i in infos)


def _public(ip: str) -> bool:
    a = ipaddress.ip_address(ip.split("%")[0])
    return (getattr(a, "ipv4_mapped", None) or a).is_global


async def _get(url: str) -> bytes:
    """The bytes at url. Redirects are followed by hand so every hop's address is checked."""
    async with httpx.AsyncClient(transport=TRANSPORT, timeout=httpx.Timeout(30, connect=10)) as client:
        for _ in range(MAX_HOPS + 1):
            parts = urlsplit(url)
            if parts.scheme not in ("http", "https") or not parts.hostname:
                raise HTTPException(400, "That link isn't a web address")
            if not await asyncio.to_thread(public_host, parts.hostname):
                raise HTTPException(400, "That picture isn't on a public site: save it, then drop the file")
            # (some sites only serve a picture to their own pages)
            headers = {"User-Agent": UA, "Accept": "image/*,*/*;q=0.8", "Referer": f"{parts.scheme}://{parts.netloc}/"}
            async with client.stream("GET", url, headers=headers) as r:
                if r.is_redirect and r.headers.get("location"):
                    url = urljoin(url, r.headers["location"])
                    continue
                if r.status_code != 200:
                    raise HTTPException(502, f"The site wouldn't give the picture ({r.status_code}): save it, then drop the file")
                data = bytearray()
                async for chunk in r.aiter_bytes():
                    data += chunk
                    if len(data) > MAX_BYTES:
                        raise HTTPException(413, f"That picture is over {MAX_BYTES >> 20} MB")
                return bytes(data)
    raise HTTPException(502, "That link redirects too many times")


@router.post("/fetch-picture")
async def fetch_picture(body: dict = Body(...)):
    """{url} -> the picture's bytes."""
    try:
        data = await _get(str(body.get("url") or "").strip())
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Couldn't reach that site: {e}")
    try:
        fmt = Image.open(io.BytesIO(data)).format
    except Exception:
        raise HTTPException(400, "That link isn't a picture")
    return Response(data, media_type=Image.MIME.get(fmt, "application/octet-stream"))
