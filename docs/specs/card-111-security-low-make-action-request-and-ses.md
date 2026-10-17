# C-111: Security [Low]: Make action-request and session-content reads match the viewer policy, and stop reads from expiring requests

> Security audit 2026-10-16 · **WI-09** · severity **Low** · size **S** · findings: F-10 (Z1 M3), Z1 I6
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
- **F-10.** `GET /projects/:id/action-requests` (`apps/api/src/local/action-requests.controller.ts:37`, no `@ProjectRole`) returns the redacted `tool_use` input to viewers (`action-request-mapper.ts`; local `requests.pending` at `local-handlers.ts:342`), while ADR-0021 §5 and `docs/architecture/security.md:32` say content is readable by operators only, and `apps/api/src/sessions/session-content.controller.ts:29` gates session content to `operator`. The code and the documents disagree. The person decided (D-03) that viewers may read everything; ADR-0043 records it. What remains is to make code, tests and docs consistent with it.
- **Z1 I6.** `ActionRequestsService.list` (`action-requests.service.ts:196`) and the status reads (:212, :264) call `expire()`, which updates due rows of **every** project, from a read by any viewer.

**Attacker.** Any project viewer (for I6).

**Scenario.** A viewer polling the list triggers writes across all projects on every request.

**Impact.** Writes and contention driven by read traffic, and a policy that is enforced differently on each endpoint.

## Fix
- Keep viewer access to action-request input (D-03). Open `session-content.controller.ts` reads to viewers (writes and purge stay admin/operator as today).
- Update `docs/architecture/security.md` (Session content row) and code comments that cite "operators only" to ADR-0043.
- Remove `expire()` from `list`, `status` and the other read paths; filter due rows out of reads (`expiresAt > now` treated as expired in the view) and leave the transition to `action-request-expiry.job.ts`.
- Decisions (approve, deny) stay `operator`.

## Acceptance criteria
- e2e: a viewer's `GET /projects/:id/action-requests` includes `args.input`; a viewer can read session content; a viewer's approve or deny gets 403
- Regression test: a viewer's list GET changes no rows (row count and `updatedAt` unchanged), and a due pending request is shown as expired
- The expiry job still moves due rows to `expired` (existing job test)
- `docs/architecture/security.md` cites ADR-0043 and no doc or comment says content is operator-only

## Touches
- apps/api/src/local/action-requests.controller.ts
- apps/api/src/local/action-requests.service.ts
- apps/api/src/local/action-request-mapper.ts
- apps/api/src/local/local-handlers.ts
- apps/api/src/sessions/session-content.controller.ts
- docs/architecture/security.md

## Decision
D-03 — viewers see everything; record the policy in an ADR (ADR-0043, amends ADR-0021 §5) and make code and docs consistent; do not strip content from viewers

## Must not run in parallel with
- WI-08
- WI-10
- WI-42
- WI-52


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
