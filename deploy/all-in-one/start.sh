#!/bin/bash
# Starts Nautelle in one container (ADR-0097), under tini: the API, the web app
# and Caddy on :8000, which splits the origin like deploy/compose/ does.
#
# Demo mode: without DATABASE_URL it runs an embedded PostgreSQL 16, and
# without REDIS_URL an embedded Redis, both on loopback with their data and
# generated passwords under /data. External mode: with both set, neither runs.
#
# NAUTELLE_URL is the address people open (default http://localhost:8000);
# API_URL, WEB_URL, APP_URL, PUBLIC_URL and APP_ENV derive from it as in the
# compose install, and each may be set on its own. Any other variable of
# apps/api/.env.example reaches the API as it is.
#
# A service that exits stops the others, and the container exits with its
# status; `docker stop` stops them in order, the databases last.
set -euo pipefail

DATA=/data
PGDATA=$DATA/postgres
PGSOCKET=/var/run/postgresql
SECRETS=$DATA/demo.env
URL=${NAUTELLE_URL:-http://localhost:8000}
URL=${URL%/}

say() { printf 'nautelle: %s\n' "$*"; }
fail() {
  printf 'nautelle: %s\n' "$*" >&2
  exit 1
}

password() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }

# A demo password, generated on the first boot and kept in /data/demo.env,
# which only root reads.
demo_secret() {
  local value
  value=$(sed -n "s/^$1=//p" "$SECRETS" 2>/dev/null | tail -n 1)
  if [ -z "$value" ]; then
    value=$(password)
    (umask 077 && printf '%s=%s\n' "$1" "$value" >>"$SECRETS")
  fi
  printf '%s' "$value"
}

mkdir -p "$DATA/attachments"
chown nautelle:nautelle "$DATA" "$DATA/attachments"

POSTGRES_PID=
REDIS_PID=
API_PID=
WEB_PID=
CADDY_PID=
stopping=0

# The proxy and the apps first, then Redis and PostgreSQL (a fast shutdown).
stop() {
  [ "$stopping" = 0 ] || return 0
  stopping=1
  local pid
  for pid in $CADDY_PID $WEB_PID $API_PID; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in $CADDY_PID $WEB_PID $API_PID; do wait "$pid" 2>/dev/null || true; done
  [ -z "$REDIS_PID" ] || kill -TERM "$REDIS_PID" 2>/dev/null || true
  [ -z "$POSTGRES_PID" ] || kill -INT "$POSTGRES_PID" 2>/dev/null || true
  for pid in $REDIS_PID $POSTGRES_PID; do wait "$pid" 2>/dev/null || true; done
}
trap 'say "stopping"; stop; exit 0' TERM INT

alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null; }

# Waits up to $2 seconds for the command after it, while $1 (a pid) lives.
wait_for() {
  local pid=$1 seconds=$2 waited=0
  shift 2
  until "$@" >/dev/null 2>&1; do
    alive "$pid" || return 1
    [ "$waited" -lt "$seconds" ] || return 1
    sleep 1
    waited=$((waited + 1))
  done
}

demo=0
[ -n "${DATABASE_URL:-}" ] && [ -n "${REDIS_URL:-}" ] || demo=1
if [ "$demo" = 1 ]; then
  say '──────────────────────────────────────────────────────────────────────'
  say 'DEMO MODE, not for production: PostgreSQL and Redis run inside this'
  say 'container, with their data in /data. Set DATABASE_URL and REDIS_URL to'
  say 'use your own, or install with Docker Compose:'
  say 'https://andreybegma.github.io/Nautelle/getting-started/install/'
  say '──────────────────────────────────────────────────────────────────────'
fi

# ─── PostgreSQL ──────────────────────────────────────────────────────────────

