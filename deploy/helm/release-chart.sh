#!/bin/sh
# Packages the Helm chart and, on a release tag, pushes it to ghcr as an OCI
# artifact (ADR-0092). Run from the repository root;
# .woodpecker/release-images.yml calls it.
#
#   oci://ghcr.io/andreybegma/charts/nautelle:<version>
#
# The chart is versioned with the product: version and appVersion are both
# X.Y.Z, so `--version X.Y.Z` installs the images of release X.Y.Z. With
# CI_COMMIT_TAG=vX.Y.Z it checks that X.Y.Z is APP_VERSION (the first entry of
# packages/shared/src/changelog.ts, ADR-0071), lints and packages the chart
# and pushes it with GHCR_USER / GHCR_TOKEN. Without a tag, or with
# NAUTELLE_CHART_DRY_RUN=1, it packages <APP_VERSION>-dev into
# NAUTELLE_CHART_OUT (default .helm-out) and pushes nothing.
set -eu

REGISTRY="${NAUTELLE_REGISTRY:-ghcr.io/andreybegma}"
CHART=deploy/helm/nautelle
OUT="${NAUTELLE_CHART_OUT:-.helm-out}"
TAG="${CI_COMMIT_TAG:-}"

fail() {
  printf 'release-chart: %s\n' "$*" >&2
  exit 1
}

APP_VERSION=$(sed -n "s/^ *version: '\([0-9][^']*\)',\$/\1/p" packages/shared/src/changelog.ts | head -n 1)
[ -n "$APP_VERSION" ] || fail 'no version found in packages/shared/src/changelog.ts'

push=0
if [ -n "$TAG" ]; then
  [ "$TAG" = "v$APP_VERSION" ] ||
    fail "the tag $TAG is not v$APP_VERSION, the version in packages/shared/src/changelog.ts"
  VERSION=$APP_VERSION
  [ "${NAUTELLE_CHART_DRY_RUN:-}" = 1 ] || push=1
else
  VERSION="$APP_VERSION-dev"
fi

mkdir -p "$OUT"
helm lint --strict "$CHART"
helm package "$CHART" --version "$VERSION" --app-version "$VERSION" --destination "$OUT"
PACKAGE="$OUT/nautelle-$VERSION.tgz"
[ -f "$PACKAGE" ] || fail "helm package wrote no $PACKAGE"

if [ "$push" = 0 ]; then
  echo "Packaged $PACKAGE; not pushed (no release tag, or a dry run)"
  exit 0
fi

[ -n "${GHCR_USER:-}" ] && [ -n "${GHCR_TOKEN:-}" ] ||
  fail 'GHCR_USER and GHCR_TOKEN are needed to push (the ghcr_token secret, tag event only)'

# The login lives in a throwaway file, never in the step's home directory.
HELM_REGISTRY_CONFIG=$(mktemp)
export HELM_REGISTRY_CONFIG
trap 'rm -f "$HELM_REGISTRY_CONFIG"' EXIT
printf '%s' "$GHCR_TOKEN" | helm registry login "${REGISTRY%%/*}" -u "$GHCR_USER" --password-stdin

helm push "$PACKAGE" "oci://$REGISTRY/charts"
echo "Pushed oci://$REGISTRY/charts/nautelle:$VERSION"
