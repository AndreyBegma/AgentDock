# C-183: Security [Medium]: Stop agents forging runner-only events through the code-sentinel event log

> Security audit 2026-10-16 · severity **Medium** · findings: DA-04, DA-10, L-32 (delta audit)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
Any agent can append runner-owned event types (filter stats, `steward.observed/acted`, `handoff.updated`, `round.restart/warmup`, card events) to `events.jsonl`, which the runner forwards as `code-sentinel` (`apps/runner/src/fleet/code-sentinel.ts:100-215`). Steward and handoff schemas are not strict and carry their own `projectId`; sinks dispatch on type alone (`packages/shared/src/steward/events.ts`, `handoff/events.ts`). The token-saver stats file is agent-writable and its global id allows collisions.

## Fix
Allowlist the event types the code-sentinel source may carry (only the orchestrator contract in EVENTS.md); make steward/handoff/filter.stats schemas strict and take project/run from the runner's own context, never from data; the API sink checks source per type; stats ids are scoped (run, seq).

## Acceptance criteria
- [ ] A `steward.acted` line in `events.jsonl` is dropped and never reaches the API (runner test).
- [ ] The API rejects a runner-owned type with `source: code-sentinel` (e2e).
- [ ] Stats rows cannot target another project/run.

## Decision
none needed

Full audit material: orchestrator scratchpad `security/10-delta-runner.md`, `11-delta-api-shared.md`, `12-delta-web.md`.
