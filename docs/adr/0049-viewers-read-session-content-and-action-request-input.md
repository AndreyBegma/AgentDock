# ADR-0049: Viewers read session content and action-request input

Status: accepted · Date: 2026-10-17 ·
Card: C-111 (security audit 2026-10-16, WI-09, decision D-03) ·
Spec: [`docs/specs/card-111-security-low-make-action-request-and-ses.md`](../specs/card-111-security-low-make-action-request-and-ses.md) ·
Amends: ADR-0021 §5

## Context

ADR-0021 §5 and `docs/architecture/security.md` said session content is readable by operators only, and the session-content read route enforced it. `GET /projects/:id/action-requests`, however, had no role guard and returned the redacted `tool_use` input to every member, so the code and the documents disagreed and each endpoint enforced a different policy. The same list, and the status reads, also ran the expiry sweep, so a viewer polling it wrote to the rows of every project.

## Decision

1. **A project member reads everything the project holds**, viewers included: session content and the input of an action request. Both stay redacted on the runner (ADR-0021 §4); nothing is stripped for a viewer.
2. **Writes keep their roles.** Approving and denying an action request needs `operator`; purging session content needs `admin`.
3. **Reads never write.** Listing and status reads show a pending request past `expiresAt` as `expired` without touching the row; only the every-minute sweep (`ActionRequestExpiryJob`) moves it.

## Consequences

- Viewers can read prompts and code excerpts that survived redaction; redaction is pattern-based, so the project setting's help text keeps its warning.
- Code, tests and documents now state one policy.
