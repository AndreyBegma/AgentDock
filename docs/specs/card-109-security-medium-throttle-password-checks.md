# C-109: Security [Medium]: Throttle password checks without letting strangers lock accounts

> Security audit 2026-10-16 · **WI-07** · severity **Medium** · size **M** · findings: F-08 (Z1 M1), L-10 (Z1 L2), L-13 (Z1 L5)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- **F-08.** `apps/api/src/auth/auth.service.ts:144-155` sets `lockedUntil = now + LOCKOUT_MS` (15 minutes, :24) after `MAX_FAILED_LOGINS` bad passwords, counted per account from any source, and `:103` refuses even the right password while locked. The only rate limit is 10/min per IP (`auth.module.ts:16`).
- **L-10.** `PATCH /auth/me/password` (`auth.controller.ts:98`) has no throttler and no failure counter.
- **L-13.** Every refused login writes its own audit row behind the global audit lock.

**Attacker.** Any internet client that knows or guesses an email address (staging is public).

**Scenario.** A handful of wrong passwords every 15 minutes keeps an account, the only admin included, locked indefinitely; a login flood fills the audit log and contends on its lock.

**Impact.** Denial of access for chosen users (including every admin), audit-log growth, API slowdown; unthrottled password guessing on a stolen session.

## Fix
- Replace the hard per-account lock with failure counting per (account, IP) plus an exponential per-account delay (e.g. 1 s doubling to a 60 s ceiling) applied only to sources with failures; a source with no recent failures is not delayed.
- Apply `ThrottlerGuard` and the same counter to `PATCH /auth/me/password`.
- Fold refused logins into one audit row per (email, IP, minute) with a count.
- Notify admins when an account crosses the throttle threshold.
- Remove `lockedUntil` use (column dropped in the migration).

## Acceptance criteria
- Regression e2e: 20 bad logins from IP A, then a correct login from IP B succeeds immediately
- The same 20 from A make A wait (429 or delayed response with `Retry-After`), and the delay grows exponentially to the ceiling
- 11 bad `changePassword` calls in a minute give 429
- A burst of 100 refused logins from one (email, IP) writes at most 2 audit rows
- An admin notification is created when an account is throttled

## Touches
- apps/api/src/auth/auth.service.ts
- apps/api/src/auth/auth.controller.ts
- apps/api/src/auth/auth.module.ts
- apps/api/src/auth/login-throttle*.ts
- apps/api/src/audit/**
- apps/api/prisma/schema.prisma
- apps/api/prisma/migrations/20261205000000_login_throttle/**

## Decision
D-05 — exponential delay per (account, IP), no hard lock; 2FA is a separate later card

## Must not run in parallel with
- WI-39


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
