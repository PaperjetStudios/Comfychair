#!/usr/bin/env bash
# Start ComfyChair. First run creates a virtualenv and installs dependencies.
#
#   COMFY_URL=http://127.0.0.1:8188   where ComfyUI is running (default)
#   DECK_HOST=0.0.0.0 DECK_PORT=8190  where ComfyChair listens (default: all interfaces, 8190)
#   SSL_CERT=... SSL_KEY=...          optional HTTPS (enables screen wake-lock + PWA install on tablets)
set -euo pipefail
cd "$(dirname "$0")"

# Started by hand while it's already running: open the running one instead of failing on the busy port. Only in a
# terminal: a service or a background start keeps uvicorn's error, so its failure still shows.
if [ -t 1 ]; then
  for scheme in https http; do
    running="$scheme://localhost:${DECK_PORT:-8190}"
    if curl -fsk -m 2 "$running/api/status" 2>/dev/null | grep -q '"ui_version"'; then
      echo "ComfyChair is already running: $running"
      if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then xdg-open "$running" >/dev/null 2>&1 || true; fi
      exit 0
    fi
  done
fi

if [ ! -x .venv/bin/uvicorn ]; then
  echo "Setting up virtualenv…"
  python3 -m venv .venv || { echo "Install venv support first: sudo apt install python3-venv"; exit 1; }
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -r requirements.txt
fi

HOST="${DECK_HOST:-0.0.0.0}"
PORT="${DECK_PORT:-8190}"
ARGS=()
if [[ -n "${SSL_CERT:-}" && -n "${SSL_KEY:-}" ]]; then
  ARGS+=(--ssl-certfile "$SSL_CERT" --ssl-keyfile "$SSL_KEY")
  SCHEME=https
else
  SCHEME=http
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo "ComfyChair → ${SCHEME}://${IP:-localhost}:${PORT}   (ComfyUI: ${COMFY_URL:-http://127.0.0.1:8188})"
exec .venv/bin/uvicorn app.main:app --host "$HOST" --port "$PORT" "${ARGS[@]}"
