"""Dependencies shared by feature routers, wired once by the application."""
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable
from ..comfy import Comfy


@dataclass(frozen=True)
class RouteServices:
    comfy: Comfy
    output_file: Callable[[dict, dict], Path]
    new_output: Callable[[dict, str], tuple[Path, str]]
    push_gen: Callable[[int], Awaitable[None]]
    upload_prepared: Callable[..., Awaitable[str]]
    input_bytes: Callable[[str], Awaitable[bytes]]
    timeline_path: Callable[[dict, Path | None], Awaitable[tuple[Path, str]]]
    media_entry: Callable[[Path], dict]
    project: Callable[[object], int | None]
    object_info_or_none: Callable[..., Awaitable[dict | None]]
