"""The top bar's PC meter (app/meters.py): CPU from /proc/stat, RAM from /proc/meminfo, the card from nvidia-smi.
Run: DECK_DATA=$(mktemp -d) .venv/bin/python -m pytest -q tests/test_meters.py"""
from app import meters


def test_cpu_is_the_busy_share_between_two_readings():
    a = meters.cpu_times("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3 4\n")
    b = meters.cpu_times("cpu  200 0 200 750 150 0 0 0 0 0\n")
    assert a == (800, 1000) and b == (900, 1300)
    assert meters.cpu_percent(a, b) == 66.7
    assert meters.cpu_percent(None, b) is None


def test_ram_is_what_is_not_available():
    assert meters.ram_percent("MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 250 kB\n") == 75.0
    assert meters.ram_percent("") is None


def test_the_card_line():
    r = meters.gpu_line("42, 6144, 12282, 60\n")
    assert r["gpu"] == 42 and r["vram"] == 50.0 and r["temp_c"] == 60 and r["temp"] == 50.0
    assert meters.gpu_line("")["gpu"] is None   # (no nvidia-smi: nothing, not an error)


def test_a_reading_has_every_line():
    r = meters.reading()
    assert {"cpu", "ram", "gpu", "vram", "temp"} <= set(r)
