#!/bin/sh
# Scans the git history for secrets with gitleaks and .gitleaks.toml:
# `bun run check:secrets [gitleaks flags]`, e.g. --log-opts=develop..HEAD for
# the commits of the current branch only. Exits 1 when it finds one.
#
# A gitleaks on the PATH is used as it is; otherwise the image the CI step
# pins runs through Docker.
set -e

# Keep in step with the `secrets` step in .woodpecker/pipeline.yml.
IMAGE=ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks git --no-banner --redact --config .gitleaks.toml "$@" .
fi

# In a worktree .git is a file naming a directory of the main repository:
# mount that repository's git directory too, at its own path.
COMMON="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
exec docker run --rm --security-opt label=disable \
  -v "$ROOT:$ROOT:ro" -v "$COMMON:$COMMON:ro" -w "$ROOT" \
  "$IMAGE" git --no-banner --redact --config .gitleaks.toml "$@" .
