# C-106: Security [High]: Release the runner only from protected tags, and sign its artefacts

> Security audit 2026-10-16 · **WI-04** · severity **High** · size **M** · findings: F-05 (Z9 H2), the release-signing part of L-36 (Z5 L8)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`.woodpecker/release-runner.yml:25-28` starts on `refs/tags/runner-v*` and on `manual`; the comment at :21-22 says the secrets `github_release_token` and `npm_token` must be restricted to the tag **and manual** events. The gating lives in the file a pusher can edit, and nothing ties a tag to `main`. Releases are not signed (`apps/runner/scripts/build-release.sh`), and the Homebrew formula and npm wrapper only trust the download.

**Attacker.** Anyone who can push a `runner-v*` tag or start a manual run (a collaborator, or a fleet identity with tag rights).

**Scenario.** Tag any commit, including one with an edited workflow; the release steps run with the publish secrets.

**Impact.** A malicious runner binary published to Homebrew and npm and installed on every developer machine.

## Fix
- Sign `SHA256SUMS` (minisign or cosign) with a key held as a tag-only secret; publish `SHA256SUMS.sig`.
- The Homebrew formula and the npm wrapper verify the signature before installing.
- `build-release.sh` fails on a tag run when the key is missing.
- `deploy/README.md`: secrets are tag-only (not manual), `runner-v*` tags are ruleset-protected and cut from `main`; drop the wording that implies secrets on manual runs.

## Acceptance criteria
- A release dry run produces `SHA256SUMS.sig` that verifies against the public key in the repo
- `build-release.sh` exits non-zero on a tag run without the signing key (script test)
- The formula template and the npm wrapper refuse an artefact whose checksum is not in a correctly signed `SHA256SUMS` (unit test of the wrapper's verify step)
- The README matches the Woodpecker and GitHub settings of P-02 and P-03

## Touches
- .woodpecker/release-runner.yml
- apps/runner/scripts/build-release.sh
- apps/runner/homebrew/**
- apps/runner/npm/**
- deploy/README.md

## Decision
none needed (needs person-only P-02 secret scoping and P-03 tag rulesets)

## Must not run in parallel with
- WI-03


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
