# C-143: Security [Low]: Re-check the approval row's status inside the decision lock

> Security audit 2026-10-16 · **WI-41** · severity **Low** · size **S** · findings: L-11 (Z1 L3)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-11.** `ApprovalsService.decide` reads the current row before it calls the runner, then, inside `lockApprovals`, re-reads it with `currentRow(tx, project.id, pr) ?? before` and updates it with `status: decision.decision` without checking the row's status (`apps/api/src/approvals/approvals.service.ts:346-358`). A row that was closed (merged, stale, voided) between the inspect and the decision is written back as `approved` or `changes_requested`.

**Attacker.** None needed; an operator racing a close, or two operators deciding at once.

**Scenario.** The PR is merged or its approval voided while an approval is in flight; the late decision overwrites the closed row.

**Impact.** A closed approval reappears as approved, which can mislead the merge queue and the audit trail.

## Fix
Inside the locked transaction, re-read the row by id and update it only when its status is `waiting` or `approved` (the states a decision may move). Otherwise answer 409 `approval_closed` and record the audit attempt as refused.

## Acceptance criteria
- A service test closes the row between the inspect and the decide; the decide answers 409 and the row stays closed (regression test).
- The existing approve and request-changes tests pass unchanged.

## Touches
- apps/api/src/approvals/approvals.service.ts
- apps/api/src/approvals/approvals.service.spec.ts

## Decision
none needed


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
