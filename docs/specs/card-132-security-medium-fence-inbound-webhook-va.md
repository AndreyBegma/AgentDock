# C-132: Security [Medium]: Fence inbound webhook values and never inherit bypassPermissions in trigger runs

> Security audit 2026-10-16 · **WI-30** · severity **Medium** · size **M** · findings: F-30 (Z9 P2-02, Z2 INT-07)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**F-30.** Inbound webhook values are substituted unfenced into a skill prompt by `renderArgsTemplate` (`packages/shared/src/webhooks/actions.ts:191`). The default value pattern `DEFAULT_INBOUND_VALUE_PATTERN = '^[\w .,:/#@+-]*$'` (:45) allows spaces and so any natural-language sentence. A trigger has no permission mode of its own: the run takes `spec.permissionMode ?? defaultPermissionMode(projectId)` (`apps/api/src/skills/skill-run.service.ts:104-106`), so an admin-created trigger inherits the project's `bypassPermissions` default.

**Attacker.** Whoever can send a correctly signed payload to the trigger's sender: for example a GitHub issue or comment author whose text the sender forwards.

**Scenario.** A forwarded value carries instructions that the skill run treats as part of its prompt, and the run executes with `bypassPermissions` because the project default is bypass.

**Impact.** Prompt injection from outside the organisation into an agent with no permission prompts on a developer machine.

## Fix
- Render the substituted values inside a `<payload>…</payload>` fence with a data-not-instructions line; neutralise the tag inside values.
- Make the default value pattern identifier-only: `^[\w.:/#@+-]{1,100}$` (no spaces); typed placeholders or an explicit admin pattern allow more.
- Give each trigger action an explicit `permissionMode` (in the `action` JSON). It is never taken from the project default. `bypassPermissions` needs an admin and the trigger dialog shows a warning.
- Migration `20261208000000_trigger_permission_mode` backfills existing triggers with the non-bypass default (`default`).

## Acceptance criteria
- A `renderArgsTemplate` test: a value with spaces is refused under the default pattern and accepted under an explicit admin pattern
- A rendering test: substituted values appear inside the `<payload>` fence and a value containing `</payload>` is neutralised
- An e2e test: a trigger fired on a project whose default mode is `bypassPermissions` starts the run in the trigger's own mode, not bypass
- An e2e test: an operator cannot save a trigger with `permissionMode: bypassPermissions`; an admin can, and the change is audited
- The migration test: existing trigger rows get `permissionMode: default` in `action`

## Touches
- packages/shared/src/webhooks/actions.ts
- packages/shared/src/skills/contracts.ts
- apps/api/src/webhooks/inbound/trigger-firer.ts
- apps/api/src/webhooks/inbound/triggers.service.ts
- apps/api/src/webhooks/inbound/dto.ts
- apps/api/src/skills/skill-run.service.ts
- apps/api/prisma/migrations/20261208000000_trigger_permission_mode/**
- apps/web/src/app/(app)/projects/[projectId]/**/trigger*

## Decision
D-13 — explicit permission mode per trigger, never bypass by inheritance; webhook values fenced as data (00-decisions.md)

## Must not run in parallel with
- WI-48
- WI-18
- WI-19


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
