#!/usr/bin/env bash
# ComfyChair Lab: the experimental copy (branch `lab`), run beside the one you use, as its own app.
# It's a second checkout of this repo (a git worktree) next to this one, on port 8191 with its own data
# (its own projects and History), so trying things there never touches your real work.
#
#   deploy/lab.sh            # make or update the Lab checkout, then run it (Ctrl+C stops it)
#   deploy/lab.sh https      # …and serve it over Tailscale HTTPS on :8443, to install it on the tablet
#   deploy/lab.sh service    # run it as a systemd service instead (starts at boot, like ComfyChair)
#
#   LAB_DIR=…  where the checkout goes (default: next to this one, <this>-lab)
#   LAB_PORT=8191 LAB_HTTPS=8443 DECK_DATA=…  (point DECK_DATA at this copy's data/ to share its History)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
LAB_DIR="${LAB_DIR:-${REPO}-lab}"
LAB_PORT="${LAB_PORT:-8191}"
LAB_HTTPS="${LAB_HTTPS:-8443}"

git fetch -q origin lab
if [[ -d "$LAB_DIR/.git" || -f "$LAB_DIR/.git" ]]; then
  git -C "$LAB_DIR" merge -q --ff-only origin/lab || { echo "The Lab checkout ($LAB_DIR) has its own changes: update it by hand"; exit 1; }
else
  git worktree add -q -B lab "$LAB_DIR" origin/lab
fi
echo "Lab checkout: $LAB_DIR ($(git -C "$LAB_DIR" log -1 --format='%h %s'))"

case "${1:-run}" in
  https)
    "$REPO/deploy/tailscale-https.sh" "$LAB_PORT" "$LAB_HTTPS"
    ;;
  service)
    UNIT=/etc/systemd/system/comfydeck-lab.service
    sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=ComfyChair Lab (the experimental copy)
Wants=network-online.target
After=network-online.target comfyui.service

[Service]
User=$(id -un)
Group=$(id -gn)
WorkingDirectory=$LAB_DIR
Environment=COMFY_URL=${COMFY_URL:-http://127.0.0.1:8188}
Environment=DECK_PORT=$LAB_PORT
Environment="DECK_NAME=ComfyChair Lab"
${DECK_DATA:+Environment=DECK_DATA=$DECK_DATA}
ExecStart=$LAB_DIR/run.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now comfydeck-lab.service
    sudo systemctl restart comfydeck-lab.service
    echo "ComfyChair Lab runs as comfydeck-lab.service on :$LAB_PORT (journalctl -u comfydeck-lab -f)"
    ;;
  run)
    cd "$LAB_DIR"
    DECK_PORT="$LAB_PORT" DECK_NAME="ComfyChair Lab" exec ./run.sh
    ;;
  *) echo "usage: deploy/lab.sh [run|https|service]"; exit 1 ;;
esac
