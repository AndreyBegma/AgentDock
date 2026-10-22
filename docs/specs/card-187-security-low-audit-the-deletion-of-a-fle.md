# C-187: Security [Low]: Audit the deletion of a fleet card when its issue leaves the queue

> Security audit 2026-10-16 · severity **Low** · findings: DA-14 (delta audit)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
A fleet card is deleted silently, with no audit record, when its issue loses the ready label.

## Fix
Write an audit row (and Activity entry) on that deletion.

## Acceptance criteria
- [ ] Removing the ready label leaves an audit row naming the card and issue.

## Decision
none needed

Full audit material: orchestrator scratchpad `security/10-delta-runner.md`, `11-delta-api-shared.md`, `12-delta-web.md`.
