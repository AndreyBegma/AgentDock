#!/bin/sh
# Installs a pinned cosign into a directory (default /usr/local/bin) for
# deploy/images/release-images.sh (ADR-0091). The binary is checked against
# the checksums pinned here, not against a file fetched from the same place.
#
#   sh deploy/images/install-cosign.sh [dir]
set -eu

version=3.1.3
case $(uname -m) in
  x86_64 | amd64)
    arch=amd64
    sum=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71
    ;;
  aarch64 | arm64)
    arch=arm64
    sum=c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a
    ;;
  *)
    echo "install-cosign: unsupported architecture $(uname -m)" >&2
    exit 1
    ;;
esac

dir="${1:-/usr/local/bin}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# wget: the docker:cli image has busybox wget and no curl.
wget -q -O "$work/cosign" \
  "https://github.com/sigstore/cosign/releases/download/v$version/cosign-linux-$arch"
echo "$sum  $work/cosign" | sha256sum -c - >/dev/null
mkdir -p "$dir"
install -m 0755 "$work/cosign" "$dir/cosign"
"$dir/cosign" version >/dev/null
echo "install-cosign: cosign $version in $dir"
