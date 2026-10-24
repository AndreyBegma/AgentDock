#!/bin/sh
# Lints and renders the Nautelle chart (ADR-0092). Run from the repository
# root with helm on the PATH; the `helm` step of .woodpecker/pipeline.yml does,
# and `kubeconform` then validates what it wrote.
#
#   sh deploy/helm/check-chart.sh [out-dir]    # default: .helm-out
#
# Each values file renders once: the defaults, then every ci/*.yaml. The
# manifests land in <out-dir>/<name>.yaml. It fails when helm does, when a
# third-party image is not pinned by @sha256 (ADR-0053; Nautelle's own images
# follow appVersion, ADR-0088), and when a contradictory setting renders.
set -eu

CHART=deploy/helm/nautelle
OUT="${1:-.helm-out}"

fail() {
  printf 'check-chart: %s\n' "$*" >&2
  exit 1
}

rm -rf "$OUT"
mkdir -p "$OUT"

render() {
  name=$1
  shift
  echo "helm lint + template: $name"
  helm lint --strict "$CHART" "$@"
  helm template nautelle "$CHART" --namespace nautelle "$@" >"$OUT/$name.yaml"
  unpinned=$(grep -E '^ *image: ' "$OUT/$name.yaml" |
    grep -vE '@sha256:[0-9a-f]{64}"?$' |
    grep -vE 'image: "?ghcr\.io/andreybegma/nautelle-(api|web):' || true)
  [ -z "$unpinned" ] || fail "$name: images not pinned by @sha256: $unpinned"
}

render default
for values in "$CHART"/ci/*.yaml; do
  render "$(basename "$values" .yaml)" -f "$values"
done

# Settings the chart must refuse.
refuse() {
  reason=$1
  shift
  if helm template nautelle "$CHART" "$@" >/dev/null 2>&1; then
    fail "rendered although $reason"
  fi
  echo "refused, as it should: $reason"
}

refuse 'postgresql is bundled and external' --set externalDatabase.url=postgresql://x
refuse 'no database at all' --set postgresql.enabled=false
refuse 'redis is bundled and external' --set externalRedis.url=redis://x
refuse 'no redis at all' --set redis.enabled=false
refuse 'two tunnel tokens' --set tunnel.token=a --set tunnel.existingSecret=b

echo "check-chart: rendered $(ls "$OUT" | wc -l) value set(s) into $OUT"
