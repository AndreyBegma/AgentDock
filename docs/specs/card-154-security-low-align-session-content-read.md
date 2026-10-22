# C-154: Security [Low]: Align session-content read access and docs with the viewer policy (ADR-0043)

> Security audit 2026-10-16 · **WI-52** · severity **Low** · size **M** · findings: L-22 (Z3 F6, Z4 D-06, Z4b P2-08, P2-04)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-22.** ADR-0021 §5 and `docs/architecture/security.md:32` say session content is readable by operators only, and `GET /projects/:id/sessions/:id/content` is `@ProjectRole('operator')` (`apps/api/src/sessions/session-content.controller.ts:28-29`). At the same time viewers read live panes (`apps/api/src/pane/pane-authorizer.ts:9`), command-run message `args`, conversation bodies, skill-run patches and reports (`apps/api/src/skills/skills.controller.ts:190`), schedule target args, plan-turn input/result and `captureWhy` (`apps/api/src/board/board-mapper.ts:277`).

The person decided (D-03) that **viewers see everything**; ADR-0043 records it and amends ADR-0021. What is left is an inconsistency between code, docs and tests, not an access defect.

**Attacker.** None; the risk is drift: a later change "fixes" one path to operator-only, or documents the opposite of what the code does.

**Impact.** Readers of the docs and reviewers get the wrong model of who sees what.

## Fix
- Allow viewers on the session-content read path (`GET …/sessions/:id/content`); writes and purge keep their roles.
- Pin today's viewer read access with e2e tests per endpoint: pane subscribe, command-run args, conversations, skill-run patch/report/args, schedule target args, plan-turn input/result, `captureWhy`, session content.
- Update `docs/architecture/security.md` (Session content row), the controller comments and any spec text that says operator-only, linking ADR-0043.
- Do **not** strip or gate content from viewers.

## Acceptance criteria
- An e2e test per listed endpoint shows a viewer reads the content and a non-member gets 404 (regression tests pinning the policy).
- A viewer's `GET …/sessions/:id/content` returns 200; purge stays admin-only.
- Write actions on the same resources still require operator (existing tests pass).
- `docs/architecture/security.md` and the session-content controller comment match ADR-0043.

## Touches
- apps/api/src/sessions/session-content.controller.ts
- apps/api/src/sessions/*.e2e.spec.ts
- apps/api/src/pane/*.spec.ts
- apps/api/src/control/*.e2e.spec.ts
- apps/api/src/fleet/*.e2e.spec.ts
- apps/api/src/skills/*.e2e.spec.ts
- apps/api/src/schedules/*.e2e.spec.ts
- apps/api/src/planner/*.e2e.spec.ts
- apps/api/src/board/*.e2e.spec.ts
- docs/architecture/security.md

## Decision
D-03 — viewers see everything; amend ADR-0021 with ADR-0043 and align code and docs, do not strip content (00-decisions.md)

## Must not run in parallel with
- WI-09
- WI-17


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
