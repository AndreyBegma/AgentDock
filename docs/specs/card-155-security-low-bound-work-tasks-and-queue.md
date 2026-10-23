# C-155: Security [Low]: Bound `/work`, `/tasks` and queue recompute reads

> Security audit 2026-10-16 · **WI-53** · severity **Low** · size **M** · findings: L-25 (Z4 D-07, Z4b P2-06)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-25.** `/work` reads every board card of the project before paging (`apps/api/src/work/work-query.service.ts:166`), `/tasks` reads all plans and tasks (`apps/api/src/planner/tasks-query.service.ts:38,67`), and the queue recompute reads every cached issue with its body (`apps/api/src/queue/queue-inputs.ts:83`).

**Attacker.** Any member of a large project, or an issue author filling the repository.

**Scenario.** Repeated page loads on a project with thousands of cards or issues.

**Impact.** API memory and database load grow with project size on every request (DoS by volume).

## Fix
Push keyset order and `take: PAGE + 1` into each source query of `/work` and `/tasks`, merge the sources by cursor, and load issue bodies lazily in recompute (only for issues whose state needs the body).

## Acceptance criteria
- A query-count or row-count test with 5000 cards reads at most a page plus one per source (regression test).
- Paging results are unchanged against the existing e2e fixtures.
- Recompute on 5000 cached issues does not select `body` for issues that do not need it.

## Touches
- apps/api/src/work/**
- apps/api/src/planner/tasks-query.service.ts
- apps/api/src/planner/task-live.ts
- apps/api/src/queue/queue-inputs.ts

## Decision
none needed


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
