# C-116: Security [Medium]: Rate-limit public webhook endpoints and stop unsigned deliveries from changing GitHub health

> Security audit 2026-10-16 · **WI-14** · severity **Medium** · size **S** · findings: F-14 (Z2 INT-01), L-17 (Z2 INT-05)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-14 (Z2 INT-01). `apps/api/src/github-app/github-hook.service.ts:102-108`: a `POST /hooks/github` whose signature fails writes `lastSignatureFailureAt: new Date()` to the App row on every request. `apps/api/src/github-app/github-health.ts:58-62` then reports `signature_failure` for every project while that timestamp is newer than the last valid delivery. Neither `GitHubHookController` (`github-app.controller.ts:46`) nor `HooksController` (`apps/api/src/webhooks/inbound/hooks.controller.ts:13`) has a throttler, so L-17 (Z2 INT-05) applies too: there is no pre-signature rate limit on `POST /hooks/:publicId`.

**Attacker.** Anyone on the internet who can reach `/hooks/*` (it stays open by design, D-07).

**Scenario.** A stream of unsigned requests keeps the failure timestamp ahead of real deliveries and floods the DB and the warn log.

**Impact.** Every project shows GitHub as unhealthy, real alerts are drowned, and the API spends a DB write per junk request.

## Fix
- Put `ThrottlerGuard` (per client IP, through the configured `TRUST_PROXY`) on `GitHubHookController` and `HooksController`; 10 requests a minute per IP by default for unsigned failures, valid deliveries unaffected.
- Keep the signature-failure count in memory; write `lastSignatureFailureAt` at most once a minute.
- Health turns `signature_failure` only when more than N failures (default 20) fall in a window (default 10 minutes) with no valid delivery.
- Sample the warn log (one line per minute with a count).

## Acceptance criteria
- E2e regression test: 100 unsigned `POST /hooks/github` cause at most 1 DB update of `lastSignatureFailureAt`, and GitHub health stays healthy while valid deliveries keep arriving.
- E2e: the 11th request in a minute from one IP to `/hooks/github` and to `/hooks/:publicId` gets 429.
- Unit test of `github-health.ts`: failures below the threshold, or followed by a valid delivery, do not give `signature_failure`.
- Valid signed deliveries are still processed.

## Touches
- apps/api/src/github-app/github-hook.service.ts
- apps/api/src/github-app/github-health.ts
- apps/api/src/github-app/github-health.service.ts
- apps/api/src/github-app/github-app.controller.ts
- apps/api/src/webhooks/inbound/hooks.controller.ts
- apps/api/test/**

## Decision
none needed

## Must not run in parallel with
- WI-43


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
