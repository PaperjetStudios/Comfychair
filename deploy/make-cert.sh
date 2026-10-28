#!/usr/bin/env bash
# Make a local HTTPS certificate for ComfyChair with plain openssl (no mkcert needed).
#
# HTTPS lets the tablet keep the screen on during runs (Wake Lock), show "done" notifications and
# install ComfyChair as a proper app. It creates, in certs/:
#   comfydeck-ca.crt   a private certificate authority: install this ONE file on each tablet
#   deck.pem, deck-key.pem   the server certificate for this box's IPs and hostname
#
# Re-run it after the box's IP changes: the CA is kept, so tablets don't need it again.
# deploy/local-https.sh runs it for you and turns HTTPS on in the boot services.
#
#   deploy/make-cert.sh --if-needed   only if the certificate is missing, expires within 30 days, or
#                                     doesn't cover this box's IPs now (the services run this at start)
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
cd certs

IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v ':' | grep . || true)   # (IPv4 only)
if [[ "${1:-}" == "--if-needed" ]]; then
  [[ -f comfydeck-ca.key ]] || exit 0   # (no local CA: HTTPS was never set up this way)
  if [[ -f deck.pem ]] && openssl x509 -in deck.pem -noout -checkend 2592000 >/dev/null; then
    have=$(openssl x509 -in deck.pem -noout -text)
    missing=0
    for ip in $IPS; do grep -q "IP Address:${ip}\b" <<<"$have" || missing=1; done
    [[ $missing == 0 ]] && exit 0
  fi
  QUIET=1
fi

if [ ! -f comfydeck-ca.key ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256 \
    -keyout comfydeck-ca.key -out comfydeck-ca.crt -subj "/CN=ComfyChair local CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  chmod 600 comfydeck-ca.key
  echo "Made a new local CA: certs/comfydeck-ca.crt"
fi

HOST=$(hostname)
SAN="DNS:localhost,DNS:${HOST},DNS:${HOST}.local,IP:127.0.0.1"
for ip in $IPS; do SAN="${SAN},IP:${ip}"; done

openssl req -newkey rsa:2048 -nodes -keyout deck-key.pem -out deck.csr -subj "/CN=${HOST}" 2>/dev/null
# phones and tablets reject server certificates valid for more than ~13 months
openssl x509 -req -in deck.csr -CA comfydeck-ca.crt -CAkey comfydeck-ca.key -CAcreateserial \
  -out deck.pem -days 397 -sha256 \
  -extfile <(printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n" "$SAN") 2>/dev/null
rm -f deck.csr
chmod 600 deck-key.pem

if [[ -n "${QUIET:-}" ]]; then echo "ComfyChair: new HTTPS certificate for ${SAN//,/ }"; exit 0; fi
cat <<EOF
Server certificate for: ${SAN//,/ }

Next: deploy/local-https.sh turns HTTPS on for ComfyChair (and the Lab) and hands the tablet
certs/comfydeck-ca.crt. Or by hand:
  SSL_CERT=certs/deck.pem SSL_KEY=certs/deck-key.pem ./run.sh
and install certs/comfydeck-ca.crt on the tablet:
  Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate.
  iPad:    open it, Settings > General > VPN & Device Management > install it, then
           Settings > General > About > Certificate Trust Settings > switch it on.
EOF
