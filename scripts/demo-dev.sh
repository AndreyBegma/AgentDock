#!/bin/sh
# DemoFlow's devCommand (demoflow.config.json, ADR-0090): starts the API and
# the web app of this checkout — a fresh card worktree included — for one
# recording, against the dev PostgreSQL and Redis of `bun run db:setup`.
#
# The web app listens on PORT (the runner sets it; default 3517) and starts only
# once the API answers its health check, so DemoFlow's readyUrl answers only
# when the whole app is up. The API listens on DEMO_API_PORT (default PORT +
# 1000), so it does not clash with the dev API on 8180. DemoFlow 0.4.0 cannot
# give each card its own port, so one card records at a time (DemoFlow#337).
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_PORT="${PORT:-3517}"
API_PORT="${DEMO_API_PORT:-$((WEB_PORT + 1000))}"
API="http://127.0.0.1:$API_PORT"
WEB="http://127.0.0.1:$WEB_PORT"

if [ ! -f "$ROOT/apps/api/.env" ]; then
  echo "demo-dev: apps/api/.env is missing; copy the dev one into this worktree" >&2
  exit 1
fi
if curl -fsS -o /dev/null --max-time 2 "$API/health" 2>/dev/null; then
  echo "demo-dev: an API already answers on $API; set DEMO_API_PORT to a free port" >&2
  exit 1
fi

# The dev API's data directory — its secret keys and attachments — is the main
# checkout's, so this API reads and seals the dev database's data with the
# same keys instead of generating its own.
MAIN="$(dirname "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)")"
export NAUTELLE_DATA_DIR="${NAUTELLE_DATA_DIR:-$MAIN/apps/api/data}"
export ATTACHMENTS_DIR="${ATTACHMENTS_DIR:-$NAUTELLE_DATA_DIR/attachments}"

cd "$ROOT"
bun install --frozen-lockfile
bun run --cwd packages/shared build
bun run --cwd apps/api db:generate

# The dev API on this machine runs the schedules, webhooks and activity
# projector already; this one only serves the recording.
PORT="$API_PORT" WEB_URL="$WEB" APP_URL="$WEB" SCHEDULER_ENABLED=false \
  WEBHOOKS_WORKER_ENABLED=false ACTIVITY_POLL_MS=0 \
  bun run --cwd apps/api start:dev &
API_PID=$!
trap 'kill "$API_PID" 2>/dev/null || true' EXIT INT TERM

until curl -fsS -o /dev/null --max-time 2 "$API/health" 2>/dev/null; do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "demo-dev: the API exited before $API/health answered" >&2
    exit 1
  fi
  sleep 1
done

PORT="$WEB_PORT" API_URL="$API" NEXT_PUBLIC_LIVE_URL="ws://127.0.0.1:$API_PORT/live" \
  bun run --cwd apps/web start:dev
