# ADR-0092: The user documentation is a Starlight site published to GitHub Pages

Status: accepted · Date: 2026-10-24 ·
Card: C-373 ·
Spec: [`docs/specs/card-373-open-source-polish-readme-and-a-document.md`](../specs/card-373-open-source-polish-readme-and-a-document.md) ·
Amends [ADR-0088](0088-nautelle-installs-from-published-images-with-one-compose-file.md) (the install guide moves out of `docs/guides/`) ·
Keeps: [ADR-0053](0053-pull-request-pipelines-are-untrusted.md), [ADR-0071](0071-the-product-is-released-by-version-with-a-changelog-and-release-notes.md)

## Context

Since ADR-0088 anyone can install Nautelle with one command, but everything
a person running it needs to read lives in `docs/`, next to the ADRs and
specs written for the people building it: one long install guide, and the
settings spread over three `.env.example` files. There is no place to send
someone who wants to know what Nautelle is, how to put it behind their own
proxy, how to back it up or what it sends where. The README also mixed the
product pitch with contributor setup and internal staging details.

## Decision

1. **A documentation site in `apps/docs`.** It is an Astro Starlight
   workspace (Bun, Biome, exact pins like every other package), built
   statically, with light and dark themes and Starlight's built-in search.
   Its sections are Getting started (requirements, install, first run,
   pairing a runner, connecting a project), Configuration, Operations
   (upgrade, backup and restore, reverse proxies, Kubernetes, troubleshooting,
   privacy) and Concepts. Concept pages explain in a few paragraphs and link to
   the ADRs for the reasoning.
2. **`docs/` stays the engineering authority.** ADRs, specs, architecture and
   contributor guides stay where they are and are not copied into the site. The
   site is for people running Nautelle; when it and an ADR disagree, the ADR
   wins and the site is fixed. `docs/guides/install.md` moves into the site
   (Getting started and Operations) and is deleted, so the install has one
   description.
3. **GitHub Pages, published by the release tag.** `vX.Y.Z` runs
   `.woodpecker/release-docs.yml`, which builds the site and pushes it to the
   `gh-pages` branch with `deploy/docs/publish-docs.sh`; GitHub Pages serves
   that branch at `https://andreybegma.github.io/Nautelle/`. The site therefore
   describes the latest release, not `develop`. A pre-release tag builds but
   does not publish. `DOCS_SITE` and `DOCS_BASE` move the build to another
   host without a code change.
4. **The release follows ADR-0053.** The push secret `pages_token` (a
   fine-grained token with contents write on the repository) is restricted to
   the tag event; a manual run with `[docs-release]` in its message is a dry run
   that builds and publishes nothing; pull requests never run the workflow.
   Only the `ci-image` step mounts the Docker socket, and `bun install` keeps
   to `bun.lock`. Pull requests still build the site through the ordinary
   `bun run build` step, so a broken page fails there before a release.
5. **The settings page is generated.** `scripts/env-reference.ts` writes
   `configuration/environment.md` from `deploy/compose/.env.example`,
   `apps/api/.env.example` and `apps/web/.env.example`, which stay the source
   of truth: a variable's comment block becomes its description, a commented
   out line marks it optional. `bun run check` runs it with `--check` and
   fails when the page and the examples differ, so a variable added to an
   example without `bun run docs:env` fails CI.
6. **The README is the front page.** It pitches the product, shows the Board,
   gives the three-step quick start and links to the site; contributor setup is
   one short section pointing at the agent rules, and internal staging details
   stay in `deploy/README.md`.

## Consequences

- A variable documented only in an example's comments is documented on the
  site too; the examples' comments are now user-facing text and are written
  for a reader who runs Nautelle.
- The site changes on a release, not on a merge. A fix to the docs alone
  reaches the site with the next release tag, or a maintainer can re-run the
  tag pipeline.
- GitHub Pages must be enabled once, serving the `gh-pages` branch, and the
  `pages_token` secret added (deploy/README.md, Publishing the docs).
- A pull request that changes only Markdown skips `build` (pipeline.yml's
  docs-only filter), so a page that breaks the build is caught by the next
  pull request that builds, or by the release.
- Links that pointed at `docs/guides/install.md` point at the site.
