#!/bin/sh
# Builds the published Nautelle images and, on a release tag, pushes and signs
# them (ADR-0088, ADR-0091). Run from the repository root;
# .woodpecker/release-images.yml calls it.
#
#   ghcr.io/andreybegma/nautelle-api:X.Y.Z, :X.Y, :X and :latest
#   ghcr.io/andreybegma/nautelle-web:X.Y.Z, :X.Y, :X and :latest
#
# Each image is built for linux/amd64 and linux/arm64 with buildx on a
# throwaway docker-container builder, the arm64 half under QEMU. It carries the
# OCI labels (source, version, revision, created, title, licenses), and the
# push attaches an SBOM and SLSA provenance (mode=max) to the image index.
#
# With CI_COMMIT_TAG=vX.Y.Z it checks that X.Y.Z is APP_VERSION (the first
# entry of packages/shared/src/changelog.ts, ADR-0071) and that the signing key
# in COSIGN_PRIVATE_KEY / COSIGN_PASSWORD belongs to deploy/images/cosign.pub,
# then builds, pushes with GHCR_USER / GHCR_TOKEN and signs each image by
# digest. The digests go to .release/images.json for the GitHub Release step.
# A pre-release (vX.Y.Z-rc.1) is tagged with its own version only. Without a
# tag, or with NAUTELLE_IMAGES_DRY_RUN=1, it builds both platforms and pushes
# and signs nothing: <APP_VERSION>-dev without a tag.
#
# The web image is built for any host: its live socket is the path /api/live
# on the page's own origin, and server components reach the API as
# http://api:8180, the service name in deploy/compose/docker-compose.yml.
set -eu

REGISTRY="${NAUTELLE_REGISTRY:-ghcr.io/andreybegma}"
SOURCE_REPO=https://github.com/AndreyBegma/Nautelle
LICENSE=MIT
PLATFORMS=linux/amd64,linux/arm64
TAG="${CI_COMMIT_TAG:-}"
REVISION="${CI_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PUBLIC_KEY=deploy/images/cosign.pub
OUT=.release/images.json

# The build tooling is pinned by digest like every base image (ADR-0053).
BUILDKIT=moby/buildkit:v0.33.1@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea
BINFMT=tonistiigi/binfmt:qemu-v10.2.3@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0
SBOM_SCANNER=docker/buildkit-syft-scanner:1.12.0@sha256:ae4f3b554449e7e25548e7d8ccc029d17357348e30c6e3df01b92bc93654d6a9

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

# X.Y.Z also moves X.Y, X and latest; a pre-release moves nothing else.
case "$VERSION" in
  *-*) TAGS=$VERSION ;;
  *) TAGS="$VERSION ${VERSION%.*} ${VERSION%%.*} latest" ;;
esac

API="$REGISTRY/nautelle-api"
WEB="$REGISTRY/nautelle-web"

# The login and the builder live in a throwaway config, never in the host's
# ~/.docker; the builder's container is removed on exit.
DOCKER_CONFIG=$(mktemp -d)
export DOCKER_CONFIG
BUILDER="nautelle-release-$$"
cleanup() {
  docker buildx rm --force "$BUILDER" >/dev/null 2>&1 || true
  rm -rf "$DOCKER_CONFIG"
}
trap cleanup EXIT

if [ "$push" = 1 ]; then
  [ -n "${GHCR_USER:-}" ] && [ -n "${GHCR_TOKEN:-}" ] ||
    fail 'GHCR_USER and GHCR_TOKEN are needed to push (the ghcr_token secret, tag event only)'
  [ -n "${COSIGN_PRIVATE_KEY:-}" ] && [ -n "${COSIGN_PASSWORD:-}" ] ||
    fail 'COSIGN_PRIVATE_KEY and COSIGN_PASSWORD are needed to sign (the cosign_* secrets, tag event only)'
  [ -f "$PUBLIC_KEY" ] ||
    fail "$PUBLIC_KEY is missing: commit the public half of the signing key first (deploy/README.md)"

  sh deploy/images/install-cosign.sh "$DOCKER_CONFIG/bin"
  COSIGN="$DOCKER_CONFIG/bin/cosign"
  # A secret whose key does not match the committed public key would sign
  # images nobody can verify: stop before anything is built.
  "$COSIGN" public-key --key env://COSIGN_PRIVATE_KEY >"$DOCKER_CONFIG/secret.pub" ||
    fail 'cannot read the key in COSIGN_PRIVATE_KEY with COSIGN_PASSWORD'
  [ "$(tr -d ' \r\n' <"$DOCKER_CONFIG/secret.pub")" = "$(tr -d ' \r\n' <"$PUBLIC_KEY")" ] ||
    fail "the key in COSIGN_PRIVATE_KEY does not belong to $PUBLIC_KEY"

  printf '%s' "$GHCR_TOKEN" | docker login "${REGISTRY%%/*}" -u "$GHCR_USER" --password-stdin
