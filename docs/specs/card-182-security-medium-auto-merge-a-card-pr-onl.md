# C-182: Security [Medium]: Auto-merge a card PR only on real green CI, and never one that touches CI, deploy or plugin files

> Security audit 2026-10-16 · severity **Medium** · findings: DA-03 (delta audit), D-12, L-31
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`apps/api/src/board/board-shipping.ts:240-273,410-433`: "no checks" read twice counts as green, cancelled/skipped checks are ignored, and nothing stops a PR touching `.woodpecker/`, `deploy/` or `plugins/` from auto-merging. Auto-merge now runs from the poller with no person.

## Fix
Require at least one completed required check and all checks success; treat cancelled/skipped/none as not green; refuse auto-merge (needs a person) when the PR changes `.woodpecker/**`, `deploy/**`, `plugins/**`, `.claude-plugin/**`, `docker/**`.

## Acceptance criteria
- [ ] A PR with no checks never auto-merges.
- [ ] A PR with a cancelled check never auto-merges.
- [ ] A PR touching `.woodpecker/pipeline.yml` waits for a person even when green.

## Decision
D-12.

Full audit material: orchestrator scratchpad `security/10-delta-runner.md`, `11-delta-api-shared.md`, `12-delta-web.md`.
