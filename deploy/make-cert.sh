#!/usr/bin/env bash
# Make a local HTTPS certificate for ComfyDeck with plain openssl (no mkcert needed).
#
# HTTPS lets the tablet keep the screen on during runs (Wake Lock), show "done" notifications and
# install ComfyDeck as a proper app. It creates, in certs/:
#   comfydeck-ca.crt   a private certificate authority: install this ONE file on each tablet
#   deck.pem, deck-key.pem   the server certificate for this box's IPs and hostname
#
# Re-run it after the box's IP changes: the CA is kept, so tablets don't need it again.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p certs
cd certs

if [ ! -f comfydeck-ca.key ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256 \
    -keyout comfydeck-ca.key -out comfydeck-ca.crt -subj "/CN=ComfyDeck local CA" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
  chmod 600 comfydeck-ca.key
  echo "Made a new local CA: certs/comfydeck-ca.crt"
fi

HOST=$(hostname)
SAN="DNS:localhost,DNS:${HOST},DNS:${HOST}.local,IP:127.0.0.1"
for ip in $(hostname -I 2>/dev/null); do
  [[ "$ip" == *:* ]] && continue   # skip IPv6
  SAN="${SAN},IP:${ip}"
done

openssl req -newkey rsa:2048 -nodes -keyout deck-key.pem -out deck.csr -subj "/CN=${HOST}" 2>/dev/null
# phones and tablets reject server certificates valid for more than ~13 months
openssl x509 -req -in deck.csr -CA comfydeck-ca.crt -CAkey comfydeck-ca.key -CAcreateserial \
  -out deck.pem -days 397 -sha256 \
  -extfile <(printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n" "$SAN") 2>/dev/null
rm -f deck.csr
chmod 600 deck-key.pem

cat <<EOF
Server certificate for: ${SAN//,/ }

Next:
 1. Put certs/comfydeck-ca.crt on the tablet (e.g. download it from a shared folder or email it).
    iPad:    open it, Settings > General > VPN & Device Management > install it, then
             Settings > General > About > Certificate Trust Settings > switch it on.
    Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate.
 2. Start ComfyDeck with HTTPS:
      SSL_CERT=certs/deck.pem SSL_KEY=certs/deck-key.pem ./run.sh
    or for the service, add to deploy/comfydeck.service under [Service]:
      Environment=SSL_CERT=/home/kb/Programs/comfydeck/certs/deck.pem
      Environment=SSL_KEY=/home/kb/Programs/comfydeck/certs/deck-key.pem
 3. Open https://<this box's IP>:8190 on the tablet and add it to the home screen again.
EOF
