# ADR-0048: Failed passwords slow down the source; they never lock the account

Status: accepted · Date: 2026-10-17 ·
Card: C-109 (security audit 2026-10-16, WI-07, decision D-05) ·
Spec: [`docs/specs/card-109-security-medium-throttle-password-checks.md`](../specs/card-109-security-medium-throttle-password-checks.md) ·
Amends: spec 3 D8

## Context

Spec 3 D8 locked an account for 15 minutes after 10 failed logins, counted from any source, and refused even the correct password while it was locked. Anyone who knew an email address could therefore keep that account locked, the only admin's included, with a handful of wrong passwords every 15 minutes. Every refused login also wrote its own audit record behind the global audit lock, so a login flood grew the log and slowed every other audited action. `PATCH /auth/me/password` had neither a rate limit nor a failure counter, so a stolen session could guess the current password freely.

## Decision

1. **No account lock.** `users.failedLoginCount` and `users.lockedUntil` are dropped.
2. **Failures are counted per (email, IP)** in `login_throttles`, keyed by the email as typed, so an unknown address behaves exactly like a real one and the response tells a caller nothing new. After `THROTTLE_AFTER` (5) failures in a row, that source must wait 1 s, and the wait doubles with every further failure up to 60 s. While it waits, it gets 429 `throttled` with `Retry-After`, and its password is not checked. A source whose last failure is more than 15 minutes old starts again from zero. A correct password from a source clears its count.
3. **Other sources are never delayed.** The owner signing in from another address gets through at once, whatever a stranger did.
4. **The password change shares the counter.** A wrong current password counts against (the caller's email, IP), and the route has the same per-IP request limit as login (10 a minute).
5. **Admins are told.** When an existing account first crosses the threshold from any source within the 15-minute window, every active admin gets an `account.throttled` notification (in-app and Telegram by default).
6. **Refused logins are folded in the audit log.** The first refusal of a minute for one (email, IP) is written at once with `meta.count: 1`. Repeats in that minute are counted in `audit_folds`, and when the minute is over they are written as one record with `meta.folded`, `meta.count` and a tally per `meta.reason`. A burst therefore writes at most two records per (email, IP, minute).

## Consequences

- An attacker can no longer deny a chosen user access; the most they can do is slow down their own address.
- Guessing from many addresses still gets 5 free tries per address before the waits, plus the per-IP request limit. Second-factor sign-in is a separate, later card.
- The audit log keeps the first refusal of each minute in full; later refusals keep only their count and reasons, not each user agent.
- Folded repeats are written about a minute late, by a job that runs every minute in each API process. Claiming them with `DELETE … RETURNING` keeps two processes from writing the same repeats twice.
