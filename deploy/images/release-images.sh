#!/bin/sh
# Builds the published Nautelle images and, on a release tag, pushes and signs
# them (ADR-0088, ADR-0091, ADR-0097). Run from the repository root;
# .woodpecker/release-images.yml calls it.
#
#   ghcr.io/andreybegma/nautelle-api:X.Y.Z, :X.Y, :X and :latest
#   ghcr.io/andreybegma/nautelle-web:X.Y.Z, :X.Y, :X and :latest
#   ghcr.io/andreybegma/nautelle:X.Y.Z, …   the all-in-one image (ADR-0097)
#
# and the same three on Docker Hub, as docker.io/<namespace>/<prefix>api,
# docker.io/<namespace>/<prefix>web and docker.io/<namespace>/nautelle, with
# DOCKERHUB_NAMESPACE and DOCKERHUB_REPO_PREFIX from deploy/images/dockerhub.env
# (the environment wins): docker.io/abegma/nautelle-api, -web and nautelle.
#
# Each image is built for linux/amd64 and linux/arm64 with buildx on a
# throwaway docker-container builder, the arm64 half under QEMU. It carries the
# OCI labels (source, version, revision, created, title, licenses), and the
# push attaches an SBOM and SLSA provenance (mode=max) to the image index. The
# all-in-one image is assembled from the API and web images just built, by
# digest, not rebuilt from source.
#
# With CI_COMMIT_TAG=vX.Y.Z it checks that X.Y.Z is APP_VERSION (the first
# entry of packages/shared/src/changelog.ts, ADR-0071) and that the signing key
# in COSIGN_PRIVATE_KEY / COSIGN_PASSWORD belongs to deploy/images/cosign.pub,
# then builds, pushes with GHCR_USER / GHCR_TOKEN and signs each image by
# digest. It then copies each index to Docker Hub with DOCKERHUB_USERNAME /
# DOCKERHUB_TOKEN (`imagetools create`: the same bytes, so the same digest,
# SBOM and provenance), checks the digest there and signs it with the same key.
# The repositories must exist and be public: scripts/dockerhub.ts makes them
# so in the step before. The digests go to .release/images.json for the
# GitHub Release step. A pre-release (vX.Y.Z-rc.1) is tagged with its own
# version only. Without a tag, or with NAUTELLE_IMAGES_DRY_RUN=1, it builds
# all three for both platforms and pushes and signs nothing: <APP_VERSION>-dev
# without a tag.
#
# The web image is built for any host: its live socket is the path /api/live
# on the page's own origin, and server components reach the API as
# http://api:8180, the service name in deploy/compose/docker-compose.yml (the
# all-in-one image sets it to loopback at run time).
set -eu

REGISTRY="${NAUTELLE_REGISTRY:-ghcr.io/andreybegma}"
SOURCE_REPO=https://github.com/AndreyBegma/Nautelle
LICENSE=MIT
PLATFORMS=linux/amd64,linux/arm64
TAG="${CI_COMMIT_TAG:-}"
REVISION="${CI_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PUBLIC_KEY=deploy/images/cosign.pub
HUB_SETTINGS=deploy/images/dockerhub.env
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
AIO="$REGISTRY/nautelle"

# An empty prefix set in the environment stays empty: `-`, not `:-`.
hub_setting() { sed -n "s/^$1=//p" "$HUB_SETTINGS" | tail -n 1; }
HUB_NAMESPACE=${DOCKERHUB_NAMESPACE-$(hub_setting DOCKERHUB_NAMESPACE)}
HUB_PREFIX=${DOCKERHUB_REPO_PREFIX-$(hub_setting DOCKERHUB_REPO_PREFIX)}
printf '%s' "$HUB_NAMESPACE" | grep -Eq '^[a-z0-9]+([._-][a-z0-9]+)*$' ||
  fail "DOCKERHUB_NAMESPACE \"$HUB_NAMESPACE\" is not a Docker Hub namespace ($HUB_SETTINGS)"

# The Docker Hub name of one of the three images.
hub_name() {
  case "$1" in
    "$API") echo "docker.io/$HUB_NAMESPACE/${HUB_PREFIX}api" ;;
    "$WEB") echo "docker.io/$HUB_NAMESPACE/${HUB_PREFIX}web" ;;
    "$AIO") echo "docker.io/$HUB_NAMESPACE/nautelle" ;;
  esac
}

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
  [ -n "${DOCKERHUB_USERNAME:-}" ] && [ -n "${DOCKERHUB_TOKEN:-}" ] ||
    fail 'DOCKERHUB_USERNAME and DOCKERHUB_TOKEN are needed to mirror (the dockerhub_* secrets, tag event only)'
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
  # Both logins before the first build: a refused one stops the release
  # before anything is pushed. No server: Docker Hub.
  printf '%s' "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USERNAME" --password-stdin ||
    fail "Docker Hub refused the login of $DOCKERHUB_USERNAME"
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
  case "$name" in
    "$API") set -- -f apps/api/Dockerfile "$@" ;;
    "$WEB")
      set -- -f apps/web/Dockerfile "$@" \
        --build-arg NEXT_PUBLIC_LIVE_URL=/api/live \
        --build-arg API_URL=http://api:8180
      ;;
    "$AIO") set -- -f deploy/all-in-one/Dockerfile "$@" ;;
  esac
  set -- --builder "$BUILDER" --pull "$@"
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

