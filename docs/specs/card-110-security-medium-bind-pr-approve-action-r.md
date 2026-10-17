# C-110: Security [Medium]: Bind `pr_approve` action requests to the head shown when they were created

> Security audit 2026-10-16 · **WI-08** · severity **Medium** · size **S** · findings: F-09 (Z1 M2)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
`apps/api/src/local/action-requests.service.ts:398-418`: on approval of a `pr_approve` request the API inspects the PR **at decision time** and approves `inspection.headSha`. Nothing ties the approval to the head that existed when the request was created and shown to the person.

**Attacker.** An agent session (or anyone who can push to the PR branch) that requested the approval.

**Scenario.** The session requests approval for a harmless head, then pushes new commits before the person clicks Approve; the new head is what gets approved.

**Impact.** A person approves code they never saw; with auto-merge it lands.

## Fix
- On `action.request` of kind `pr_approve`, run `pr.inspect` and store `headSha` and the PR title in `args`.
- On approve, call `approvals.approve(pr, storedHeadSha)`; a moved head fails the request with `head_moved` and creates no approval row.
- Show head (short SHA), title and a diff link in the web row and the Telegram text.

## Acceptance criteria
- Regression e2e: create the request, move the fake PR head, approve; the request ends `failed` with `head_moved` and no approval row exists
- Mapper test: the view carries `headSha` and `title`
- The Telegram message and the web row show the short head SHA

## Touches
- apps/api/src/local/action-requests.service.ts
- apps/api/src/local/local-handlers.ts
- apps/api/src/local/action-request-mapper.ts
- packages/shared/src/action-requests/contracts.ts
- apps/api/src/telegram/telegram-action-request.service.ts
- apps/web/src/components/approvals/action-requests-panel.tsx

## Decision
none needed

## Must not run in parallel with
- WI-09
- WI-10
- WI-12
- WI-13
- WI-42


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
