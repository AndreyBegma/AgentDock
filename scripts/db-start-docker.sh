#!/bin/sh
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -f "$ROOT/docker/.env" ]; then
  echo "docker/.env is missing — copy docker/.env.example and set POSTGRES_PASSWORD and REDIS_PASSWORD (match apps/api/.env)." >&2
  exit 1
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

echo "Done. PostgreSQL is up on port 5421, Redis on port 6421"
