#!/bin/sh
# Checks a built API image (C-172): no dev tooling under node_modules, no local
# `data/` directory from the build context, and the compiled seed the
# entrypoint runs is present. build-staging.sh calls it after the build, so a
# change that brings dev dependencies back fails the deploy.
#
#   sh deploy/staging/check-api-image.sh [image]   (default agentdock-api:staging)
set -eu

IMAGE="${1:-agentdock-api:staging}"

docker run --rm --entrypoint sh "$IMAGE" -c '
  status=0
  for found in $(find /app -type d \( -path "*/node_modules/ts-node" \
      -o -path "*/node_modules/jest" -o -path "*/node_modules/@nestjs/cli" \) \
      2>/dev/null); do
    echo "check-api-image: dev dependency in the image: $found" >&2
    status=1
  done
  for found in $(find /app -path "*/node_modules" -prune -o -type d -name data \
      -print 2>/dev/null); do
    echo "check-api-image: build-context data directory in the image: $found" >&2
    status=1
  done
  if [ ! -f /app/apps/api/dist/prisma/seed.js ]; then
    echo "check-api-image: dist/prisma/seed.js (the entrypoint seed) is missing" >&2
    status=1
  fi
  exit $status
'
echo "check-api-image: $IMAGE ok"
