#!/usr/bin/env bash
# Cluster spike — REAL PostgreSQL streaming replication + read-routing + kill drill.
#
# Stands up a hot-standby of the running primary via pg_basebackup, proves
# streaming replication, app-level READ_DATABASE_URL routing (getReadPool ->
# replica), read-only enforcement, and read availability during a primary
# outage (kill drill). Tears everything down and reverts the temporary pg_hba
# line. Captures evidence to eval/results/replica-spike.log.
#
# Non-destructive: pg_basebackup writes a fresh volume (never touches primary
# data); the pg_hba replication line is appended then removed; the test probe
# table is dropped at the end. Requires the compose stack up (db on :5433).
#
# This documents an OPTIONAL live-replica spike. Production HA (automatic
# promotion/failover, monitored lag SLAs) is out of scope — see docs/architecture.md.
set -euo pipefail
# ── docker CLI 해석 (2026-08-18)
#
# `bash scripts/replica-spike.sh` 로 돌리면 PATH 가 /usr/bin/docker 를 먼저 잡는다.
# 그건 unix:///var/run/docker.sock 을 보는 shim 이고 Docker Desktop 은 named pipe 에
# 있다. 그래서 컨테이너가 떠 있는데도 "No such container" 가 났고, **그 실패가
# 증거 파일(replica-spike.log)에 그대로 박혔다.**
#
# 같은 이름의 다른 도구를 부르고 있었다. 못 보면 Desktop CLI 를 찾아 앞에 둔다.
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q .; then
  for cand in "$(command -v docker.exe 2>/dev/null)" \
              "/c/Program Files/Docker/Docker/resources/bin/docker.exe" \
              "/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"; do
    if [ -n "$cand" ] && [ -x "$cand" ] && "$cand" ps --format '{{.Names}}' >/dev/null 2>&1; then
      # PATH 앞에 붙이는 것으로는 안 된다 — 그 디렉터리에는 `docker.exe` 만 있고
      # 확장자 없는 `docker` 가 없어서 탐색이 그냥 통과한다.
      # **우선순위를 바꾸는 것과 이름을 해결하는 것은 다르다.** 함수로 덮는다.
      DOCKER_BIN="$cand"
      docker() { "$DOCKER_BIN" "$@"; }
      echo "  (docker CLI 교체: $cand — 기본 PATH 의 docker 는 다른 데몬을 본다)"
      break
    fi
  done
fi

P=onprem-mcp-data-db-1
NET=onprem-mcp-data_default
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$ROOT/eval/results/replica-spike.log"
PGP="-e PGPASSWORD=postgres"

