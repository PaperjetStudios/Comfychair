#!/usr/bin/env bash
# Install the boot services: the "ComfyUI" GRUB entry (systemd.unit=comfyui.target) then starts
# ComfyUI and ComfyDeck with no desktop. Run with:  sudo bash deploy/install-services.sh
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run this with sudo."; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST=/etc/systemd/system
STAMP="$(date +%Y%m%d-%H%M%S)"

install -D -m 0755 "$HERE/wait-for-models" /usr/local/lib/comfydeck/wait-for-models
rm -f /usr/local/lib/comfydeck/wait-for-mount
for f in comfyui.service comfyui.target comfydeck.service; do
    [[ -f "$DEST/$f" ]] && cp "$DEST/$f" "$DEST/$f.bak-$STAMP" && echo "backed up $DEST/$f -> $f.bak-$STAMP"
    install -m 0644 "$HERE/$f" "$DEST/$f"
    echo "installed $DEST/$f"
done
systemd-analyze verify "$DEST/comfyui.target" "$DEST/comfyui.service" "$DEST/comfydeck.service"
systemctl daemon-reload
echo
echo "Done. Next boot from the ComfyUI GRUB entry starts both. To switch now without rebooting:"
echo "  sudo systemctl isolate comfyui.target      (closes the desktop session)"
