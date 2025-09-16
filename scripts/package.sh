#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$ROOT_DIR/extension/manifest.json"

if [[ ! -f "$MANIFEST" ]]; then
  echo "Manifest not found at $MANIFEST" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required to read the manifest version" >&2
  exit 1
fi

VERSION_ARG="${1:-}"
if [[ -z "$VERSION_ARG" ]]; then
  VERSION_ARG="$(python3 - "$MANIFEST" <<'PY'
import json, sys
from pathlib import Path
manifest_path = Path(sys.argv[1])
with manifest_path.open('r', encoding='utf-8') as fh:
    data = json.load(fh)
print(data.get('version', '0.0.0'))
PY
 )"
fi

VERSION="$VERSION_ARG"
DIST_DIR="$ROOT_DIR/dist"
PACKAGE_NAME="zotero-obsidian-daily"
OUTPUT="$DIST_DIR/${PACKAGE_NAME}-${VERSION}.xpi"

rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

(
  cd "$ROOT_DIR/extension"
  zip -r "$OUTPUT" . -x '*.DS_Store'
) >/dev/null

echo "Created $OUTPUT"
