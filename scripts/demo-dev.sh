#!/bin/sh
# DemoFlow's devCommand (demoflow.config.json, ADR-0090): starts the API and
# the web app of this checkout — a fresh card worktree included — for one
# recording, on a demo database of its own on the dev PostgreSQL of
# `bun run db:setup`, so every demo starts from the same data whatever the dev
# database holds.
#
# The database is agentdock_demo_<id> for a card worktree (NAUTELLE_CARD, else
# the worktree's `card-<id>` suffix) and agentdock_demo elsewhere. Each start
# recreates it, applies this checkout's migrations, creates the admin
# DEMO_LOGIN_EMAIL / DEMO_LOGIN_PASSWORD (the project's Demo env) with
# `admin:create`, and seeds a demo project with a few cards; the database and
# the API's data directory are dropped when DemoFlow stops the script.
#
# The web app listens on PORT (DemoFlow's --port, set by the runner; default 3517) and starts only
# once the API answers its health check, so DemoFlow's readyUrl answers only
# when the whole app is up. The API listens on DEMO_API_PORT (default PORT +
# 1000), so it does not clash with the dev API on 8180. Each recording gets a
# port of its own (DemoFlow 0.6 --port), so cards record in parallel.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_PORT="${PORT:-3517}"
API_PORT="${DEMO_API_PORT:-$((WEB_PORT + 1000))}"
API="http://127.0.0.1:$API_PORT"
WEB="http://127.0.0.1:$WEB_PORT"

: "${DEMO_LOGIN_EMAIL:?set it in the project'\''s Demo env}"
: "${DEMO_LOGIN_PASSWORD:?set it in the project'\''s Demo env}"
if [ ! -f "$ROOT/apps/api/.env" ]; then
  echo "demo-dev: apps/api/.env is missing; copy the dev one into this worktree" >&2
  exit 1
fi
if curl -fsS -o /dev/null --max-time 2 "$API/health" 2>/dev/null; then
  echo "demo-dev: an API already answers on $API; set DEMO_API_PORT to a free port" >&2
  exit 1
fi

CARD_ID="${NAUTELLE_CARD:-}"
if [ -z "$CARD_ID" ]; then
  case "$(basename "$ROOT")" in *card-*) CARD_ID="${ROOT##*card-}" ;; esac
fi
CARD_ID="$(printf '%s' "$CARD_ID" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9')"
DEMO_DB="agentdock_demo${CARD_ID:+_$CARD_ID}"

cd "$ROOT"
bun install --frozen-lockfile
bun run --cwd packages/shared build
bun run --cwd apps/api db:generate

DATABASE_URL="$(bun run --silent --cwd apps/api demo:db url "$DEMO_DB")"
export DATABASE_URL
# Its own queue prefix: this API never touches the dev API's queues in Redis.
export QUEUE_PREFIX="$DEMO_DB"
# Its own data directory (keys, attachments) for its own database.
export NAUTELLE_DATA_DIR="${TMPDIR:-/tmp}/nautelle-$DEMO_DB"
export ATTACHMENTS_DIR="$NAUTELLE_DATA_DIR/attachments"

PIDS=''
# Stops a process and everything it started: `bun run` leaves its children
# running when only it is killed.
stop_tree() {
  for child in $(pgrep -P "$1" 2>/dev/null); do stop_tree "$child"; done
  kill "$1" 2>/dev/null || true
}
CLEANED=''
cleanup() {
  [ -n "$CLEANED" ] && return
  CLEANED=1
  set +e
  for pid in $PIDS; do stop_tree "$pid"; done
  bun run --silent --cwd apps/api demo:db drop "$DEMO_DB"
  rm -rf "$NAUTELLE_DATA_DIR"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

bun run --silent --cwd apps/api demo:db create "$DEMO_DB"
bun run --cwd apps/api db:migrate:deploy
bun run --cwd apps/api db:seed
ADMIN_EMAIL="$DEMO_LOGIN_EMAIL" ADMIN_PASSWORD="$DEMO_LOGIN_PASSWORD" \
  ADMIN_NAME='Demo Admin' bun run --silent --cwd apps/api admin:create
bun run --silent --cwd apps/api demo:db seed "$DEMO_DB"

# The dev API on this machine runs the schedules, webhooks and activity
# projector; this one only serves the recording.
PORT="$API_PORT" WEB_URL="$WEB" APP_URL="$WEB" SCHEDULER_ENABLED=false \
  WEBHOOKS_WORKER_ENABLED=false ACTIVITY_POLL_MS=0 \
  bun run --cwd apps/api start:dev &
PIDS="$!"

until curl -fsS -o /dev/null --max-time 2 "$API/health" 2>/dev/null; do
  if ! kill -0 "$PIDS" 2>/dev/null; then
    echo "demo-dev: the API exited before $API/health answered" >&2
    exit 1
  fi
  sleep 1
done

PORT="$WEB_PORT" API_URL="$API" NEXT_PUBLIC_LIVE_URL="ws://127.0.0.1:$API_PORT/live" \
  bun run --cwd apps/web start:dev &
PIDS="$PIDS $!"
wait
