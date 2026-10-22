# C-181: Security [Medium]: Run auto-run and CI-fix rounds with the arming user's authority and budget

> Security audit 2026-10-16 · severity **Medium** · findings: DA-01, DA-02 (delta audit)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
Auto-run when ready runs as whoever accepts the dependency (`apps/api/src/board/board-auto-run.ts:36-89`, `board-rounds.service.ts:213-224`): an operator arms card X; when an admin accepts its dependency, X runs with the admin's role — with a bypass project default, in bypass mode on the operator's text, charged to the admin. CI-fix rounds (`board-rounds.service.ts:182-262`) skip the bypass role check and the per-user budget, so an operator escalates to bypass once CI goes red.

## Fix
Record the arming user (auto-run) / the round's original starter (CI fix) as the principal; apply their role to the permission mode (bypass needs admin) and their user budget; audit as them.

## Acceptance criteria
- [ ] An operator-armed auto-run never runs in bypass, whoever accepts the dependency (e2e).
- [ ] A CI-fix round of an operator's card never runs in bypass and is charged to the operator (e2e).
- [ ] Budget hard-stop of the principal blocks both.

## Decision
D-09/D-10 apply (authority of the last editor / budgets on every run kind).

Full audit material: orchestrator scratchpad `security/10-delta-runner.md`, `11-delta-api-shared.md`, `12-delta-web.md`.
