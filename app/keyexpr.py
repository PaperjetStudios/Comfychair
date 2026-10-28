"""Keyframes for the renders: web/keys.js's sampling in Python, and the same curve as an ffmpeg expression.

A channel's keys are [{"f": time, "v": number, "ease"?: name}] sorted by f (a Video clip's keys are in its
own source time, seconds: web/keyed.js). Before the first key the first value holds, after the last the last
does, and between two keys the value eases with the first key's ease, else the item's (default smooth).
expr() writes that as an ffmpeg expression in a time variable, so a filter that evaluates per frame (overlay
x/y, scale and rotate with eval=frame, volume, geq) follows the keys exactly as the preview does.
"""

EASES = {
    "smooth": lambda t: t * t * (3 - 2 * t),
    "linear": lambda t: t,
    "in": lambda t: t ** 3,
    "out": lambda t: 1 - (1 - t) ** 3,
    "const": lambda t: 0.0,
}
# the same curves in ffmpeg's expression language, of p (0..1 through a segment)
EASE_EXPR = {
    "smooth": "({p})*({p})*(3-2*({p}))",
    "linear": "({p})",
    "in": "pow({p},3)",
    "out": "(1-pow(1-({p}),3))",
    "const": "0",
}


def sample(keys: list[dict], t: float, base: float, ease: str = "smooth") -> float:
    """The value at time t (keys.js sampleKeys, for numbers)."""
    if not keys:
        return base
    if t <= keys[0]["f"]:
        return keys[0]["v"]
    if t >= keys[-1]["f"]:
        return keys[-1]["v"]
    for a, b in zip(keys, keys[1:]):
        if a["f"] <= t < b["f"]:
            e = EASES.get(a.get("ease") or ease, EASES["smooth"])((t - a["f"]) / (b["f"] - a["f"]))
            return a["v"] + (b["v"] - a["v"]) * e
    return keys[-1]["v"]


def expr(keys: list[dict], var: str, ease: str = "smooth", scale: float = 1.0, offset: float = 0.0) -> str:
    """The keys' curve as an ffmpeg expression in var (e.g. "(t+1.5)"), times scale plus offset. Commas are
    escaped (\\,) so it can sit inside a filter option."""
    def val(v):
        return f"{v * scale + offset:.6g}"
    if not keys:
        raise ValueError("no keys")
    out = val(keys[-1]["v"])
    for a, b in reversed(list(zip(keys, keys[1:]))):
        p = f"(({var})-{a['f']:.6g})/{b['f'] - a['f']:.6g}"
        e = EASE_EXPR.get(a.get("ease") or ease, EASE_EXPR["smooth"]).format(p=p)
        seg = f"{val(a['v'])}+({val(b['v']) }-{val(a['v'])})*{e}" if scale else val(a["v"])
        out = f"if(lt({var},{b['f']:.6g}),{seg},{out})"
    out = f"if(lt({var},{keys[0]['f']:.6g}),{val(keys[0]['v'])},{out})"
    return out.replace(",", "\\,")


def keyed(it: dict, ch: str) -> list[dict] | None:
    """A clip's keys for one channel, sorted, or None when it has none."""
    ks = ((it.get("chans") or {}).get(ch)) or None
    return sorted(ks, key=lambda k: k["f"]) if ks else None


def with_track(chans, level: float = 1.0, pan: float = 0.0) -> dict | None:
    """A Sound clip's level and pan keys with its track's level (times) and pan (plus) on them, as the mix hears
    them; only well-formed keys are kept."""
    if not isinstance(chans, dict):
        return None
    out = {}
    for ch, f in (("volume", lambda v: max(0.0, v * level)), ("pan", lambda v: max(-1.0, min(1.0, v + pan)))):
        ks = chans.get(ch)
        if isinstance(ks, list):
            ks = [{"f": float(k["f"]), "v": f(float(k["v"])), **({"ease": k["ease"]} if k.get("ease") in EASES else {})}
                  for k in ks if isinstance(k, dict) and "f" in k and "v" in k]
            if ks:
                out[ch] = ks
    return out or None


def span(keys: list[dict] | None, base: float) -> tuple[float, float]:
    """The lowest and highest the channel gets (eases stay between their keys' values)."""
    vs = [k["v"] for k in keys] if keys else [base]
    return min(vs), max(vs)
