# ADR-0051: A person queues what a session files for the fleet

Status: accepted · Date: 2026-10-17 ·
Card: C-112 (security audit 2026-10-16, WI-10, finding F-11, decision D-04) ·
Spec: [`docs/specs/card-112-security-medium-require-a-person-before.md`](../specs/card-112-security-medium-require-a-person-before.md) ·
Amends spec 201 D7, D18 and D19 · Builds on [ADR-0020](0020-claude-code-integration-through-the-runner.md)

The audit named this decision ADR-0046. That number (and 0047–0050) was taken
by the time it landed, so the decision is ADR-0051.

## Context

Spec 201 let a Claude Code session file an issue for the fleet on its own:
`issue.create {queue: true}` and `handoff.create` called
`QueueService.createIssue` with `queue: true`, the runner added the ready
label, and the orchestrator dispatched the issue to a worker that runs
autonomously and pushes.

A session reads untrusted text all the time — files, issues, web pages, tool
results. A prompt injection in any of them can make the agent call `handoff`
with a task of the attacker's choice. That was the shortest path from
untrusted text to autonomous code execution by the fleet, with no person in
between.

## Decision

1. **A session never adds the ready label.** `issue.create {queue: true}` and
   `handoff.create` from a local session file the issue checked as a queued
   one (acceptance criteria, parallel plan, allowed labels) but send
   `issue.create` with `queue: false`. The audit row records
   `queue: true, held: true`.
2. **An `issue_queue` action request carries it to a person.** It is created
   by the API alongside the issue, with `args {issue, title, url, session}`,
   and notified to operators and admins like every action request: the web
   Approvals panel and Telegram show the issue number, its title and link, with
   Approve and Deny. A session cannot ask for this kind with `action.request`.
3. **Approval queues through the existing path, as the approver.** The API
   sends the planner's `plan.queue_issues` for that one issue with the
   project's effective ready label (`QueueService.queueIssue`), audited as
   `issue.queue` with the approver as actor. A deny, or expiry after 7 days,
   leaves the issue open and unqueued and posts nothing on it.
4. **Its requester may approve it.** Unlike `orchestrator_*` and `pr_approve`,
   the point is a person, not a second person: an operator could queue the
   same issue from the web directly.
5. **Whom the runner acted for is on the create.** The `issue.create` audit
   row of a local request carries `meta.onBehalfOf {userId, runnerId,
   sessionId}`.
6. **The tools say so.** The `create_issue` and `handoff` results carry
   `queued: false`, `actionRequestId` and a `waiting` sentence telling the agent
   the issue waits for a person.

Web and API issue creation by a signed-in operator is unchanged: it still
queues directly.

## Consequences

- A handoff is no longer picked up until someone approves it; a solo developer
  approves their own handoff with one press in Telegram or the web.
- An injected `handoff` now produces at most an unqueued issue and a request a
  person sees with the issue's text one click away.
- `plan.queue_issues` gains a second caller; it needs the planner handlers on
  the runner, which every daemon registers.
