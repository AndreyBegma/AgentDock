#!/bin/sh
# Starts staging from the images already built — builds nothing. Run on the
# host from /home/archi/stacks/agentdock-staging.
set -eu
cd "$(dirname "$0")"

for file in .env env/api.env env/cloudflared.env; do
  [ -f "$file" ] || { echo "$file is missing — run the pipeline once (deploy/README.md)" >&2; exit 1; }
done
grep -qE '^TUNNEL_TOKEN=.+' env/cloudflared.env \
  || { echo "TUNNEL_TOKEN is empty in env/cloudflared.env" >&2; exit 1; }

docker compose up -d --remove-orphans
docker compose ps
