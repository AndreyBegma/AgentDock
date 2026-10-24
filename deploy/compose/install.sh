#!/bin/sh
# Installs Nautelle from its published images (ADR-0088, https://andreybegma.github.io/Nautelle/).
#
#   curl -fsSL https://raw.githubusercontent.com/AndreyBegma/Nautelle/main/deploy/compose/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --domain dock.example.com
#
# It checks Docker and Compose v2, puts docker-compose.yml and .env.example
# into ./nautelle, writes .env with random database and Redis passwords,
# starts the stack, waits until the API is healthy and prints the first-run
# setup link. The API generates its own keys on the first boot. Running it
# again is safe: an existing .env keeps its passwords, and only the flags given
# change it. Needs Docker, and curl or wget.
#
# Options:
#   --url <url>            the address people open (default http://localhost:8000)
#   --tunnel-token <token> run behind a Cloudflare tunnel; --url is its https hostname
#   --domain <domain>      serve <domain> with automatic HTTPS on ports 80 and 443
#   --admin-email <email>  with --admin-password: create the first admin, no setup page
#   --admin-password <pw>  (both are passed to this start only, never written to .env)
#   --port <port>          local mode: the host port (default 8000, or the --url port)
#   --dir <dir>            where to install (default ./nautelle)
#   --version <tag>        image tag (default latest)
#   --registry <registry>  where the images come from (default ghcr.io/andreybegma;
#                          docker.io/abegma for the same images on Docker Hub)
#   --source <url|dir>     where the compose files come from (default: main on GitHub)
#   --no-start             write the files and .env, start nothing
#   -y, --yes              ask nothing
set -eu

SOURCE="${NAUTELLE_SOURCE:-https://raw.githubusercontent.com/AndreyBegma/Nautelle/main/deploy/compose}"
DIR=./nautelle
URL=
TUNNEL_TOKEN=
DOMAIN=
ADMIN_EMAIL=
ADMIN_PASSWORD=
PORT=
VERSION=
REGISTRY="${NAUTELLE_REGISTRY:-}"
START=1
ASK=1
HEALTH_TIMEOUT="${NAUTELLE_HEALTH_TIMEOUT:-300}"

say() { printf '%s\n' "$*"; }
fail() {
  printf 'nautelle install: %s\n' "$*" >&2
  exit 1
}

value() {
  [ $# -ge 2 ] && [ -n "$2" ] || fail "$1 needs a value"
  printf '%s' "$2"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL=$(value "$@"); shift 2 ;;
    --tunnel-token) TUNNEL_TOKEN=$(value "$@"); shift 2 ;;
    --domain) DOMAIN=$(value "$@"); shift 2 ;;
    --admin-email) ADMIN_EMAIL=$(value "$@"); shift 2 ;;
    --admin-password) ADMIN_PASSWORD=$(value "$@"); shift 2 ;;
    --port) PORT=$(value "$@"); shift 2 ;;
    --dir) DIR=$(value "$@"); shift 2 ;;
    --version) VERSION=$(value "$@"); shift 2 ;;
    --registry) REGISTRY=$(value "$@"); shift 2 ;;
    --source) SOURCE=$(value "$@"); shift 2 ;;
    --no-start) START=0; shift ;;
    -y | --yes) ASK=0; shift ;;
    -h | --help)
      sed -n '2,/^set -eu/p' "$0" 2>/dev/null | sed '$d; s/^# \{0,1\}//' || true
      exit 0
      ;;
    *) fail "unknown option $1 (--help lists them)" ;;
  esac
done

[ -z "$TUNNEL_TOKEN" ] || [ -z "$DOMAIN" ] ||
  fail '--tunnel-token and --domain are two different modes; pick one'
{ [ -n "$ADMIN_EMAIL" ] && [ -n "$ADMIN_PASSWORD" ]; } || [ -z "$ADMIN_EMAIL$ADMIN_PASSWORD" ] ||
  fail '--admin-email and --admin-password go together'

# ─── Docker ──────────────────────────────────────────────────────────────────

command -v docker >/dev/null 2>&1 ||
  fail 'Docker is not installed: https://docs.docker.com/engine/install/'
docker info >/dev/null 2>&1 ||
  fail 'cannot reach the Docker daemon: start it, or run as a user in the docker group'
compose_version=$(docker compose version --short 2>/dev/null) ||
  fail 'Docker Compose v2 is missing (the docker compose plugin; docker-compose v1 is not enough)'
