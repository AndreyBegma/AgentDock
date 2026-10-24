#!/bin/sh
# Builds the documentation site (apps/docs) and, on a release tag, publishes
# it to the gh-pages branch that GitHub Pages serves (ADR-0093). Run from the
# repository root after `bun install --frozen-lockfile`;
# .woodpecker/release-docs.yml calls it.
#
# With CI_COMMIT_TAG=vX.Y.Z and PAGES_TOKEN it replaces the whole gh-pages
# branch with one commit holding the build. A pre-release tag (vX.Y.Z-rc.1),
# no tag, or NAUTELLE_DOCS_DRY_RUN=1 builds and publishes nothing.
set -eu

REPO=AndreyBegma/Nautelle
TAG="${CI_COMMIT_TAG:-}"
OUT=apps/docs/dist

fail() {
  printf 'publish-docs: %s\n' "$*" >&2
  exit 1
}

# The settings page must match the .env.example files of this commit.
bun scripts/env-reference.ts --check
bun run --cwd apps/docs build
[ -f "$OUT/index.html" ] || fail "the build wrote no $OUT/index.html"

case "$TAG" in
  v*-*) echo "Built the docs; a pre-release tag ($TAG) does not publish"; exit 0 ;;
  v*) ;;
  *) echo 'Built the docs; not published (no release tag)'; exit 0 ;;
esac
if [ "${NAUTELLE_DOCS_DRY_RUN:-}" = 1 ]; then
  echo 'Built the docs; not published (a dry run)'
  exit 0
fi
[ -n "${PAGES_TOKEN:-}" ] ||
  fail 'PAGES_TOKEN is needed to publish (the github_release_token secret, tag event only)'

# GitHub Pages runs no Jekyll on the build: Astro's _astro/ would be dropped.
touch "$OUT/.nojekyll"

# A fresh repository in the build directory: gh-pages holds one commit, the
# current release, so it never grows with old builds. The token goes in a
# header, never in a URL a log could print.
AUTH=$(printf 'x-access-token:%s' "$PAGES_TOKEN" | base64 | tr -d '\n')
cd "$OUT"
git init --quiet --initial-branch gh-pages
git config user.name 'Nautelle release'
git config user.email 'release@nautelle.invalid'
git add -A
git commit --quiet -m "Docs for $TAG"
git -c http.extraHeader="Authorization: Basic $AUTH" \
  push --force --quiet "https://github.com/$REPO.git" gh-pages
echo "Published the docs for $TAG to gh-pages"
