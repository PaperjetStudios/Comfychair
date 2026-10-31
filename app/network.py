"""How to reach ComfyChair: the addresses it answers on, the certificate that covers them, and the CA a tablet installs."""
import json
import os
import re
import socket
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, Response

from . import config

router = APIRouter(prefix="/api/network")

CERTS_DIR = config.BASE_DIR / "certs"
SKIP_IFACE = ("lo", "docker", "br-", "veth", "tailscale")


def _run(cmd: list[str], timeout: float = 3.0) -> str | None:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout if r.returncode == 0 else None
    except Exception:
        return None


def _lan() -> list[tuple[str, str]]:
    """(iface, ip) for every real IPv4 interface."""
    out = _run(["ip", "-4", "-j", "addr"])
    found = []
    try:
        for ifc in json.loads(out or "[]"):
            name = ifc.get("ifname", "")
            if name.startswith(SKIP_IFACE):
                continue
            for a in ifc.get("addr_info", []):
                if a.get("family") == "inet" and a.get("local"):
                    found.append((name, a["local"]))
    except Exception:
        pass
    return found


def _tailscale() -> dict | None:
    out = _run(["tailscale", "status", "--json"])
    try:
        d = json.loads(out or "")
        me = d.get("Self") or {}
        ips = [i for i in me.get("TailscaleIPs", []) if "." in i]
        return {"state": d.get("BackendState") or "", "ip": ips[0] if ips else None,
                "dns": (me.get("DNSName") or "").rstrip(".") or None}
    except Exception:
        return None


def _cert() -> dict | None:
    path = CERTS_DIR / "deck.pem"
    out = _run(["openssl", "x509", "-in", str(path), "-noout", "-text", "-enddate"])
    if not out:
        return None
    sans = re.findall(r"(?:IP Address|DNS):\s*([^\s,]+)", out)
    expires = None
    m = re.search(r"notAfter=(.+)", out)
    if m:
        try:
            expires = datetime.strptime(m.group(1).strip(), "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc).isoformat()
        except ValueError:
            pass
    return {"sans": sans, "expires": expires, "covers": True}


def _scheme_port(request: Request) -> tuple[str, int]:
    scheme = "https" if os.environ.get("SSL_CERT") and os.environ.get("SSL_KEY") else request.url.scheme
    try:
        port = int(os.environ.get("DECK_PORT") or request.url.port or 8190)   # (run.sh's default port)
    except ValueError:
        port = request.url.port or 8190
    return scheme, port


def info(request: Request) -> dict:
    scheme, port = _scheme_port(request)
    host = socket.gethostname()
    url = lambda h: f"{scheme}://{h}:{port}"
    addresses = [{"url": url(ip), "ip": ip, "iface": ifc, "kind": "lan"} for ifc, ip in _lan()]
    ts = _tailscale()
    ts_out = None
    if ts:
        ts_out = {**ts, "url": url(ts["dns"] or ts["ip"]) if ts["state"] == "Running" and (ts["dns"] or ts["ip"]) else None}
        if ts["state"] == "Running" and ts["ip"]:
            addresses.append({"url": url(ts["ip"]), "ip": ts["ip"], "iface": "tailscale", "kind": "tailscale"})
    addresses.append({"url": url(f"{host}.local"), "ip": None, "iface": "", "kind": "mdns"})
    cert = _cert() if scheme == "https" else None
    if cert:
        want = [a["ip"] for a in addresses if a["kind"] in ("lan", "tailscale")]
        cert["covers"] = all(ip in cert["sans"] for ip in want)
    return {"scheme": scheme, "port": port, "hostname": host, "addresses": addresses, "tailscale": ts_out,
            "cert": cert, "ca": (CERTS_DIR / "comfydeck-ca.crt").is_file()}


@router.get("")
def network(request: Request):
    return info(request)


@router.get("/ca")
def ca():
    path = CERTS_DIR / "comfydeck-ca.crt"
    if not path.is_file():
        raise HTTPException(404, "No CA certificate on this server")
    return FileResponse(path, media_type="application/x-x509-ca-cert", filename="comfydeck-ca.crt")


@router.get("/qr.svg")
def qr(request: Request, url: str = ""):
    if url not in {a["url"] for a in info(request)["addresses"]}:
        raise HTTPException(400, "Not one of this server's addresses")
    import segno
    svg = segno.make(url, error="m").svg_inline(scale=6, dark="#000", light="#fff", border=2)
    return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": "no-store"})