# configs with inline content and an optional env_file need 2.24.
compose_major=$(printf '%s' "$compose_version" | sed 's/^v//' | cut -d. -f1)
compose_minor=$(printf '%s' "$compose_version" | sed 's/^v//' | cut -d. -f2)
if [ "${compose_major:-0}" -lt 2 ] 2>/dev/null ||
  { [ "$compose_major" -eq 2 ] && [ "${compose_minor:-0}" -lt 24 ]; }; then
  fail "Docker Compose $compose_version is too old: 2.24 or newer is needed"
fi

# ─── Files ───────────────────────────────────────────────────────────────────

fetch() {
  case "$SOURCE" in
    http://* | https://*)
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$SOURCE/$1" -o "$2.part"
      elif command -v wget >/dev/null 2>&1; then
        wget -qO "$2.part" "$SOURCE/$1"
      else
        fail 'neither curl nor wget is installed'
      fi
      ;;
    *) cp "$SOURCE/$1" "$2.part" ;;
  esac || fail "could not fetch $1 from $SOURCE"
  mv "$2.part" "$2"
}

mkdir -p "$DIR"
cd "$DIR"
# Always the current files: a re-run is also how the install gets a newer one.
fetch docker-compose.yml docker-compose.yml
fetch .env.example .env.example

# ─── .env ────────────────────────────────────────────────────────────────────

# KEY=value lines; the value is passed through the environment, so no
# character in it is special to awk.
get_env() {
  sed -n "s/^$1=//p" .env | tail -n 1
}

# .env.part is written under umask 077: it holds the secrets too.
set_env() {
  if grep -q "^$1=" .env; then
    (umask 077 && KEY="$1" VALUE="$2" awk '
      index($0, ENVIRON["KEY"] "=") == 1 { print ENVIRON["KEY"] "=" ENVIRON["VALUE"]; next }
      { print }
    ' .env >.env.part)
    cat .env.part >.env
    rm -f .env.part
  else
    printf '%s=%s\n' "$1" "$2" >>.env
  fi
}

unset_env() {
  if grep -q "^$1=" .env; then
    (umask 077 && { grep -v "^$1=" .env >.env.part || true; })
    cat .env.part >.env
    rm -f .env.part
  fi
}

password() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }

fresh=0
if [ ! -f .env ]; then
  fresh=1
  (umask 077 && cp .env.example .env)
fi
chmod 600 .env

# A key the example gained since this .env was written is added, empty.
for name in $(sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p' .env.example); do
  grep -q "^$name=" .env || set_env "$name" "$(sed -n "s/^$name=//p" .env.example)"
done

# Passwords are filled only where empty: never replaced. The API's own keys
# live in the data volume (C-366), not here.
for name in POSTGRES_PASSWORD REDIS_PASSWORD; do
  [ -n "$(get_env "$name")" ] || set_env "$name" "$(password)"
done

previous_mode=$(get_env COMPOSE_PROFILES)

# A first install with no flag asks for the address, when someone can answer.
if [ "$fresh" = 1 ] && [ "$ASK" = 1 ] && [ -z "$URL$TUNNEL_TOKEN$DOMAIN" ] &&
  { : </dev/tty; } 2>/dev/null; then
  printf 'Address of Nautelle [http://localhost:8000]: ' >/dev/tty
  read -r URL </dev/tty || URL=
fi

if [ -n "$DOMAIN" ]; then
  set_env COMPOSE_PROFILES tls
  set_env NAUTELLE_DOMAIN "$DOMAIN"
  [ -n "$URL" ] || URL="https://$DOMAIN"
elif [ -n "$TUNNEL_TOKEN" ]; then
  set_env COMPOSE_PROFILES tunnel
  set_env TUNNEL_TOKEN "$TUNNEL_TOKEN"
  [ -n "$URL" ] || case "$(get_env NAUTELLE_URL)" in
    https://*) ;;
    *) fail '--tunnel-token needs --url https://<the tunnel'"'"'s public hostname>' ;;
  esac
elif [ -n "$URL" ]; then
  set_env COMPOSE_PROFILES local
fi

if [ -n "$URL" ]; then
  URL=$(printf '%s' "$URL" | sed 's:/*$::')
  case "$URL" in
    http://?* | https://?*) ;;
    *) fail "--url must start with http:// or https://, not $URL" ;;
  esac
  set_env NAUTELLE_URL "$URL"
