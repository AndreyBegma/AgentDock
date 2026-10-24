#!/bin/sh
# Checks a built all-in-one image (ADR-0097) the way a person first meets it:
# started with no configuration, in demo mode, it must become healthy (the
# API answers through Caddy on :8000) and print the one-time setup link.
# deploy/images/release-images.sh calls it before anything of it is pushed.
#
#   sh deploy/all-in-one/check-image.sh <image>
set -eu

IMAGE="${1:?usage: check-image.sh <image>}"
NAME="nautelle-aio-check-$$"
TIMEOUT=300

fail() {
  printf 'check-aio-image: %s\n' "$*" >&2
  docker logs "$NAME" >&2 2>&1 || true
  exit 1
}

# Kept after an exit for its log; `rm -v` also removes the anonymous /data.
docker run -d --name "$NAME" "$IMAGE" >/dev/null
trap 'docker rm -f -v "$NAME" >/dev/null 2>&1 || true' EXIT

waited=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null)" = healthy ]; do
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ] ||
    fail "$IMAGE exited before it became healthy"
  [ "$waited" -lt "$TIMEOUT" ] || fail "$IMAGE is not healthy after ${TIMEOUT}s"
  sleep 5
  waited=$((waited + 5))
done

docker logs "$NAME" 2>&1 | grep -q 'DEMO MODE, not for production' ||
  fail 'no demo-mode warning in the log'
docker logs "$NAME" 2>&1 | grep -q '/setup?token=' ||
  fail 'no setup link in the log'
echo "check-aio-image: $IMAGE ok (healthy after about ${waited}s)"
