# C-112: Security [Medium]: Require a person before an issue from a local session is queued

> Security audit 2026-10-16 · **WI-10** · severity **Medium** · size **M** · findings: F-11 (Z1 M4), Z1 hardening (`onBehalfOf` on the `issue.create` audit row)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`apps/api/src/local/local-handlers.ts:392-431`: `issue.create` passes `queue: args.queue` (:401) and `handoff.create` always passes `queue: true` (:431) to `QueueService.createIssue`, which adds the ready label. The fleet then picks the issue up and runs it autonomously. This was by design (spec 201 D7).

**Attacker.** A prompt-injected manual or card session (text in a file, issue, web page or tool result the agent reads).

**Scenario.** The injected instructions make the agent call `handoff` with a task of the attacker's choice; the issue is queued and a fleet worker executes it with no human in between.

**Impact.** The shortest path from untrusted text to autonomous code execution and pushes by the fleet.

## Fix
- `issue.create {queue:true}` and `handoff.create` from a local session create the issue **without** the ready label and a new action request of kind `issue_queue` (`args: { issue, title, requestedBy session }`).
- An operator approves it in the web Approvals panel or in Telegram; approval adds the ready label through the existing queue path; deny leaves the issue unqueued and comments nothing.
- The `issue.create` audit row carries `meta.onBehalfOf` (session id, runner, local user).
- The MCP tool results say the issue is waiting for a person.

## Acceptance criteria
- Regression e2e: a local `handoff.create` creates an issue without the ready label and a pending `issue_queue` request
- Approving the request adds the ready label; denying it does not
- A local `issue.create {queue:false}` behaves as today (no request)
- The audit row of the create carries `onBehalfOf`
- The Telegram message for an `issue_queue` request offers Approve/Deny to operators and shows the issue title and number
- Web and API issue creation by a signed-in operator still queue directly (unchanged)

## Touches
- apps/api/src/local/local-handlers.ts
- apps/api/src/local/action-requests.service.ts
- apps/api/src/local/action-request-mapper.ts
- apps/api/src/queue/queue.service.ts
- packages/shared/src/action-requests/contracts.ts
- apps/api/src/telegram/telegram-action-request.service.ts
- apps/api/prisma/schema.prisma
- apps/api/prisma/migrations/20261206000000_issue_queue_action_request/**
- apps/web/src/components/approvals/action-requests-panel.tsx
- apps/runner/src/mcp/tools.ts

## Decision
D-04 — yes, a new action-request kind: `issue.create queue:true` / `handoff.create` from a session create the issue without the ready label plus an action request a person approves (ADR-0046)

## Must not run in parallel with
- WI-08
- WI-09
- WI-12
- WI-13
- WI-42


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
