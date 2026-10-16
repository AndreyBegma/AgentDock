#!/bin/sh
# Builds the runner's release assets (ADR-0017) into apps/runner/release/:
#
#   bin/<os>-<arch>/agentdock-runner                  one binary per target
#   agentdock-runner-<version>-<os>-<arch>.tar.gz     what the GitHub Release carries
#   SHA256SUMS                                        checksums of the tarballs
#   npm/agentdock-runner{,-<os>-<arch>}/              the packages npm publishes
#   agentdock-runner.rb                               the Homebrew formula
#
# Needs only Bun and the usual POSIX tools: every target is cross-compiled
# from this machine. Publishes nothing.
#
# RUNNER_TAG, when set (CI sets it to the pushed tag), must be
# runner-v<version of apps/runner/package.json>; anything else is refused.
set -eu

runner=$(cd "$(dirname "$0")/.." && pwd)
cd "$runner"

version=$(bun -e 'process.stdout.write(require("./package.json").version)')
if [ -n "${RUNNER_TAG:-}" ] && [ "$RUNNER_TAG" != "runner-v$version" ]; then
  echo "build-release: tag $RUNNER_TAG does not match apps/runner/package.json version $version (expected runner-v$version)" >&2
  exit 1
fi

# The runner imports @agentdock/shared's built output, so build it first; on a
# clean checkout nothing else has.
(cd "$runner/../.." && bunx turbo run build --filter=@agentdock/shared)

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
  bun build --compile --splitting --format=esm --target="bun-$target" src/main.ts --outfile "$dir/agentdock-runner"
  tar -C "$dir" -czf "$out/agentdock-runner-$version-$target.tar.gz" agentdock-runner
done

cd "$out"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum agentdock-runner-*.tar.gz >SHA256SUMS
else
  shasum -a 256 agentdock-runner-*.tar.gz >SHA256SUMS
fi
cd "$runner"

bun scripts/npm-packages.ts "$out"
sh scripts/render-formula.sh "$version" "$out/SHA256SUMS" >"$out/agentdock-runner.rb"

echo "build-release: $version ready in $out"
cat "$out/SHA256SUMS"
