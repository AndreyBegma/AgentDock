# ADR-0071: The product is released by version, with a changelog and release notes

Status: accepted · Date: 2026-10-20 ·
Card: C-294 ·
Spec: [`docs/specs/card-294-versioned-releases-with-generated-releas.md`](../specs/card-294-versioned-releases-with-generated-releas.md) ·
Keeps: [ADR-0049](0049-runner-releases-are-signed-and-cut-only-from-protected-tags.md) ·
Amended by [ADR-0088](0088-nautelle-installs-from-published-images-with-one-compose-file.md) (a `vX.Y.Z` tag publishes the images)

## Context

`develop` deploys to staging and `main` is what people run. Promotions from
`develop` to `main` happen as untitled "Develop" pull requests, with no
version, no notes and nothing in the app that tells a person what changed.
Only the runner has a version: it is published to npm and Homebrew from
protected `runner-v*` tags (ADR-0049) and keeps
`apps/runner/CHANGELOG.md`.

A person who opens AgentDock after a promotion cannot tell what is new, and a
reviewer of a promotion cannot tell what it carries without reading every
merged pull request.

## Decision

1. **One product version, semver on 0.x.** The product is versioned as
   `X.Y.Z` and tagged `vX.Y.Z` on `main`. The first version is `0.14.0`,
   independent of the runner's `0.13.0`. A release with any user-visible
   feature bumps MINOR; a release with fixes only bumps PATCH; a window with
   nothing user-visible is no release. Moving to `1.0.0` is a person's
   decision, never the skill's.
2. **The changelog is data in `packages/shared`.** `CHANGELOG` in
   `packages/shared/src/changelog.ts` is `{ version, date, items: { kind:
   'new' | 'improved' | 'fixed', text }[] }[]`, newest first, and
   `APP_VERSION` is its first entry's version. The web app renders it and the
   API reports it, so both always agree with the build. A released entry is
   never edited.
3. **Each release has a note in the docs.** `docs/releases/vX.Y.Z.md` holds
   the summary, the items, every merged pull request of the window with its
   link and classification, and the runner release of the window if one
   shipped. `docs/releases/README.md` indexes them.
4. **The What's new dot is per person and server-side.** `user_settings`
   gains `seenVersion`. `GET /me/whats-new` answers `{ version, seenVersion,
   unread }`; `POST /me/whats-new/seen` records the API's own `APP_VERSION`,
   never a version the client sends. The web app shows a dot on the avatar and
   on the account menu's What's new entry while `unread`, and opening
   `/whats-new` clears it. It is not audited: a read receipt changes nothing
   another person sees. Browser storage is not used, so the dot follows the
   person across devices.
5. **A Claude skill cuts the release.** `.claude/skills/release/SKILL.md`
   collects the pull requests merged into `develop` since the last `vX.Y.Z`
   tag, classifies each as new, improved, fixed or excluded (CI, dependencies,
   refactors, tests, documentation, security hardening with no visible
   change), picks the version, writes 3 to 8 one-sentence items, the
   `CHANGELOG` entry and the note, opens `release/vX.Y.Z` into `develop`, then
   the release pull request `develop` → `main`. It never merges that promotion:
   `main` is production, and a person merges into it. Once its checks are
   green the skill stops, asks the person to merge it with the pull
   request's link, and after the person confirms the merge it tags `vX.Y.Z`
   on `main`'s merge commit. It never commits to `develop` or `main`
   directly.
6. **The runner keeps its own cycle.** `runner-v*` tags, the runner's
   `package.json` version and `apps/runner/CHANGELOG.md` are unchanged
   (ADR-0049). A product release names the runner release that shipped in its
   window; a product change that only works with an unreleased runner waits
   for that runner release before it is listed.

## Consequences

- Every promotion to `main` is a titled release pull request whose body is the
  user-facing entry and the list of pull requests it carries, merged by a
  person; a release is not finished, and not tagged, until they have.
- `vX.Y.Z` tags trigger nothing in CI: the release-runner pipeline matches
  `runner-v*` only, and a push to `main` runs the full suite as before.
  ADR-0088 changes this: a `vX.Y.Z` tag now publishes the API and web images.
- A new user sees the dot once, for the version current when they sign up.
- The changelog ships inside the web and API builds, so a release needs a
  merge into `develop` before its promotion; the skill orders the two pull
  requests that way.
- A late fix to a released entry's wording is not possible by design; the next
  release says it instead.
