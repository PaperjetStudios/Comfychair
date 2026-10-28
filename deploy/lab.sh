#!/usr/bin/env bash
# ComfyChair Lab: the experimental copy (branch `lab`), beside the ComfyChair you use, as its own app.
# It's a second checkout of this repo (a git worktree) next to this one, on port 8191 with its own data
# (its own projects and History), so trying things there never touches your real work.
#
# It boots the way ComfyChair does: the "ComfyUI" GRUB entry starts comfyui.target (terminal only, no
# desktop), which starts ComfyUI, ComfyChair and, once this has installed it, ComfyChair Lab.
#
#   deploy/lab.sh            # make or update the Lab checkout and (re)start its service (comfydeck-lab)
#   deploy/lab.sh https      # also serve it over Tailscale HTTPS on :8443, to install it on the tablet
#   deploy/lab.sh run        # just run it in this terminal instead (Ctrl+C stops it)
#   deploy/lab.sh off        # stop it and take it out of the boot
#
#   LAB_DIR=…  where the checkout goes (default: next to this one, <this>-lab)
#   LAB_PORT=8191 LAB_HTTPS=8443   DECK_DATA=…  (point it at this copy's data/ to share its History)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
LAB_DIR="${LAB_DIR:-${REPO}-lab}"
LAB_PORT="${LAB_PORT:-8191}"
LAB_HTTPS="${LAB_HTTPS:-8443}"
UNIT=/etc/systemd/system/comfydeck-lab.service
DROPIN=/etc/systemd/system/comfyui.target.d/lab.conf

if [[ "${1:-}" == "off" ]]; then
  sudo systemctl stop comfydeck-lab.service 2>/dev/null || true
  sudo rm -f "$DROPIN" "$UNIT"
  sudo systemctl daemon-reload
  echo "ComfyChair Lab stopped and out of the boot (its checkout and data stay in $LAB_DIR)."
  exit 0
fi

# ---- the checkout: the lab branch, fast-forwarded to what's on GitHub ----
git fetch -q origin lab
if [[ -e "$LAB_DIR/.git" ]]; then
  git -C "$LAB_DIR" merge -q --ff-only origin/lab || { echo "The Lab checkout ($LAB_DIR) has its own changes: update it by hand"; exit 1; }
else
  git worktree add -q -B lab "$LAB_DIR" origin/lab
fi
echo "Lab checkout: $LAB_DIR ($(git -C "$LAB_DIR" log -1 --format='%h %s'))"

# its own virtualenv, made now (not on its first boot, when it would wait on pip)
if [[ ! -x "$LAB_DIR/.venv/bin/uvicorn" ]] || ! cmp -s "$LAB_DIR/requirements.txt" "$LAB_DIR/.venv/requirements.txt"; then
  echo "Setting up its virtualenv…"
  [[ -x "$LAB_DIR/.venv/bin/python" ]] || python3 -m venv "$LAB_DIR/.venv"
  "$LAB_DIR/.venv/bin/pip" install -q --upgrade pip
  "$LAB_DIR/.venv/bin/pip" install -q -r "$LAB_DIR/requirements.txt"
  cp "$LAB_DIR/requirements.txt" "$LAB_DIR/.venv/requirements.txt"
fi

case "${1:-service}" in
  run)
    cd "$LAB_DIR"
    DECK_PORT="$LAB_PORT" DECK_NAME="ComfyChair Lab" exec ./run.sh
    ;;
  service|https)
    # The unit is ComfyChair's own (deploy/comfydeck.service: its user, its wait for /home, its restarts),
    # pointed at the Lab checkout, port and name, so the two always boot the same way.
    sed -e "s#^Description=.*#Description=ComfyChair Lab (the experimental copy, branch lab)#" \
        -e "s#^WorkingDirectory=.*#WorkingDirectory=$LAB_DIR#" \
        -e "s#^ExecStart=.*#Environment=DECK_PORT=$LAB_PORT\nEnvironment=\"DECK_NAME=ComfyChair Lab\"${DECK_DATA:+\nEnvironment=DECK_DATA=$DECK_DATA}\nExecStart=$LAB_DIR/run.sh#" \
        -e "s#^User=.*#User=$(id -un)#" -e "s#^Group=.*#Group=$(id -gn)#" \
        "$REPO/deploy/comfydeck.service" | sudo tee "$UNIT" >/dev/null
    # comfyui.target (the terminal-only boot) starts it along with ComfyChair; a drop-in, so reinstalling
    # the boot services (deploy/install-services.sh) keeps it
    sudo mkdir -p "$(dirname "$DROPIN")"
    printf '[Unit]\nWants=comfydeck-lab.service\n' | sudo tee "$DROPIN" >/dev/null
    sudo systemd-analyze verify "$UNIT" 2>&1 | grep -v "^$" || true
    sudo systemctl daemon-reload
    sudo systemctl restart comfydeck-lab.service
    for _ in $(seq 30); do curl -fsS -m 2 "http://127.0.0.1:$LAB_PORT/api/status" >/dev/null 2>&1 && break; sleep 1; done
    if curl -fsS -m 2 "http://127.0.0.1:$LAB_PORT/api/status" >/dev/null 2>&1; then
      echo "ComfyChair Lab is running on :$LAB_PORT, and starts with ComfyUI and ComfyChair at every boot."
    else
      echo "ComfyChair Lab didn't answer on :$LAB_PORT yet: journalctl -u comfydeck-lab -n 50"
    fi
    [[ "${1:-service}" == https ]] && "$REPO/deploy/tailscale-https.sh" "$LAB_PORT" "$LAB_HTTPS"
    ;;
  *) echo "usage: deploy/lab.sh [service|https|run|off]"; exit 1 ;;
esac
