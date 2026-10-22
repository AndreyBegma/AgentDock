# C-158: Security [Low]: Lock the plan row on send, create cards and archive, and lock UI-profile builds

> Security audit 2026-10-16 · **WI-56** · severity **Low** · size **M** · findings: L-28 (Z4b P2-02, P2-07)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-28.** `PlanSendService.send` checks `plan.status` from a row read before the transaction (`apps/api/src/planner/plan-send.service.ts:80-83`) and moves it to `sending`/`sent` later (`:157,256`) without a row lock; create-cards, archive and the turn projector are check-then-act the same way (`plan.service.ts`, `plan-cards.service.ts`, `plan-turn-projector.ts`). UI-profile builds check for a running build with `findFirst` and then create one (`apps/api/src/design/ui-profile.service.ts:103-112,203`).

**Attacker.** A plan participant double-submitting, or two people acting at once.

**Scenario.** Send and Create cards run in parallel, or a late decompose turn lands after archive.

**Impact.** Duplicate issues or cards, an archived plan coming back, or two concurrent UI-profile builds (double cost).

## Fix
Take `SELECT … FOR UPDATE` on the plan row and re-check the status inside the transaction in send, create cards, archive and the projector. Make UI-profile build start a conditional create (unique partial index or an advisory lock per project).

## Acceptance criteria
- A concurrency test runs Send and Create cards in parallel; one succeeds and the other gets 409 (regression test).
- A late decompose turn after archive does not un-archive the plan.
- Two parallel UI-profile build starts create one build.

## Touches
- apps/api/src/planner/plan-send.service.ts
- apps/api/src/planner/plan.service.ts
- apps/api/src/planner/plan-turn-projector.ts
- apps/api/src/planner/plan-cards.service.ts
- apps/api/src/design/ui-profile.service.ts

## Decision
none needed


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
