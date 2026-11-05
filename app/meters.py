"""The PC's load at a glance for the top bar's meter: CPU, RAM, GPU, VRAM and GPU temperature, each 0-100.

CPU comes from /proc/stat (the change since the last reading), RAM from /proc/meminfo, the card from nvidia-smi.
A reading is kept for a second, so several open pages don't each start nvidia-smi. Anything that can't be read is None.
"""
import subprocess
import time

TEMP_LOW, TEMP_HIGH = 30.0, 90.0   # °C shown as an empty and a full line
_last_cpu: tuple[int, int] | None = None
_cache: tuple[float, dict] | None = None


def cpu_times(text: str) -> tuple[int, int] | None:
    """(idle, total) jiffies from /proc/stat's first line."""
    for line in text.splitlines():
        if line.startswith("cpu "):
            v = [int(x) for x in line.split()[1:]]
            idle = v[3] + (v[4] if len(v) > 4 else 0)   # idle + iowait
            return idle, sum(v)
    return None


def cpu_percent(before: tuple[int, int] | None, now: tuple[int, int] | None) -> float | None:
    if not before or not now or now[1] <= before[1]:
        return None
    return round(100.0 * (1 - (now[0] - before[0]) / (now[1] - before[1])), 1)


def ram_percent(text: str) -> float | None:
    kb = {}
    for line in text.splitlines():
        k, _, rest = line.partition(":")
        if rest.split():
            kb[k] = int(rest.split()[0])
    if not kb.get("MemTotal") or "MemAvailable" not in kb:
        return None
    return round(100.0 * (1 - kb["MemAvailable"] / kb["MemTotal"]), 1)


def gpu_line(text: str) -> dict:
    """nvidia-smi's utilization.gpu, memory.used, memory.total, temperature.gpu (csv, no units) for the first card."""
    try:
        util, used, total, temp = (float(x) for x in text.strip().splitlines()[0].split(","))
    except (ValueError, IndexError):
        return {"gpu": None, "vram": None, "temp": None, "temp_c": None}
    t = max(0.0, min(100.0, 100.0 * (temp - TEMP_LOW) / (TEMP_HIGH - TEMP_LOW)))
    return {"gpu": util, "vram": round(100.0 * used / total, 1) if total else None, "temp": round(t, 1), "temp_c": temp,
            "vram_used_mb": used, "vram_total_mb": total}


def _read(path: str) -> str:
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def reading() -> dict:
    global _last_cpu, _cache
    now = time.monotonic()
    if _cache and now - _cache[0] < 1.0:
        return _cache[1]
    cpu_now = cpu_times(_read("/proc/stat"))
    if _last_cpu is None:   # (the first reading: a tenth of a second's worth, so it isn't blank)
        _last_cpu = cpu_now
        time.sleep(0.1)
        cpu_now = cpu_times(_read("/proc/stat"))
    out = {"cpu": cpu_percent(_last_cpu, cpu_now), "ram": ram_percent(_read("/proc/meminfo"))}
    _last_cpu = cpu_now
    try:
        smi = subprocess.run(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=3).stdout
    except (OSError, subprocess.SubprocessError):
        smi = ""
    out.update(gpu_line(smi))
    _cache = (now, out)
    return out
