# C-119: Security [Medium]: Rate-limit /live frames and the reads that reach runners

> Security audit 2026-10-16 · **WI-17** · severity **Medium** · size **M** · findings: F-17 (Z3 F2)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-17 (Z3 F2). `apps/api/src/live/live.gateway.ts` has no per-socket message rate. Each pane watch and leave in `apps/api/src/pane/pane-relay.ts` (subscribe at `:158`, `void this.audit.record(...)` at `:268`) sends a runner command and appends an audit row, and every audit append takes one global advisory lock (`apps/api/src/audit/audit.service.ts:18`, `pg_advisory_xact_lock(hashtext('agentdock:audit'))`). Read routes that call the runner (`orchestrator.status` in `control/control.controller.ts`, `fleet/fleet.controller.ts`) have no throttle or cache.

**Attacker.** Any project member, a viewer included (viewers may watch panes, ADR-0043).

**Scenario.** A client loops subscribe/unsubscribe frames on `/live`, or polls a runner-backed read route.

**Impact.** Audit writes for the whole instance serialise behind the lock, runners are flooded with commands, and every user sees a slow or stalled API.

## Fix
- A per-socket token bucket on `/live` (default 20 frames/s, burst 50); over it the socket closes with 4429.
- Debounce pane watch/leave audits per (user, slot) to one row per minute.
- Cache `orchestrator.status` for a few seconds per project, as `worktree` already is; coalesce concurrent identical runner reads.
- `ThrottlerGuard` on the read routes that call runners.

## Acceptance criteria
- Gateway regression test: 500 subscribe/unsubscribe frames in one second close the socket with 4429, and at most N (default 50) runner subscribes are sent.
- 100 `GET …/orchestrator/status` calls within 2 s cause one runner command.
- Repeated watch/leave of one slot by one user within a minute writes one audit row.
- Normal pane watching still streams frames.

## Touches
- apps/api/src/live/live.gateway.ts
- apps/api/src/pane/pane-relay.ts
- apps/api/src/control/control.service.ts
- apps/api/src/control/control.controller.ts
- apps/api/src/fleet/fleet.controller.ts

## Decision
none needed (viewer read access stays, ADR-0043 / D-03)

## Must not run in parallel with
- WI-52


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
