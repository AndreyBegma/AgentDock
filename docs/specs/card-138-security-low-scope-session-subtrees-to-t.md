# C-138: Security [Low]: Scope session subtrees to the root's project

> Security audit 2026-10-16 · **WI-36** · severity **Low** · size **S** · findings: L-07 (Z3 F5)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-07.** Session detail and totals include descendants from other projects: `subtreeIds` and `subtreeTotals` (`apps/api/src/sessions/sessions-query.service.ts:151,179,245-257`) follow `parentSessionId` without filtering by project, and `parentSessionId` is kept when a child is re-observed in another project (`sessions-ingest.service.ts:308-341`).

**Attacker.** A member of project A who is not a member of project B.

**Scenario.** A subagent or child session that moved to project B still shows under its parent in project A.

**Impact.** Metadata and cost of another project leak to non-members.

## Fix
- Filter `subtreeIds` and `subtreeTotals` to `projectId = root.projectId` for non-admins.
- Clear `parentSessionId` when a child's project changes on ingest.

## Acceptance criteria
- An e2e test: a child re-observed in project B is excluded from the parent's detail and totals for a member of A
- An ingest test: re-observing a child in another project clears its `parentSessionId`

## Touches
- apps/api/src/sessions/sessions-query.service.ts
- apps/api/src/sessions/sessions-ingest.service.ts

## Decision
none needed

## Must not run in parallel with
- WI-35


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
