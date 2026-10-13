#!/bin/sh
# What is deployed and whether it answers. Run on the host from
# /home/archi/stacks/agentdock-staging.
set -u
cd "$(dirname "$0")"

HOST="https://staging-agentdock.luna-realm.com"

echo "── deployed"
cat deployed.env 2>/dev/null || echo "(no deployed.env — never deployed by refresh.sh)"

echo
echo "── containers"
docker compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Image}}'

echo
echo "── images"
for image in agentdock-api:staging agentdock-web:staging; do
  docker image inspect -f "$image  {{.Created}}  {{index .Config.Labels \"org.opencontainers.image.revision\"}}" "$image" 2>/dev/null \
    || echo "$image  (missing)"
done

echo
echo "── public"
for path in / /api/health; do
  printf '%-14s %s\n' "$path" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HOST$path")"
done
echo "(530 / error 1033: the hostname exists but no tunnel connector is running)"
