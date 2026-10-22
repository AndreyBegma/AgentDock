# C-141: Security [Low]: Stop registration revealing existing emails

> Security audit 2026-10-16 · **WI-39** · severity **Low** · size **S** · findings: L-12 (Z1 L4)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-12.** `POST /auth/register` answers 409 `email_taken` for an existing account (`apps/api/src/auth/auth.service.ts:69`; pinned by `auth.e2e.spec.ts:75-81`).

**Attacker.** Anyone who can reach the API.

**Scenario.** Registering candidate emails tells which ones have accounts.

**Impact.** Account discovery, which feeds targeted password guessing.

## Fix
- Always answer 201 `{status:'pending'}`; create no row for an existing email.
- Optionally notify the existing owner that someone tried to register their address.
- Update the e2e test that pins 409.

## Acceptance criteria
- An e2e test: registering an existing email gives 201 with the same body as a new registration, and no new user row is created
- The response time of both paths is of the same order (the password hash is computed in both)

## Touches
- apps/api/src/auth/auth.service.ts
- apps/api/src/auth/auth.e2e.spec.ts

## Decision
D-05 (same policy area) — exponential delay per (account, IP), no hard lock; registrations of existing emails answer `pending` (00-decisions.md)

## Must not run in parallel with
- WI-07


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
