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

# 아카이브는 최상위에 평평하게 담겨 있다(documents/, graph/, sql/, questions.json).
# 상위 디렉터리 하나로 감싸져 있지 않으므로 $OUT 안으로 직접 푼다.
# 실측: `unzip -l` 결과 49 files, 최상위 항목이 곧 documents/... 이다.
rm -rf "$OUT"
mkdir -p "$OUT"

# unzip 이 없는 환경(Git Bash, 최소 컨테이너)이 흔하다. 안내한 명령이 그 자리에서
# `unzip: command not found` 로 죽으면 그건 안내가 아니다. Python 으로 폴백한다.
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$ZIP" -d "$OUT"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$ZIP" "$OUT"
elif command -v python >/dev/null 2>&1; then
  python -c "import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$ZIP" "$OUT"
else
  echo "압축을 풀 도구가 없다: unzip 또는 python 이 필요하다" >&2
  exit 1
fi

test -f "$OUT/questions.json" || { echo "unexpected archive layout: $OUT/questions.json 이 없다" >&2; exit 1; }

docs=$(ls "$OUT/documents"/DOC-*.md | wc -l)
echo "extracted -> $OUT  (documents: $docs)"
echo "next: cd air-server && npm run companyx:load"
