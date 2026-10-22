# C-180: Security [Info]: Add secret scanning to check and CI

> Security audit 2026-10-16 · **WI-78** · severity **Info** · size **S** · findings: Z9 I2
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
No secret scanner runs in `bun run check` (`package.json:23` is `biome check .`) or in `.woodpecker/pipeline.yml`. The history is clean today (Z9 I2), but nothing stops a token from being committed by a person or an agent.

**Attacker.** None directly; an accidental commit by a person or a fleet worker.
**Scenario.** A worker commits a `.env` value or a token in a test fixture to the public repository.
**Impact.** A live credential is published.

## Fix
Add gitleaks (pinned version, `.gitleaks.toml` with an allowlist for spec fixtures) as a CI step on pull requests and pushes, and a `check:secrets` script that developers can run locally.

## Acceptance criteria
- CI fails on a scratch commit that plants a token-shaped string outside the allowlist.
- CI passes on the current tree with the allowlist.
- The gitleaks step mounts no Docker socket and no host cache (ADR-0045).

## Touches
- .woodpecker/pipeline.yml
- .gitleaks.toml
- package.json

## Decision
D-11/D-12 — PR pipelines get no Docker socket, and fleet changes to `.woodpecker/` need a human (00-decisions.md; ADR-0045)

## Must not run in parallel with
- WI-03
- WI-71


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