fi
URL=$(get_env NAUTELLE_URL)
MODE=$(get_env COMPOSE_PROFILES)

# Local mode on plain HTTP: the port and the listening address follow the URL.
if [ "$MODE" = local ]; then
  hostport=$(printf '%s' "$URL" | sed -n 's|^http://\([^/]*\).*|\1|p')
  if [ -n "$hostport" ]; then
    case "$hostport" in
      *:*) [ -n "$PORT" ] || PORT=${hostport##*:} ;;
      *) [ -n "$PORT" ] || PORT=80 ;;
    esac
    case "${hostport%:*}" in
      localhost | 127.0.0.1) set_env NAUTELLE_BIND 127.0.0.1 ;;
      *) set_env NAUTELLE_BIND 0.0.0.0 ;;
    esac
  fi
fi
[ -z "$PORT" ] || set_env NAUTELLE_PORT "$PORT"
[ -z "$VERSION" ] || set_env NAUTELLE_VERSION "$VERSION"
[ -z "$REGISTRY" ] || set_env NAUTELLE_REGISTRY "${REGISTRY%/}"

# A browser drops Secure cookies on plain HTTP, and GitHub cannot deliver to it.
case "$URL" in
  http://*)
    set_env APP_ENV development
    set_env PUBLIC_URL ''
    ;;
  *)
    set_env APP_ENV production
    unset_env PUBLIC_URL
    ;;
esac

say "Nautelle: $URL ($MODE mode), settings in $(pwd)/.env"

if [ "$START" = 0 ]; then
  say 'Start it with: docker compose up -d'
  exit 0
fi

# ─── Start ───────────────────────────────────────────────────────────────────

# Switching modes: the previous mode's proxy would still hold the `proxy` name.
if [ "$fresh" = 0 ] && [ -n "$previous_mode" ] && [ "$previous_mode" != "$MODE" ]; then
  say "Switching from $previous_mode to $MODE mode"
  docker compose --profile "$previous_mode" stop proxy proxy-tunnel proxy-tls cloudflared >/dev/null 2>&1 || true
fi

# NAUTELLE_PULL=0 starts from images already on the host (a locally built
# release candidate); otherwise a re-run also upgrades to the newest tag.
[ "${NAUTELLE_PULL:-1}" = 0 ] || docker compose pull
# The admin's credentials reach the API through this start's environment only;
# the next `docker compose up -d` recreates the API without them.
if [ -n "$ADMIN_EMAIL" ]; then
  ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" docker compose up -d --remove-orphans
else
  docker compose up -d --remove-orphans
fi

say 'Waiting for the API (it migrates the database on its first start)…'
api=$(docker compose ps -q api)
[ -n "$api" ] || fail 'the api container did not start: docker compose logs api'
waited=0
while :; do
  status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$api" 2>/dev/null || echo missing)
  [ "$status" = healthy ] && break
  if [ "$status" = unhealthy ] || [ "$status" = exited ] || [ "$waited" -ge "$HEALTH_TIMEOUT" ]; then
    docker compose logs --tail 50 api >&2 || true
    fail "the API is $status after ${waited}s; the log is above"
  fi
  sleep 3
  waited=$((waited + 3))
done

say ''
say "Nautelle is up: $URL"
say ''
# With no user yet the API logs a one-time setup link on each boot; the latest
# one works until it is used. A container kept from an earlier run may still
# hold a spent link in its log, so ask the API first.
needs_setup=$(docker compose exec -T api node -e "fetch('http://127.0.0.1:8180/setup/status').then((r) => r.json()).then((s) => console.log(s.needsSetup))" 2>/dev/null || true)
if [ "$needs_setup" = true ]; then
  [ -z "$ADMIN_EMAIL" ] ||
    say 'The admin was not created from --admin-email; `docker compose logs api` says why.'
  setup=$(docker compose logs --no-color api 2>/dev/null | grep -o 'http[^ ]*/setup?token=[^ ]*' | tail -n 1 || true)
  if [ -n "$setup" ]; then
    say 'Create the first administrator here (the link works once):'
    say "  $setup"
  else
    say "No setup link in the API log: \`docker compose restart api\` in $(pwd) logs a new one."
  fi
elif [ -n "$ADMIN_EMAIL" ]; then
  say "Sign in as $ADMIN_EMAIL."
else
  say 'Sign in with your account.'
fi
say 'Then pair a runner from Admin › Runners › Add runner.'