# The digest of the image a build wrote its metadata for ($1).
built_digest() {
  sed -n 's/.*"containerimage\.digest": *"\(sha256:[0-9a-f]\{64\}\)".*/\1/p' "$1" | head -n 1
}

# The API image is checked on the host's own platform before anything is
# pushed (no dev dependencies, the seed present): load that one and run it.
echo "Building $API:$VERSION for the host to check it ($REVISION)"
build "$API" '' --load -t "$API:$VERSION"
sh deploy/staging/check-api-image.sh "$API:$VERSION"

if [ "$push" = 0 ]; then
  # Nothing is pushed, so the all-in-one image takes the API and web images
  # from OCI layouts on disk, under the names its build arguments give.
  aio_sources=
  for name in "$API" "$WEB"; do
    layout="$DOCKER_CONFIG/oci/${name##*/}"
    metadata="$DOCKER_CONFIG/${name##*/}.json"
    echo "Building $name:$VERSION for $PLATFORMS ($REVISION)"
    build "$name" "$PLATFORMS" --metadata-file "$metadata" \
      --output "type=oci,tar=false,dest=$layout"
    digest=$(built_digest "$metadata")
    [ -n "$digest" ] || fail "no image digest in the build metadata of $name"
    arg=API_IMAGE
    [ "$name" = "$API" ] || arg=WEB_IMAGE
    aio_sources="$aio_sources --build-arg $arg=$name:$VERSION --build-context $name:$VERSION=oci-layout://$layout@$digest"
  done
  echo "Building $AIO:$VERSION for the host to check it"
  # shellcheck disable=SC2086 # $aio_sources is a list of arguments.
  build "$AIO" '' $aio_sources --load -t "$AIO:$VERSION"
  sh deploy/all-in-one/check-image.sh "$AIO:$VERSION"
  echo "Building $AIO:$VERSION for $PLATFORMS"
  # shellcheck disable=SC2086
  build "$AIO" "$PLATFORMS" $aio_sources
  echo "Built $API, $WEB and $AIO ($VERSION) for $PLATFORMS; not pushed (no release tag, or a dry run)"
  exit 0
fi

mkdir -p "$(dirname "$OUT")"
entries=
# Push one image ($1) with every tag, the rest extra build arguments; sign it
# by digest and leave the digest in $digest.
push_image() {
  name=$1
  shift
  tags=
  for tag in $TAGS; do tags="$tags -t $name:$tag"; done
  metadata="$DOCKER_CONFIG/${name##*/}.json"
  echo "Building and pushing $name ($TAGS) for $PLATFORMS"
  # shellcheck disable=SC2086 # $tags is a list of arguments.
  build "$name" "$PLATFORMS" "$@" $tags \
    --sbom="generator=$SBOM_SCANNER" --provenance=mode=max \
    --metadata-file "$metadata" --push
  digest=$(built_digest "$metadata")
  [ -n "$digest" ] || fail "no image digest in the build metadata of $name"
  "$COSIGN" sign --yes --key env://COSIGN_PRIVATE_KEY "$name@$digest"
  echo "Pushed and signed $name@$digest"
}

# Copy one pushed image ($1 at $2) to Docker Hub with every tag, check that
# the digest there is the same, and sign it there.
mirror() {
  src=$1
  digest=$2
  hub=$(hub_name "$src")
  set --
  for tag in $TAGS; do set -- "$@" -t "$hub:$tag"; done
  echo "Copying $src@$digest to $hub ($TAGS)"
  docker buildx imagetools create "$@" "$src@$digest" ||
    fail "Docker Hub refused $hub: does the repository exist, public, and may $DOCKERHUB_USERNAME push to it?"
  copied=$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$hub:$VERSION")
  [ "$copied" = "$digest" ] ||
    fail "$hub:$VERSION is $copied, not $digest: the copy is not the same image"
  "$COSIGN" sign --yes --key env://COSIGN_PRIVATE_KEY "$hub@$digest"
  echo "Mirrored and signed $hub@$digest"
}

push_image "$API"
api_digest=$digest
push_image "$WEB"
web_digest=$digest

# The all-in-one image, from the two digests just pushed: checked on the
# host first, as a person would start it.
aio_sources="--build-arg API_IMAGE=$API@$api_digest --build-arg WEB_IMAGE=$WEB@$web_digest"
echo "Building $AIO:$VERSION for the host to check it"
# shellcheck disable=SC2086 # $aio_sources is a list of arguments.
build "$AIO" '' $aio_sources --load -t "$AIO:$VERSION"
sh deploy/all-in-one/check-image.sh "$AIO:$VERSION"
# shellcheck disable=SC2086
push_image "$AIO" $aio_sources
aio_digest=$digest

for pair in "$API $api_digest" "$WEB $web_digest" "$AIO $aio_digest"; do
  # shellcheck disable=SC2086 # $pair is a name and a digest.
  set -- $pair
  mirror "$1" "$2"
  entries="$entries${entries:+,}{\"name\":\"$1\",\"digest\":\"$2\",\"mirror\":\"$(hub_name "$1")\"}"
done

printf '{"version":"%s","tags":"%s","platforms":"%s","images":[%s]}\n' \
  "$VERSION" "$TAGS" "$PLATFORMS" "$entries" >"$OUT"
echo "Wrote $OUT"