fi

# QEMU for the arm64 half. The registration is in the host kernel's
# binfmt_misc table and outlives this container (ADR-0091).
docker run --privileged --rm "$BINFMT" --install arm64
docker buildx create --name "$BUILDER" --driver docker-container \
  --driver-opt "image=$BUILDKIT" --bootstrap >/dev/null

# Build one image: $1 its name, $2 the platforms (empty: the host's own),
# the rest extra `docker buildx build` arguments (the output among them).
build() {
  name=$1
  platforms=$2
  shift 2
  app=${name##*-}
  set -- --builder "$BUILDER" --pull -f "apps/$app/Dockerfile" "$@"
  if [ "$app" = web ]; then
    set -- "$@" --build-arg NEXT_PUBLIC_LIVE_URL=/api/live \
      --build-arg API_URL=http://api:8180
  fi
  for key in "source=$SOURCE_REPO" "version=$VERSION" "revision=$REVISION" \
    "created=$CREATED" "title=${name##*/}" "licenses=$LICENSE"; do
    set -- "$@" --label "org.opencontainers.image.$key"
    # The index of a multi-platform image carries them too: GHCR reads the
    # index, not the per-platform configs.
    [ -z "$platforms" ] || set -- "$@" --annotation "index:org.opencontainers.image.$key"
  done
  [ -z "$platforms" ] || set -- "$@" --platform "$platforms"
  docker buildx build "$@" .
}

# The API image is checked on the host's own platform before anything is
# pushed (no dev dependencies, the seed present): load that one and run it.
echo "Building $API:$VERSION for the host to check it ($REVISION)"
build "$API" '' --load -t "$API:$VERSION"
sh deploy/staging/check-api-image.sh "$API:$VERSION"

if [ "$push" = 0 ]; then
  for name in "$API" "$WEB"; do
    echo "Building $name:$VERSION for $PLATFORMS ($REVISION)"
    build "$name" "$PLATFORMS"
  done
  echo "Built $API:$VERSION and $WEB:$VERSION for $PLATFORMS; not pushed (no release tag, or a dry run)"
  exit 0
fi

mkdir -p "$(dirname "$OUT")"
entries=
for name in "$API" "$WEB"; do
  tags=
  for tag in $TAGS; do tags="$tags -t $name:$tag"; done
  metadata="$DOCKER_CONFIG/${name##*/}.json"
  echo "Building and pushing $name ($TAGS) for $PLATFORMS"
  # shellcheck disable=SC2086 # $tags is a list of arguments.
  build "$name" "$PLATFORMS" $tags \
    --sbom="generator=$SBOM_SCANNER" --provenance=mode=max \
    --metadata-file "$metadata" --push
  digest=$(sed -n 's/.*"containerimage\.digest": *"\(sha256:[0-9a-f]\{64\}\)".*/\1/p' "$metadata" | head -n 1)
  [ -n "$digest" ] || fail "no image digest in the build metadata of $name"
  "$COSIGN" sign --yes --key env://COSIGN_PRIVATE_KEY "$name@$digest"
  entries="$entries${entries:+,}{\"name\":\"$name\",\"digest\":\"$digest\"}"
  echo "Pushed and signed $name@$digest"
done

printf '{"version":"%s","tags":"%s","platforms":"%s","images":[%s]}\n' \
  "$VERSION" "$TAGS" "$PLATFORMS" "$entries" >"$OUT"
echo "Wrote $OUT"
