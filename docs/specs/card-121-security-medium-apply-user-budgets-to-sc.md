# C-121: Security [Medium]: Apply user budgets to schedule firings and to every run kind

> Security audit 2026-10-16 · **WI-19** · severity **Medium** · size **M** · findings: F-19 (Z4 D-02, Z4b P2-05)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-19 (Z4 D-02, Z4b P2-05). `apps/api/src/schedules/before-fire.ts:16,30` asks the budget gate with `userId: null`, so per-user hard-stop budgets never apply to schedule firings. `apps/api/src/skills/skill-run.service.ts` (around `:143`) and `apps/api/src/budgets/budget-spend.ts:36-74` count user spend only for some run kinds: board rounds, plan and design turns and UI-profile builds are not counted against the user who started them.

**Attacker.** A user whose budget is exhausted (or a user who wants to avoid one).

**Scenario.** They keep spending through a schedule they own, a board round, or a plan turn, none of which check or count the user budget.

**Impact.** Per-user hard stops (spec 28) are decorative; spend continues past the limit an admin set.

## Fix
- Evaluate user budgets against the schedule's principal (the owner after WI-18) for cron firings, and against the caller for run-now.
- Count board rounds, plan and design turns and UI-profile builds into user spend in `budget-spend.ts`, and gate them on the user budget at start.
- Keep project budgets as they are.

## Acceptance criteria
- E2e regression test: an operator whose user budget is exhausted calls run-now on their schedule and gets `budget_exceeded`; a cron firing of a schedule they own is refused the same way.
- E2e: a board round started by that operator is refused with `budget_exceeded`.
- Unit test of `budget-spend.ts`: spend of each run kind (board round, plan turn, design turn, UI-profile build, skill run) counts toward the starting user.

## Touches
- apps/api/src/schedules/before-fire.ts
- apps/api/src/budgets/budget-gate.ts
- apps/api/src/budgets/budget-spend.ts
- apps/api/src/skills/skill-run.service.ts
- apps/api/src/board/**
- apps/api/src/planner/**
- apps/api/src/design/ui-profile.service.ts

## Decision
D-10 — user budgets apply to schedules and every run kind (00-decisions.md)

## Must not run in parallel with
- WI-18
- WI-30


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
