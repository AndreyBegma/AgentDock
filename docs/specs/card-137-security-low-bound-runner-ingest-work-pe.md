# C-137: Security [Low]: Bound runner ingest work per connection

> Security audit 2026-10-16 · **WI-35** · severity **Low** · size **M** · findings: L-05 (Z3 F4, Z3 P2-2), L-06 (Z3 F3)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-05.** A runner can make the API do unbounded work: the batch byte cap `MAX_EVENTS_BATCH_BYTES` (`packages/shared/src/protocol/messages.ts:23`) is not enforced on the raw frame (the gateway allows twice that, `apps/api/src/runners/runner.gateway.ts:264`); the `advanceAck` read in `runner-ingest.service.ts` is unbounded; concurrent `local.request`s per runner are unlimited; session trees are built recursively without a depth limit (`apps/api/src/sessions/session-tree.ts`, `sessions-query.service.ts:245-257`). **L-06.** Plugin-event dedupe is keyed by project root (`runner-ingest.service.ts:209`), not by runner, so two runners with the same root drop each other's events.

**Attacker.** A compromised runner (or a runner bug).

**Scenario.** The runner sends oversized batches, floods local requests, or reports a very deep session chain.

**Impact.** API memory and CPU exhaustion; lost events across runners.

## Fix
- Enforce `MAX_EVENTS_BATCH_BYTES` on the raw frame and refuse larger batches with a protocol error.
- Cap the `advanceAck` read (`take` plus a seq range).
- Limit concurrent `local.request`s per runner (32) and refuse the rest with `busy`.
- Cap session-tree depth at 64 in the CTE and in `build`, with a cut marker.
- Add `runnerId` to the plugin-event dedupe lookup.

## Acceptance criteria
- A gateway test: a 300 KiB batch is refused
- A gateway test: the 33rd concurrent `local.request` from one runner is refused
- A session-tree test: a 1000-deep chain returns 64 levels with a cut marker
- A dedupe test: two runners with the same project root both store their plugin events

## Touches
- apps/api/src/runners/runner.gateway.ts
- apps/api/src/runners/runner-ingest.service.ts
- apps/api/src/runners/runner-local-requests.ts
- apps/api/src/sessions/session-tree.ts
- apps/api/src/sessions/sessions-query.service.ts

## Decision
none needed

## Must not run in parallel with
- WI-16
- WI-34
- WI-36
- WI-06


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
