#!/bin/sh
# Builds the runner's release assets (ADR-0017) into apps/runner/release/:
#
#   bin/<os>-<arch>/nautelle-runner                  one binary per target
#   nautelle-runner-<version>-<os>-<arch>.tar.gz     what the GitHub Release carries
#   SHA256SUMS                                        checksums of the tarballs and binaries
#   SHA256SUMS.sig                                    its Ed25519 signature (ADR-0049)
#   npm/nautelle-runner{,-<os>-<arch>}/              the packages npm publishes
#   nautelle-runner.rb                               the Homebrew formula
#
# Needs only Bun and the usual POSIX tools: every target is cross-compiled
# from this machine. Publishes nothing.
#
# RUNNER_TAG, when set (CI sets it to the pushed tag), must be
# runner-v<version of apps/runner/package.json>; anything else is refused.
#
# RUNNER_SIGNING_KEY is the PEM private key whose public half is
# apps/runner/release-key.pub; SHA256SUMS is signed with it. A tag run without
# it fails before building. Any other run without it signs with a throwaway
# key, so every asset is still built, but the npm shim and the formula refuse
# what it signs.
set -eu

runner=$(cd "$(dirname "$0")/.." && pwd)
cd "$runner"

version=$(bun -e 'process.stdout.write(require("./package.json").version)')
if [ -n "${RUNNER_TAG:-}" ] && [ "$RUNNER_TAG" != "runner-v$version" ]; then
  echo "build-release: tag $RUNNER_TAG does not match apps/runner/package.json version $version (expected runner-v$version)" >&2
  exit 1
fi
if [ -n "${RUNNER_TAG:-}" ] && [ -z "${RUNNER_SIGNING_KEY:-}" ]; then
  echo "build-release: RUNNER_SIGNING_KEY is not set; a tag run must sign SHA256SUMS (the Woodpecker secret runner_signing_key, tag events only)" >&2
  exit 1
fi

# The runner imports @nautelle/shared's built output, so build it first; on a
# clean checkout nothing else has.
(cd "$runner/../.." && bunx turbo run build --filter=@nautelle/shared)

targets="darwin-arm64 darwin-x64 linux-x64 linux-arm64"
out="$runner/release"
rm -rf "$out"
mkdir -p "$out"

for target in $targets; do
  dir="$out/bin/$target"
  mkdir -p "$dir"
  echo "build-release: $version $target"
  # --splitting keeps `filter` / `filter-hook` from parsing the whole runner
  # at start-up (#445 D3: p95 <= 50 ms per command); still one binary.
  bun build --compile --splitting --format=esm --target="bun-$target" src/main.ts --outfile "$dir/nautelle-runner"
  tar -C "$dir" -czf "$out/nautelle-runner-$version-$target.tar.gz" nautelle-runner
done

# The binaries are listed too: the npm shim checks the one it runs.
cd "$out"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum nautelle-runner-*.tar.gz bin/*/nautelle-runner >SHA256SUMS
else
  shasum -a 256 nautelle-runner-*.tar.gz bin/*/nautelle-runner >SHA256SUMS
fi
cd "$runner"

if [ -n "${RUNNER_SIGNING_KEY:-}" ]; then
  bun scripts/sign-sums.ts "$out"
else
  echo "build-release: RUNNER_SIGNING_KEY is not set; signing with a throwaway key, so nothing built here installs" >&2
  bun scripts/sign-sums.ts --throwaway "$out"
fi

bun scripts/npm-packages.ts "$out"
sh scripts/render-formula.sh "$version" "$out/SHA256SUMS" "$out/SHA256SUMS.sig" >"$out/nautelle-runner.rb"

echo "build-release: $version ready in $out"
cat "$out/SHA256SUMS"