cleanup() {
  docker rm -f mcp-replica >/dev/null 2>&1 || true
  docker volume rm repltest_data >/dev/null 2>&1 || true
  docker exec $PGP "$P" psql -U postgres -d mcpdata -tAc "DROP TABLE IF EXISTS bench.repl_probe;" >/dev/null 2>&1 || true
  docker exec "$P" bash -lc "sed -i '/REPLICA-SPIKE/d' /var/lib/postgresql/data/pg_hba.conf" >/dev/null 2>&1 || true
  docker exec $PGP "$P" psql -U postgres -tAc "SELECT pg_reload_conf();" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 프리플라이트 — 우리가 보는 데몬에 컨테이너가 있는가.
#
# 이 머신에는 docker 가 둘 있을 수 있다(Docker Desktop / Engine Community). 셸이
# 어느 쪽에 붙느냐에 따라 compose 컨테이너가 안 보이고, 그때 docker 는
# "No such container" 라고 답한다 — **컨테이너가 없다는 뜻이 아니라 내가 보는
# 데몬에 없다는 뜻**이다. 받는 사람은 컨테이너를 다시 띄우려 하고 같은 에러를 본다.
if ! docker inspect "$P" >/dev/null 2>&1; then
  echo "실패: 컨테이너 $P 를 이 docker 데몬에서 찾지 못했다." >&2
  echo "  현재 context : $(docker context show 2>/dev/null || echo unknown)" >&2
  echo "  보이는 컨테이너: $(docker ps --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')" >&2
  echo "" >&2
  echo "  컨테이너가 정말 없다면:  docker compose up -d" >&2
  echo "  띄웠는데도 안 보인다면 셸이 다른 docker 데몬에 붙어 있다:" >&2
  echo "    docker context ls          # 어떤 것이 있는지" >&2
  echo "    docker context use desktop-linux   # Docker Desktop 을 쓰는 경우" >&2
  exit 1
fi

mkdir -p "$ROOT/eval/results"
{
echo "# Replica spike — $(date -u +%FT%TZ)"

echo "## 1. enable network replication on primary (reversible)"
docker exec "$P" bash -lc "grep -q REPLICA-SPIKE /var/lib/postgresql/data/pg_hba.conf || echo 'host replication all all scram-sha-256 # REPLICA-SPIKE' >> /var/lib/postgresql/data/pg_hba.conf"
docker exec $PGP "$P" psql -U postgres -tAc "SELECT pg_reload_conf();" >/dev/null

echo "## 2. pg_basebackup -> standby volume"
docker rm -f mcp-replica >/dev/null 2>&1 || true; docker volume rm repltest_data >/dev/null 2>&1 || true
docker volume create repltest_data >/dev/null
# basebackup·standby 전부 **primary 와 같은 이미지**로 돈다. 메이저가 다르면
# 복제본이 못 뜨고, 그 실패가 증거 로그에 그대로 박힌다(2026-08-17 실측).
PRIMARY_IMAGE="$(docker inspect -f '{{.Config.Image}}' "$P")"
docker run --rm --network "$NET" $PGP -v repltest_data:/standby "$PRIMARY_IMAGE" \
  bash -lc "pg_basebackup -h db -U postgres -D /standby -Fp -Xs -R && chmod 700 /standby" >/dev/null
docker run --rm -v repltest_data:/s "$PRIMARY_IMAGE" \
  bash -lc "grep -q 'password=' /s/postgresql.auto.conf || sed -i \"s/primary_conninfo = '/primary_conninfo = 'password=postgres /\" /s/postgresql.auto.conf" >/dev/null

echo "## 3. start hot standby on :5434"
# 이미지를 적지 않고 **primary 에게 묻는다.** 복제본은 메이저 버전이 같아야 하는데,
# 종전에는 pg17 이 하드코딩돼 있었고 primary 는 pg16 이라 standby 가 뜨자마자 죽었다
# (그 실패가 증거 로그에 그대로 박혔다). 하드코딩된 값은 다시 갈린다.
echo "  standby 이미지 = $PRIMARY_IMAGE (primary 와 동일 — 메이저가 다르면 복제본은 못 뜬다)"
docker run -d --name mcp-replica --network "$NET" -p 5434:5432 -v repltest_data:/var/lib/postgresql/data "$PRIMARY_IMAGE" >/dev/null
sleep 12
echo "  in_recovery=$(docker exec $PGP mcp-replica psql -U postgres -d mcpdata -tAc 'SELECT pg_is_in_recovery();')"

echo "## 4. streaming proof: write primary -> read replica"
docker exec $PGP "$P" psql -U postgres -d mcpdata -tAc "CREATE TABLE IF NOT EXISTS bench.repl_probe(id int primary key); INSERT INTO bench.repl_probe VALUES (42) ON CONFLICT DO NOTHING;" >/dev/null
sleep 3
echo "  replica_sees_id42=$(docker exec $PGP mcp-replica psql -U postgres -d mcpdata -tAc 'SELECT count(*) FROM bench.repl_probe WHERE id=42;')"
echo "  replica read-only: $(docker exec $PGP mcp-replica psql -U postgres -d mcpdata -tAc 'INSERT INTO bench.repl_probe VALUES (99);' 2>&1 | head -1)"
echo "  primary pg_stat_replication=$(docker exec $PGP "$P" psql -U postgres -tAc "SELECT state||'/'||sync_state FROM pg_stat_replication;")"

echo "## 5. app READ_DATABASE_URL routing (getReadPool -> replica)"
( cd "$ROOT/air-server" && READ_DATABASE_URL=postgresql://postgres:postgres@localhost:5434/mcpdata node -e '
import("./dist/db.js").then(async ({getPool,getReadPool,closePool})=>{
  const a=await getPool().query("SELECT pg_is_in_recovery() r");
  const b=await getReadPool().query("SELECT pg_is_in_recovery() r, count(*)::int n FROM bench.orders");
  console.log("  getPool->in_recovery="+a.rows[0].r+"  getReadPool->in_recovery="+b.rows[0].r+" orders="+b.rows[0].n);
  await closePool();
});' )

echo "## 6. KILL DRILL: stop primary, replica keeps serving reads"
docker stop "$P" >/dev/null; echo "  primary STOPPED"; sleep 2
echo "  replica orders while primary down=$(docker exec $PGP mcp-replica psql -U postgres -d mcpdata -tAc 'SELECT count(*) FROM bench.orders;')"
docker start "$P" >/dev/null; sleep 8; echo "  primary RESTARTED orders=$(docker exec $PGP "$P" psql -U postgres -d mcpdata -tAc 'SELECT count(*) FROM bench.orders;')"

echo "## done — tearing down (trap)"
} 2>&1 | tee "$LOG"
