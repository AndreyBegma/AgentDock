# C-175: Security [Info]: Bound numeric route params and refuse leading dashes in branch DTOs

> Security audit 2026-10-16 · **WI-73** · severity **Info** · size **S** · findings: Z1 I4, Z3 F10, Z6 P2-B4-3
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- `apps/api/src/approvals/approvals.controller.ts:53,64` use plain `ParseIntPipe`; `apps/api/src/audit/audit.controller.ts:69` and `audit-query.service.ts:77` call `BigInt()` on unbounded input. Out-of-range values give 500.
- `PATCH /runners/:id` checks field permissions before existence (`runners/runner-settings.service.ts`), so 403/404 ordering reveals runner ids.
- `apps/api/src/projects/dto.ts:41` `BRANCH` allows a leading `-` (mitigated today by `gitRefSchema` on the protocol).

**Attacker.** Any signed-in user.
**Scenario.** Oversized ids produce 500s and noisy logs; response ordering confirms which runner ids exist.
**Impact.** Error noise and minor information disclosure; defence in depth for git argv.

## Fix
A shared pipe bounding ints to 1..2^31-1 and BigInt `seq` to 1..2^63-1; check existence before field permissions on `PATCH /runners/:id`; `BRANCH` refuses a leading `-`.

## Acceptance criteria
- E2e tests: `GET /approvals/99999999999` and `GET /audit/99999999999999999999` give 400, not 500.
- E2e test: `PATCH /runners/<unknown>` gives 404 for a non-admin as for an admin.
- DTO test: base branch `-x` is refused.

## Touches
- apps/api/src/approvals/approvals.controller.ts
- apps/api/src/audit/audit.controller.ts
- apps/api/src/audit/dto.ts
- apps/api/src/common/pipes/*
- apps/api/src/runners/runner-settings.service.ts
- apps/api/src/projects/dto.ts

## Decision
none needed

## Must not run in parallel with
- WI-37
- WI-41


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
