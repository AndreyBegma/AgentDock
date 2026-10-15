#!/bin/sh
# Deploys staging (ADR-0016): the pipeline's `deploy-staging` step, after
# build-staging.sh, or by hand from the repository root. POSIX sh: it runs in
# the busybox `docker:28-cli` image with the Docker socket and STAGING_DIR
# bind-mounted at the same path as on the host, so the compose file's relative
# paths mean the same thing to the daemon.
#
# The first run creates STAGING_DIR, copies the examples in, generates every
# secret that is pure randomness, and stops without starting anything until
# the one hand-made value — the tunnel token — is in place.
set -eu

STAGING_DIR="${STAGING_DIR:-/home/archi/stacks/agentdock-staging}"
SRC="$(cd "$(dirname "$0")" && pwd)"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"

branch="${CI_COMMIT_BRANCH:-}"
if [ -n "$branch" ] && [ "$branch" != develop ]; then
  echo "refresh.sh deploys develop only, got '$branch'" >&2
  exit 1
fi

mkdir -p "$STAGING_DIR/env"

# ── env files: copied once, never overwritten ───────────────────────────────
copy_once() {
  if [ ! -f "$2" ]; then
    cp "$1" "$2"
    echo "created $2"
  fi
  chmod 600 "$2"
}
copy_once "$SRC/.env.example" "$STAGING_DIR/.env"
for example in "$SRC"/env/*.env.example; do
  copy_once "$example" "$STAGING_DIR/env/$(basename "$example" .example)"
done

# Missing keys a newer example added are appended with the example's value:
# a plain setting (ATTACHMENTS_DIR=/data/attachments) arrives as its default,
# and a secret — empty in every example — gets generated below or reported as
# missing. Appending them empty once left ATTACHMENTS_DIR unset, so the API
# wrote attachments inside the container and lost them on the next deploy.
add_missing_keys() {
  grep -E '^[A-Z_]+=' "$1" | while IFS= read -r line; do
    key="${line%%=*}"
    grep -qE "^$key=" "$2" || printf '%s\n' "$line" >>"$2"
  done
}
add_missing_keys "$SRC/.env.example" "$STAGING_DIR/.env"
for example in "$SRC"/env/*.env.example; do
  add_missing_keys "$example" "$STAGING_DIR/env/$(basename "$example" .example)"
done

value_of() { grep -E "^$1=" "$2" | tail -n1 | cut -d= -f2-; }

fill_if_empty() {
  if [ -z "$(value_of "$1" "$3")" ]; then
    sed -i "s|^$1=.*|$1=$2|" "$3"
    echo "generated $1 in $3"
  fi
}
hex() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }
fill_if_empty POSTGRES_PASSWORD "$(hex)" "$STAGING_DIR/.env"
fill_if_empty REDIS_PASSWORD "$(hex)" "$STAGING_DIR/.env"
fill_if_empty APP_ENCRYPTION_KEY "$(head -c 32 /dev/urandom | base64)" \
  "$STAGING_DIR/env/api.env"

# ── stack files: always the commit's own ────────────────────────────────────
caddy_changed=false
cmp -s "$SRC/Caddyfile" "$STAGING_DIR/Caddyfile" || caddy_changed=true
for file in docker-compose.yml Caddyfile up.sh down.sh status.sh; do
  cp "$SRC/$file" "$STAGING_DIR/$file"
done
chmod +x "$STAGING_DIR"/*.sh
# The step runs as root through the socket; the operator is uid 1000.
chown -R 1000:1000 "$STAGING_DIR"

if [ -z "$(value_of TUNNEL_TOKEN "$STAGING_DIR/env/cloudflared.env")" ]; then
  cat >&2 <<EOF
Staging is prepared but not started: TUNNEL_TOKEN is empty.
  cp ~/.agentdock/cloudflared-staging.env $STAGING_DIR/env/cloudflared.env
then re-run the pipeline or $STAGING_DIR/up.sh (deploy/README.md).
EOF
  exit 0
fi

# ── deploy ──────────────────────────────────────────────────────────────────
cd "$STAGING_DIR"
# The API first, and wait for it, so api and web are never down together; the
# proxy holds requests meanwhile (#368). The rest follows once it is healthy.
echo "Restarting the API and waiting for it (up to ${HEALTH_TIMEOUT}s)..."
if ! docker compose up -d --remove-orphans --wait --wait-timeout "$HEALTH_TIMEOUT" api; then
  echo "agentdock-staging-api did not become healthy within ${HEALTH_TIMEOUT}s" >&2
  docker logs --tail 60 agentdock-staging-api >&2 || true
  exit 1
fi
docker compose up -d --remove-orphans
if [ "$caddy_changed" = true ]; then
  docker compose restart proxy
fi

echo "Waiting for the API to report healthy (up to ${HEALTH_TIMEOUT}s)..."
waited=0
while :; do
  status="$(docker inspect -f '{{.State.Health.Status}}' agentdock-staging-api 2>/dev/null || echo missing)"
  [ "$status" = healthy ] && break
  if [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
    echo "agentdock-staging-api is '$status' after ${HEALTH_TIMEOUT}s" >&2
    docker logs --tail 60 agentdock-staging-api >&2 || true
    exit 1
  fi
  sleep 5
  waited=$((waited + 5))
done

{
  echo "DEPLOYED_SHA=${CI_COMMIT_SHA:-unknown}"
  echo "DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "PIPELINE=${CI_PIPELINE_URL:-by hand}"
} >"$STAGING_DIR/deployed.env"
chown 1000:1000 "$STAGING_DIR/deployed.env"

docker compose ps
