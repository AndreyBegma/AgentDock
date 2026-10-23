# C-153: Security [Low]: Hide runs of private plans from run history and usage

> Security audit 2026-10-16 · **WI-51** · severity **Low** · size **S** · findings: L-24 (Z4 D-05)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-24.** Private plans are filtered with `readablePlanWhere(userId)` (`apps/api/src/planner/plan-access.ts:11`) in the planner, but the runs list and run detail (`apps/api/src/history/runs-query.service.ts:69,124`) and `usage dimension=run` (`apps/api/src/usage/usage-query.service.ts:228`) do not apply it to `kind: 'plan'` runs.

**Attacker.** Another member of the project.

**Scenario.** The member lists runs filtered to plans and reads titles, timing and cost of someone's private plan turns.

**Impact.** Metadata of private plans leaks.

## Fix
Add the `readablePlanWhere(userId)` filter for `kind: 'plan'` runs to the runs list, the run detail (404) and `usage dimension=run`.

## Acceptance criteria
- An e2e test: another member does not see private plan turns in `GET /runs?kind=plan`, and the detail gives 404 (regression test).
- The owner and the plan's sharees still see them; project totals are unchanged.

## Touches
- apps/api/src/history/runs-query.service.ts
- apps/api/src/usage/usage-query.service.ts
- apps/api/src/history/*.e2e.spec.ts

## Decision
none needed


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
