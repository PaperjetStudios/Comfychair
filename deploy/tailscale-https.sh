#!/usr/bin/env bash
# HTTPS for ComfyChair through Tailscale: a real, trusted certificate for this box's tailnet name
# (https://<box>.<tailnet>.ts.net), renewed by Tailscale, with nothing to install on the tablet but
# the Tailscale app. Over HTTPS the tablet installs ComfyChair as an app (Chrome ⋮ → Install app),
# keeps the screen on with the real wake-lock and shows "done" notifications.
#
#   deploy/tailscale-https.sh            # ComfyChair on :8190 → https://<box>.<tailnet>.ts.net
#   deploy/tailscale-https.sh 8191 8443  # a second copy on :8191 → https://<box>.<tailnet>.ts.net:8443
#   deploy/tailscale-https.sh off        # stop serving
#
# Once, before the first run:
#   1. curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up
#   2. In the admin console (https://login.tailscale.com/admin/dns): turn on MagicDNS and HTTPS Certificates.
#   3. On the tablet: install Tailscale from the Play Store and sign in with the same account.
# `tailscale serve --bg` is kept by Tailscale across reboots, so this only needs running again to change it.
set -euo pipefail

command -v tailscale >/dev/null || { echo "Tailscale isn't installed: curl -fsSL https://tailscale.com/install.sh | sh"; exit 1; }
tailscale status >/dev/null 2>&1 || { echo "Tailscale isn't connected: sudo tailscale up"; exit 1; }

if [[ "${1:-}" == "off" ]]; then
  sudo tailscale serve reset
  echo "Stopped serving ComfyChair over Tailscale."
  exit 0
fi

PORT="${1:-8190}"      # where ComfyChair listens on this box
HTTPS="${2:-443}"      # the tailnet port it's served on

# this box's tailnet name, e.g. comfybox.tail1234.ts.net (without the trailing dot)
NAME=$(tailscale status --json | python3 -c 'import json, sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')
[[ -n "$NAME" && "$NAME" == *.ts.net ]] || { echo "No tailnet name: turn on MagicDNS in the admin console"; exit 1; }

curl -fsS -m 3 "http://127.0.0.1:${PORT}/api/status" >/dev/null || echo "(ComfyChair isn't answering on :${PORT} yet; serving anyway)"
sudo tailscale serve --bg --https="${HTTPS}" "http://127.0.0.1:${PORT}"

URL="https://${NAME}$([[ "$HTTPS" == 443 ]] || echo ":${HTTPS}")"
cat <<EOF

ComfyChair on :${PORT} is at ${URL}
The first visit can take a few seconds while Tailscale gets the certificate.

On the Android tablet (Tailscale connected):
  1. Open ${URL} in Chrome.
  2. ⋮ menu → Install app (or Add to Home screen → Install).
  3. Open it from the home screen: full screen, no browser bars.

The plain http://<box-ip>:${PORT} address keeps working on the LAN alongside it.
EOF
