#!/usr/bin/env bash
# Start ComfyChair in this terminal (HTTPS, port 8190) and open it in the browser. For the desktop shortcut
# (~/Desktop/comfydeck.desktop). If it's already running (the service, or another window), only opens the browser.
set -uo pipefail

DECK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${DECK_PORT:-8190}"
URL="https://localhost:$PORT"

up() { ss -ltn "sport = :$PORT" | grep -q LISTEN; }

if up; then
    echo "ComfyChair is already running: opening $URL"
    xdg-open "$URL" >/dev/null 2>&1 &
    sleep 1
    exit 0
fi

# Keep the window open if it exits or crashes, so errors stay readable.
trap 'echo; echo "ComfyChair exited."; [[ -t 0 ]] && read -rp "Press Enter to close..."' EXIT

cd "$DECK_DIR"
"$DECK_DIR/deploy/make-cert.sh" --if-needed || true
export COMFY_URL="${COMFY_URL:-http://127.0.0.1:8188}"
export SSL_CERT="$DECK_DIR/certs/deck.pem" SSL_KEY="$DECK_DIR/certs/deck-key.pem"

# open the browser once it's listening (up to a minute: the first run installs the virtualenv)
( for _ in $(seq 120); do up && { xdg-open "$URL" >/dev/null 2>&1; exit; }; sleep 0.5; done ) &

echo "Close this window (or Ctrl+C) to stop ComfyChair."
"$DECK_DIR/run.sh"