if [ -z "${DATABASE_URL:-}" ]; then
  pg_password=$(demo_secret POSTGRES_PASSWORD)
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  if [ ! -s "$PGDATA/PG_VERSION" ]; then
    say "creating the demo database in $PGDATA"
    pwfile=$(mktemp)
    printf '%s' "$pg_password" >"$pwfile"
    chown postgres "$pwfile"
    # The socket is the container's own: trusted. TCP needs the password.
    gosu postgres initdb -D "$PGDATA" -U nautelle --pwfile="$pwfile" -E UTF8 \
      --auth-local=trust --auth-host=scram-sha-256 >/dev/null
    rm -f "$pwfile"
  fi
  gosu postgres postgres -D "$PGDATA" -c listen_addresses=127.0.0.1 \
    -c unix_socket_directories="$PGSOCKET" &
  POSTGRES_PID=$!
  wait_for "$POSTGRES_PID" 60 pg_isready -h "$PGSOCKET" -U nautelle -d postgres ||
    fail 'the embedded PostgreSQL did not start; its log is above'
  # The password follows /data/demo.env, which may be newer than the database.
  gosu postgres psql -h "$PGSOCKET" -U nautelle -d postgres -v ON_ERROR_STOP=1 -q \
    -c "ALTER ROLE nautelle WITH PASSWORD '$pg_password'"
  [ "$(gosu postgres psql -h "$PGSOCKET" -U nautelle -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = 'nautelle'")" = 1 ] ||
    gosu postgres createdb -h "$PGSOCKET" -U nautelle nautelle
  export DATABASE_URL="postgresql://nautelle:$pg_password@127.0.0.1:5432/nautelle?schema=public"
fi

# ─── Redis ───────────────────────────────────────────────────────────────────

if [ -z "${REDIS_URL:-}" ]; then
  redis_password=$(demo_secret REDIS_PASSWORD)
  mkdir -p "$DATA/redis"
  chown nautelle:nautelle "$DATA/redis"
  # AOF keeps BullMQ's pending timers over a restart (ADR-0015).
  gosu nautelle redis-server --bind 127.0.0.1 --port 6379 \
    --requirepass "$redis_password" --dir "$DATA/redis" \
    --appendonly yes --appendfsync everysec --maxmemory-policy noeviction &
  REDIS_PID=$!
  wait_for "$REDIS_PID" 30 env REDISCLI_AUTH="$redis_password" redis-cli -h 127.0.0.1 ping ||
    fail 'the embedded Redis did not start; its log is above'
  export REDIS_URL="redis://:$redis_password@127.0.0.1:6379/0"
fi

# ─── Nautelle ────────────────────────────────────────────────────────────────

case "$URL" in
  https://*) https=1 ;;
  *) https=0 ;;
esac

# The API migrates and seeds in its entrypoint before it listens.
(
  cd /opt/nautelle/api/apps/api
  export PATH="/opt/nautelle/api/node_modules/.bin:$PATH"
  export PORT=8180
  export NAUTELLE_DATA_DIR="$DATA" ATTACHMENTS_DIR="$DATA/attachments"
  export API_URL="${API_URL:-$URL/api}" WEB_URL="${WEB_URL:-$URL}" APP_URL="${APP_URL:-$URL}"
  # A browser drops Secure cookies on plain HTTP, and GitHub cannot reach it.
  if [ "$https" = 1 ]; then
    export APP_ENV="${APP_ENV:-production}" PUBLIC_URL="${PUBLIC_URL-$URL/api}"
  else
    export APP_ENV="${APP_ENV:-development}" PUBLIC_URL="${PUBLIC_URL-}"
  fi
  # Caddy is the API's only peer.
  export TRUST_PROXY="${TRUST_PROXY:-loopback}"
  exec gosu nautelle sh docker-entrypoint.sh node dist/src/main
) &
API_PID=$!

# Server components call the API on loopback, not through Caddy.
(
  cd /opt/nautelle/web
  export PORT=3517 HOSTNAME=127.0.0.1 API_URL=http://127.0.0.1:8180
  exec gosu nautelle node apps/web/server.js
) &
WEB_PID=$!

(
  export HOME=/tmp XDG_CONFIG_HOME=/tmp/caddy/config XDG_DATA_HOME=/tmp/caddy/data
  exec gosu nautelle caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
) &
CADDY_PID=$!

api_up() { node -e "fetch('http://127.0.0.1:8180/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"; }
if wait_for "$API_PID" 600 api_up; then
  say "Nautelle is up: $URL"
  say 'With no user yet, the API logged a one-time link above ("Open …/setup?token=…"): open it to create the first admin.'
  [ "$demo" = 0 ] || say 'Demo mode: not for production.'
fi

# The first service to exit stops the rest.
status=0
wait -n $POSTGRES_PID $REDIS_PID $API_PID $WEB_PID $CADDY_PID || status=$?
[ "$stopping" = 1 ] && exit 0
for name in POSTGRES REDIS API WEB CADDY; do
  pid_var="${name}_PID"
  pid=${!pid_var}
  [ -z "$pid" ] || alive "$pid" || say "$(printf '%s' "$name" | tr 'A-Z' 'a-z') exited ($status); stopping the rest"
done
stop
exit "$((status == 0 ? 1 : status))"
