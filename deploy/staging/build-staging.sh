#!/bin/sh
# Builds the staging images on the agent host's Docker daemon (ADR-0016).
# Run from the repository root; the pipeline's `build-staging` step calls it.
# The mutable tag `:staging` is the boundary: refresh.sh starts whatever it
# points at.
set -eu

HOST="https://staging-agentdock.luna-realm.com"
REVISION="${CI_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"

echo "Building agentdock-api:staging ($REVISION)"
docker build --pull \
  --label "org.opencontainers.image.revision=$REVISION" \
  --label agentdock.stage=staging \
  -t agentdock-api:staging \
  -f apps/api/Dockerfile .

echo "Building agentdock-web:staging ($REVISION)"
docker build --pull \
  --label "org.opencontainers.image.revision=$REVISION" \
  --label agentdock.stage=staging \
  --build-arg "NEXT_PUBLIC_LIVE_URL=wss://${HOST#https://}/api/live" \
  --build-arg "API_URL=http://api:8180" \
  -t agentdock-web:staging \
  -f apps/web/Dockerfile .

# The previous :staging images are now dangling. Only ours: other stacks share
# this daemon. The build cache stays.
docker image prune -f --filter label=agentdock.stage=staging >/dev/null
