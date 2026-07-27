#!/usr/bin/env bash
# Fetch + verify the sponsor's official dataset.
#
# The dataset is NOT redistributed in this repository: its licence says
# "본 데이터셋은 대회 참가 목적으로만 사용 가능합니다" (contest use only), so the archive
# and its extracted files are gitignored and fetched on demand. The SHA-256 below is
# the integrity contract — if upstream republishes a different build, this script
# fails loudly instead of silently changing every eval number.
#
# Usage: bash scripts/fetch-companyx-dataset.sh
set -euo pipefail

URL="https://liwonace.co.kr/downloads/companyx-dataset-v1.0.zip"
SHA256="3008476738d992857d738337b4882772e88288f7b314da235d6a5d120827d772"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/datasets"
ZIP="$DIR/companyx-dataset-v1.0.zip"
OUT="$DIR/companyx-v1.0"

mkdir -p "$DIR"
if [ ! -f "$ZIP" ]; then
  echo "downloading $URL"
  curl -fsSL -o "$ZIP" "$URL"
fi

actual="$(sha256sum "$ZIP" | cut -d' ' -f1)"
if [ "$actual" != "$SHA256" ]; then
  echo "SHA-256 MISMATCH" >&2
  echo "  expected $SHA256" >&2
  echo "  actual   $actual" >&2
  exit 1
fi
echo "sha256 ok: $actual"

rm -rf "$OUT"
unzip -q "$ZIP" -d "$DIR"
test -f "$OUT/questions.json" || { echo "unexpected archive layout" >&2; exit 1; }

docs=$(ls "$OUT/documents"/DOC-*.md | wc -l)
echo "extracted -> $OUT  (documents: $docs)"
echo "next: cd air-server && npm run companyx:load"
