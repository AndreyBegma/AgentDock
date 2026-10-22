# C-157: Security [Low]: Refuse commas and control characters in issue labels

> Security audit 2026-10-16 · **WI-55** · severity **Low** · size **S** · findings: L-27 (Z4 D-09, P2-09, Z9 P2-03)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-27.** Labels are any string of 1–100 characters (`packages/shared/src/protocol/commands/queue.ts:34`, `apps/api/src/queue/dto.ts:43-44`). The runner removes the ready label by exact comparison (`apps/runner/src/commands/queue/issue-create.ts:58-60`) and passes each label as `--label` to `gh` (`:83`), which splits on commas, so a label `x,<ready label>` slips past the filter. Control labels of the orchestrator are accepted from callers.

**Attacker.** A caller of `POST /projects/:id/issues` or a local session using `create_issue`.

**Scenario.** The caller passes a comma-joined label that contains the ready label.

**Impact.** The issue is queued for the fleet without passing `specGap` or any person (bypasses D-04 once WI-10 lands).

## Fix
Label schema `^[^,\x00-\x1f]{1,100}$` in the shared command and the API DTO. The runner splits on commas before comparing against the ready label (defence in depth). Refuse the orchestrator's control labels (`cs:*`) from callers.

## Acceptance criteria
- A schema test refuses `["x,cs:ready"]` and a label with a newline (regression test).
- A runner test: given `x,cs:ready` directly, the runner does not add the ready label.
- The DTO refuses `cs:in-flight` from a caller with 400.

## Touches
- packages/shared/src/protocol/commands/queue.ts
- apps/api/src/queue/dto.ts
- apps/api/src/queue/queue.service.ts
- apps/runner/src/commands/queue/issue-create.ts

## Decision
none needed

## Must not run in parallel with
- WI-01
- WI-10


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
