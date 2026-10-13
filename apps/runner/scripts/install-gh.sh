#!/bin/sh
# Installs a pinned GitHub CLI into /usr/local/bin for the release steps of
# .woodpecker/release-runner.yml. The CI image does not carry gh; the tarball
# is checked against the release's own checksums before it is unpacked.
set -eu

version=2.63.2
case $(uname -m) in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *)
    echo "install-gh: unsupported architecture $(uname -m)" >&2
    exit 1
    ;;
esac

name="gh_${version}_linux_${arch}"
work=$(mktemp -d)
cd "$work"
base="https://github.com/cli/cli/releases/download/v$version"
curl -fsSLO "$base/$name.tar.gz"
curl -fsSLO "$base/gh_${version}_checksums.txt"
grep " $name.tar.gz\$" "gh_${version}_checksums.txt" | sha256sum -c -
tar -xzf "$name.tar.gz"
install -m 0755 "$name/bin/gh" /usr/local/bin/gh
cd /
rm -rf "$work"
gh --version
