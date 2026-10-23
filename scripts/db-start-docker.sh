#!/bin/sh
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER_ENV="$ROOT/docker/.env"
API_ENV="$ROOT/apps/api/.env"

# 48 hex characters: random, and safe inside a URL and a sed replacement.
random_password() {
  od -An -tx1 -N24 /dev/urandom | tr -d ' \n'
}

env_value() {
  grep "^$1=" "$2" | tail -n 1 | cut -d= -f2-
}

# Replace one pattern in a file without `sed -i`, which differs between GNU and BSD.
replace_in() {
  sed "$1" "$2" > "$2.tmp"
  mv "$2.tmp" "$2"
}

[ -f "$DOCKER_ENV" ] || cp "$ROOT/docker/.env.example" "$DOCKER_ENV"
[ -f "$API_ENV" ] || cp "$ROOT/apps/api/.env.example" "$API_ENV"

# The examples ship no passwords: generate the missing ones, so no dev database
# runs with a password copied from the repository.
GENERATED_POSTGRES=
for name in POSTGRES_PASSWORD REDIS_PASSWORD; do
  if [ -z "$(env_value "$name" "$DOCKER_ENV")" ]; then
    password="$(random_password)"
    if grep -q "^$name=" "$DOCKER_ENV"; then
      replace_in "s/^$name=.*/$name=$password/" "$DOCKER_ENV"
    else
      echo "$name=$password" >> "$DOCKER_ENV"
    fi
    echo "Generated $name in docker/.env."
    if [ "$name" = POSTGRES_PASSWORD ]; then
      GENERATED_POSTGRES=1
    fi
  fi
done

POSTGRES_PASSWORD="$(env_value POSTGRES_PASSWORD "$DOCKER_ENV")"
REDIS_PASSWORD="$(env_value REDIS_PASSWORD "$DOCKER_ENV")"

# Fill the URLs of apps/api/.env that have no password yet; a URL that has one
# is left alone.
replace_in "s|postgresql://postgres:@|postgresql://postgres:$POSTGRES_PASSWORD@|g" "$API_ENV"
replace_in "s|redis://:@|redis://:$REDIS_PASSWORD@|g" "$API_ENV"

if [ -n "$GENERATED_POSTGRES" ] && docker volume inspect agentdock_postgres_data > /dev/null 2>&1; then
  echo "Warning: the volume agentdock_postgres_data already exists and keeps the password it was created with; set that one in docker/.env and apps/api/.env, or remove the volume." >&2
fi

echo "Starting PostgreSQL and Redis..."
docker compose -f "$ROOT/docker/docker-compose.yml" up -d

echo "Waiting for PostgreSQL to be ready..."
until docker exec agentdock-postgres pg_isready -U postgres > /dev/null 2>&1; do
  sleep 1
done

echo "Waiting for Redis to be ready..."
until docker exec agentdock-redis redis-cli ping 2> /dev/null | grep -q PONG; do
  sleep 1
done

cd "$ROOT/apps/api"

if [ -d prisma/migrations ] && [ -n "$(ls -A prisma/migrations 2>/dev/null)" ]; then
  echo "Applying migrations..."
  bunx prisma migrate deploy
else
  echo "No migrations yet — creating the initial one..."
  bunx prisma migrate dev --name init
fi

echo "Running seed..."
bunx prisma db seed

echo "Done. PostgreSQL is up on 127.0.0.1:5421, Redis on 127.0.0.1:6421"
