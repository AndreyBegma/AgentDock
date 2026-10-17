# C-105: Security [High]: Keep the Docker socket and shared caches out of pull-request pipelines

> Security audit 2026-10-16 · **WI-03** · severity **High** · size **M** · findings: F-03 (Z9 H1), F-04 (Z9 H3)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- **F-03.** In `.woodpecker/pipeline.yml` the `ci-image` step mounts `volumes: *socket` (anchor at :38, used at :79) and has no `when`, so it runs on `pull_request` from the PR's own pipeline file. Same-repo PRs, including card workers' auto-pushed branches, are not approval-gated (`deploy/README.md`).
- **F-04.** PR steps mount the host caches `/home/archi/ci-cache/agentdock/{bun,turbo}` (`pipeline.yml:47-51`), and the tag release mounts the same ones (`.woodpecker/release-runner.yml:35-39`). Base images float (`apps/{api,web}/Dockerfile`).

**Attacker.** Anyone who can open a same-repo pull request: a collaborator, or a prompt-injected fleet worker.

**Scenario.** The PR edits the pipeline or a build script; the step with the host socket runs it with root-equivalent access to the CI host, or writes a poisoned artefact into the shared cache that the next release build reuses.

**Impact.** Full control of the agent host (staging, runners, credentials on it) and a poisoned released runner binary.

## Fix
- Give `ci-image` and every socket step `when: event: [push, manual]` (or a cron); PR steps use `agentdock-ci` by digest.
- Give PRs a per-pipeline or read-only cache; the release workflow gets none: a fresh `BUN_INSTALL_CACHE_DIR`, `--frozen-lockfile`, no turbo cache for `build-release`.
- Use `docker build --pull` with digest-pinned bases.
- Update the comment block in `pipeline.yml` and `deploy/README.md` to state the PR trust level (ADR-0045): untrusted, no socket, no host volume, no secrets.

## Acceptance criteria
- A check (a `scripts/check-ci.ts` run by `bun run check`, or a test) renders the pull-request pipeline and asserts no step mounts `/var/run/docker.sock` or a host cache path; it fails on today's `pipeline.yml` (regression test)
- `release-runner.yml` mounts no shared cache and installs with `--frozen-lockfile`
- Push and tag pipelines still build the CI image and deploy staging
- `deploy/README.md` documents the PR trust level and the person-only settings (P-01)

## Touches
- .woodpecker/pipeline.yml
- .woodpecker/release-runner.yml
- deploy/README.md
- scripts/check-ci.ts

## Decision
D-11 — separate untrusted agent for PR pipelines without the Docker socket; until it exists, require approval for all PRs (person-only P-01); repo side moves socket-using steps out of PR pipelines (ADR-0045)

## Must not run in parallel with
- WI-04
- WI-31
- WI-78


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
