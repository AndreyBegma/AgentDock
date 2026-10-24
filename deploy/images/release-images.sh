#!/bin/sh
# Builds the published Nautelle images and, on a release tag, pushes them
# (ADR-0088). Run from the repository root; .woodpecker/release-images.yml
# calls it.
#
#   ghcr.io/andreybegma/nautelle-api:<version> and :latest
#   ghcr.io/andreybegma/nautelle-web:<version> and :latest
#
# With CI_COMMIT_TAG=vX.Y.Z it checks that X.Y.Z is APP_VERSION (the first
# entry of packages/shared/src/changelog.ts, ADR-0071), builds both images and
# pushes them with GHCR_USER / GHCR_TOKEN. A pre-release (vX.Y.Z-rc.1) is not
# tagged :latest. Without a tag, or with NAUTELLE_IMAGES_DRY_RUN=1, it builds
# and tags locally and pushes nothing: <APP_VERSION>-dev without a tag.
#
# The web image is built for any host: its live socket is the path /api/live
# on the page's own origin, and server components reach the API as
# http://api:8180, the service name in deploy/compose/docker-compose.yml.
# amd64 only for now: the images are built on the CI host's own daemon.
set -eu

REGISTRY="${NAUTELLE_REGISTRY:-ghcr.io/andreybegma}"
SOURCE_REPO=https://github.com/AndreyBegma/Nautelle
TAG="${CI_COMMIT_TAG:-}"
REVISION="${CI_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"

fail() {
  printf 'release-images: %s\n' "$*" >&2
  exit 1
}

APP_VERSION=$(sed -n "s/^ *version: '\([0-9][^']*\)',\$/\1/p" packages/shared/src/changelog.ts | head -n 1)
[ -n "$APP_VERSION" ] || fail 'no version found in packages/shared/src/changelog.ts'

push=0
if [ -n "$TAG" ]; then
  [ "$TAG" = "v$APP_VERSION" ] ||
    fail "the tag $TAG is not v$APP_VERSION, the version in packages/shared/src/changelog.ts"
  VERSION=$APP_VERSION
  [ "${NAUTELLE_IMAGES_DRY_RUN:-}" = 1 ] || push=1
else
  VERSION="$APP_VERSION-dev"
fi

API="$REGISTRY/nautelle-api"
WEB="$REGISTRY/nautelle-web"

# Build one image: $1 its name, the rest extra `docker build` arguments.
build() {
  name=$1
  shift
  echo "Building $name:$VERSION ($REVISION)"
  docker build --pull \
    --label "org.opencontainers.image.source=$SOURCE_REPO" \
    --label "org.opencontainers.image.version=$VERSION" \
    --label "org.opencontainers.image.revision=$REVISION" \
    --label "org.opencontainers.image.title=${name##*/}" \
    -t "$name:$VERSION" "$@" .
}

build "$API" -f apps/api/Dockerfile
sh deploy/staging/check-api-image.sh "$API:$VERSION"

build "$WEB" -f apps/web/Dockerfile \
  --build-arg NEXT_PUBLIC_LIVE_URL=/api/live \
  --build-arg API_URL=http://api:8180

if [ "$push" = 0 ]; then
  echo "Built $API:$VERSION and $WEB:$VERSION; not pushed (no release tag, or a dry run)"
  exit 0
fi

[ -n "${GHCR_USER:-}" ] && [ -n "${GHCR_TOKEN:-}" ] ||
  fail 'GHCR_USER and GHCR_TOKEN are needed to push (the ghcr_token secret, tag event only)'

# The login lives in a throwaway config, never in the host's ~/.docker.
DOCKER_CONFIG=$(mktemp -d)
export DOCKER_CONFIG
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
printf '%s' "$GHCR_TOKEN" | docker login "${REGISTRY%%/*}" -u "$GHCR_USER" --password-stdin

for image in "$API" "$WEB"; do
  docker push "$image:$VERSION"
  case "$VERSION" in
    *-*) ;;
    *)
      docker tag "$image:$VERSION" "$image:latest"
      docker push "$image:latest"
      ;;
  esac
done
echo "Pushed $API and $WEB at $VERSION"
