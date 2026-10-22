# C-150: Security [Low]: Bound admin-supplied regexes

> Security audit 2026-10-16 · **WI-48** · severity **Low** · size **S** · findings: L-20 (Z2 INT-08, Z4 D-10, Z7 I5)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-20.** Trigger `valuePattern` is only checked to compile and to have a maximum length (`packages/shared/src/webhooks/actions.ts:137-146`) and then runs on webhook-supplied values. Price `matchPattern` runs on model names reported by runners (`apps/api/src/prices/pricing.ts:38-45`) and in the web (`apps/web/src/lib/usage/format.ts:265`, `apps/web/src/lib/prices/group.ts:35`).

**Attacker.** An admin who stores a pathological pattern by mistake, combined with an external sender choosing the input.

**Scenario.** A nested-quantifier pattern meets a crafted value from an inbound webhook.

**Impact.** Event-loop stall in the API (or the browser tab).

## Fix
Refuse patterns with nested quantifiers or over 200 characters (`safe-regex2`, or RE2 for evaluation) for trigger `valuePattern` and price `matchPattern`, in one shared helper used by the API DTOs and the web forms. Cap the input length before matching.

## Acceptance criteria
- A test refuses `^(a+)+$` in the trigger DTO and in the price DTO (regression test).
- Every stored default and seeded pattern still passes.
- A matching test with a 100 KB input and an accepted pattern finishes under 50 ms.

## Touches
- packages/shared/src/webhooks/actions.ts
- packages/shared/src/regex/safe-pattern.ts
- apps/api/src/prices/pricing.ts
- apps/api/src/prices/dto.ts
- apps/web/src/lib/usage/format.ts
- apps/web/src/lib/prices/group.ts

## Decision
none needed

## Must not run in parallel with
- WI-30


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
