#!/usr/bin/env bash
# A test copy of the live data folder for a second ComfyChair, without copying the media.
#
#   dev/clone-data.sh [SRC=/home/kb/Programs/comfydeck/data] [DST=<this checkout>/data-live-clone]
#
# Pictures, clips, models and saved documents are hard links to the live files: no extra disk, made in seconds.
# The database and small state are real copies. Nothing in SRC is written. The test server never changes a linked
# file in place (documents and stills are written to a temp file and renamed, media files are written once), so
# an edit or a delete in the clone leaves the live copy as it is. Thumbnails and temp files are left out (they are
# remade). comfy_client_id is left out on purpose: two servers with one id would take each other's ComfyUI messages.
# An existing DST is moved aside, never deleted. Both folders must be on one filesystem.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
src="${1:-/home/kb/Programs/comfydeck/data}"
dst="${2:-$here/data-live-clone}"
[ -d "$src/projects" ] || { echo "No data folder at $src"; exit 1; }
[ "$(stat -c %d "$src")" = "$(stat -c %d "$(dirname "$dst")")" ] || { echo "$dst is on another filesystem: hard links can't cross"; exit 1; }
if [ -e "$dst" ]; then
  old="$dst.before-$(date +%Y%m%d-%H%M%S)"; mv "$dst" "$old"; echo "The earlier clone is now $old"
fi
mkdir -p "$dst"
for d in projects inputs media generations; do [ -d "$src/$d" ] && cp -al "$src/$d" "$dst/$d"; done   # links
for d in library craft; do [ -d "$src/$d" ] && cp -a "$src/$d" "$dst/$d"; done                        # real copies
for f in downloads.json secrets.json; do [ -f "$src/$f" ] && cp -a "$src/$f" "$dst/$f"; done
# the database, as one consistent snapshot even while the live app is writing
python3 - "$src/deck.sqlite3" "$dst/deck.sqlite3" <<'PY'
import sqlite3, sys
a = sqlite3.connect(f"file:{sys.argv[1]}?mode=ro", uri=True); b = sqlite3.connect(sys.argv[2])
a.backup(b); b.close(); a.close()
PY
echo "Clone ready: $dst"
echo "Start the test server with:"
echo "  cd $here && DECK_DATA=$dst DECK_COMFY_DIR= DECK_PORT=8197 ./run.sh"
