#!/bin/sh
# Prints the Homebrew formula of a runner release (ADR-0017): the template in
# apps/runner/homebrew/ with the version, each target's checksum, and the
# checksums of SHA256SUMS and SHA256SUMS.sig filled in. The formula checks the
# signature itself at install time (ADR-0047).
#
#   sh scripts/render-formula.sh <version> <SHA256SUMS> <SHA256SUMS.sig> > agentdock-runner.rb
#
# Fails when SHA256SUMS lacks a target's tarball.
set -eu

if [ $# -ne 3 ]; then
  echo "usage: render-formula.sh <version> <SHA256SUMS> <SHA256SUMS.sig>" >&2
  exit 2
fi
version=$1
sums=$2
sig=$3
for file in "$sums" "$sig"; do
  if [ ! -f "$file" ]; then
    echo "render-formula: $file does not exist" >&2
    exit 1
  fi
done
template="$(cd "$(dirname "$0")/.." && pwd)/homebrew/agentdock-runner.rb.template"

# The checksum of one target's tarball; sha256sum may mark binary mode with '*'.
sha() {
  file="agentdock-runner-$version-$1.tar.gz"
  value=$(awk -v f="$file" '{ name = $2; sub(/^\*/, "", name) } name == f { print $1 }' "$sums")
  case $value in
    [0-9a-f]*) ;;
    *)
      echo "render-formula: no checksum for $file in $sums" >&2
      exit 1
      ;;
  esac
  if [ ${#value} -ne 64 ]; then
    echo "render-formula: checksum for $file is not a sha256: $value" >&2
    exit 1
  fi
  printf '%s' "$value"
}

darwin_arm64=$(sha darwin-arm64)
darwin_x64=$(sha darwin-x64)
linux_arm64=$(sha linux-arm64)
linux_x64=$(sha linux-x64)

# The checksum of a whole file.
file_sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}
sums_sha=$(file_sha "$sums")
sig_sha=$(file_sha "$sig")

sed \
  -e "s/@VERSION@/$version/g" \
  -e "s/@SHA256_DARWIN_ARM64@/$darwin_arm64/" \
  -e "s/@SHA256_DARWIN_X64@/$darwin_x64/" \
  -e "s/@SHA256_LINUX_ARM64@/$linux_arm64/" \
  -e "s/@SHA256_LINUX_X64@/$linux_x64/" \
  -e "s/@SHA256_SUMS@/$sums_sha/" \
  -e "s/@SHA256_SUMS_SIG@/$sig_sha/" \
  "$template"
