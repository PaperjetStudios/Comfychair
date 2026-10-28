#!/usr/bin/env bash
# Free HTTPS for ComfyChair (and ComfyChair Lab) on your own network: no account, no service, no internet.
# This box makes its own certificate (deploy/make-cert.sh); the tablet trusts it once you install one small
# file on it, comfydeck-ca.crt. Over HTTPS the tablet installs ComfyChair as an app, keeps the screen on
# with the real wake-lock and shows "done" notifications. Everything here works from the text console.
#
#   deploy/local-https.sh        # turn it on: certificate, boot services on HTTPS, then hand the tablet the file
#   deploy/local-https.sh ca     # just hand the tablet the file again (another tablet, a reset one)
#   deploy/local-https.sh off    # back to plain http
#
# It stays on across reboots: the services start on HTTPS, and at each start they renew the certificate if it
# expires within 30 days or the box's IP has changed (the tablet keeps trusting it: the file it has doesn't
# change). Give the box a fixed IP in your router (a "DHCP reservation") so the tablet's address stays the same.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=$(pwd)
D=/etc/systemd/system
CA_PORT=8000
IP=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v ':' | grep . | head -1 || true)

restart() {
  sudo systemctl daemon-reload
  for u in comfydeck comfydeck-lab; do
    systemctl cat "$u.service" >/dev/null 2>&1 && sudo systemctl restart "$u.service" && echo "restarted $u"
  done
  true
}

# the CA certificate (the public half only: the key never leaves certs/), for the tablet to download once
serve_ca() {
  local tmp; tmp=$(mktemp -d)
  cp certs/comfydeck-ca.crt "$tmp/"
  cat <<EOF

On the tablet (on the same Wi-Fi as this box):
  1. In Chrome, open   http://${IP:-<box-ip>}:${CA_PORT}/comfydeck-ca.crt   (it downloads the file)
  2. Settings > Security (and privacy) > More security settings > Encryption & credentials >
     Install a certificate > CA certificate > Install anyway > pick comfydeck-ca.crt from Downloads.
     (The names vary by maker: search Settings for "CA certificate". Android asks for a screen lock first.)
  3. Open   https://${IP:-<box-ip>}:8190   in Chrome, then ⋮ > Install app.
     ComfyChair Lab, if it's set up: https://${IP:-<box-ip>}:8191, then ⋮ > Install app again.
     (An app installed from the old http:// address is a different app: remove it.)

Serving the file for 15 minutes (Ctrl+C once the tablet has it)…
EOF
  timeout 900 python3 -m http.server "$CA_PORT" --bind 0.0.0.0 --directory "$tmp" 2>/dev/null || true
  rm -rf "$tmp"
  echo "Stopped serving the file."
}

case "${1:-on}" in
  off)
    sudo rm -f "$D/comfydeck.service.d/https.conf" "$D/comfydeck-lab.service.d/https.conf"
    restart
    echo "ComfyChair is back on plain http://${IP:-<box-ip>}:8190"
    ;;
  ca)
    [[ -f certs/comfydeck-ca.crt ]] || { echo "No certificate yet: run deploy/local-https.sh first"; exit 1; }
    serve_ca
    ;;
  on)
    command -v openssl >/dev/null || { echo "openssl is missing: sudo apt install openssl"; exit 1; }
    deploy/make-cert.sh >/dev/null
    deploy/make-cert.sh --if-needed   # (a no-op now: just checks it covers this box's IPs)
    # Drop-ins, so the units themselves (deploy/install-services.sh, deploy/lab.sh) stay as they are.
    # ComfyChair renews the certificate as it starts; the Lab starts after it and uses the same one.
    sudo mkdir -p "$D/comfydeck.service.d" "$D/comfydeck-lab.service.d"
    sudo tee "$D/comfydeck.service.d/https.conf" >/dev/null <<EOF
# HTTPS with this box's own certificate (deploy/local-https.sh)
[Service]
Environment=SSL_CERT=$REPO/certs/deck.pem
Environment=SSL_KEY=$REPO/certs/deck-key.pem
ExecStartPre=-$REPO/deploy/make-cert.sh --if-needed
EOF
    sudo tee "$D/comfydeck-lab.service.d/https.conf" >/dev/null <<EOF
# HTTPS with ComfyChair's certificate (deploy/local-https.sh)
[Unit]
After=comfydeck.service
[Service]
Environment=SSL_CERT=$REPO/certs/deck.pem
Environment=SSL_KEY=$REPO/certs/deck-key.pem
EOF
    restart
    sleep 3
    if curl -fsS -m 3 --cacert certs/comfydeck-ca.crt "https://${IP:-127.0.0.1}:8190/api/status" >/dev/null 2>&1 \
       || curl -fsS -m 3 -k "https://127.0.0.1:8190/api/status" >/dev/null 2>&1; then
      echo "ComfyChair answers on https://${IP:-<box-ip>}:8190"
    else
      echo "ComfyChair isn't answering on HTTPS yet: journalctl -u comfydeck -n 50"
    fi
    serve_ca
    ;;
  *) echo "usage: deploy/local-https.sh [on|ca|off]"; exit 1 ;;
esac
