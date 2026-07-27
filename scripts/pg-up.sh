#!/usr/bin/env bash
# Bring up the local PostgreSQL 16 + pgvector substrate and wait until it accepts
# connections on 5433 (the port docker-compose publishes, so DATABASE_URL is the
# same string in every environment).
#
#   Linux/macOS  : docker compose up -d db
#   Windows dev  : PostgreSQL runs inside WSL2 (Ubuntu-24.04); the WSL VM shuts
#                  itself down when idle, so every DB task starts with this script.
#
# Idempotent: a already-running cluster returns immediately.
set -euo pipefail

if command -v docker >/dev/null 2>&1 && [ -f "$(dirname "$0")/../docker-compose.yml" ] && [ "${USE_DOCKER:-1}" = "1" ]; then
  docker compose -f "$(dirname "$0")/../docker-compose.yml" up -d db
elif command -v wsl.exe >/dev/null 2>&1 || [ -n "${WSL_DISTRO:-}" ]; then
  wsl.exe -d "${WSL_DISTRO:-Ubuntu-24.04}" -- bash -lc 'sudo pg_ctlcluster 16 main start 2>/dev/null || true'
else
  sudo pg_ctlcluster 16 main start 2>/dev/null || true
fi

for _ in $(seq 1 30); do
  if command -v pg_isready >/dev/null 2>&1; then
    pg_isready -h 127.0.0.1 -p 5433 >/dev/null 2>&1 && { echo "postgres ready on 127.0.0.1:5433"; exit 0; }
  else
    wsl.exe -d "${WSL_DISTRO:-Ubuntu-24.04}" -- pg_isready -h 127.0.0.1 -p 5433 >/dev/null 2>&1 &&
      { echo "postgres ready on 127.0.0.1:5433"; exit 0; }
  fi
  sleep 1
done

echo "postgres did NOT become ready on 127.0.0.1:5433" >&2
exit 1
