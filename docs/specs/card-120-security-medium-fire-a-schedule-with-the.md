# C-120: Security [Medium]: Fire a schedule with the authority of whoever last changed what it runs

> Security audit 2026-10-16 · **WI-18** · severity **Medium** · size **S** · findings: F-18 (Z4 D-01, Z6 P2-B4-1)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-18 (Z4 D-01, Z6 P2-B4-1). `apps/api/src/schedules/schedule-firer.ts:121` resolves the run's role from the **creator** (`creatorRole`, `:290-298`) and sends it as the system on the creator's behalf (`:304-325`). `schedules.service.ts` lets an operator PATCH an admin's schedule (target, cron, enabled) without changing `createdById` (set only at create, `:151`), and `runNow` (`:265`) also fires with the creator's role. With the creator's admin role the run can take the project's `bypassPermissions` default (`apps/api/src/skills/skill-run.service.ts:106`).

**Attacker.** An operator on a project where an admin created a schedule.

**Scenario.** The operator retargets the admin's schedule to a skill of their choosing, or calls run-now, and the run fires with admin authority.

**Impact.** Privilege escalation from operator to admin for runs, including permission bypass on the runner.

## Fix
- A PATCH that changes `target`, `cron` or `enabled` by someone other than the current owner re-owns the schedule (`createdById = caller`), audited as `schedule.update` with `meta.reowned: true` and the previous owner.
- `run-now` fires with the caller's own role and as the caller.
- Fix the dialog copy: editing says "the schedule will run with your authority".

## Acceptance criteria
- E2e regression test: an admin creates a schedule; an operator PATCHes the target and calls run-now; the run's trigger role is operator and the project's `bypassPermissions` default is refused.
- The audit row for the PATCH names the operator and the previous owner.
- A PATCH that changes only the name or description does not re-own.
- The schedule dialog shows the "your authority" notice when editing someone else's schedule.

## Touches
- apps/api/src/schedules/schedules.service.ts
- apps/api/src/schedules/schedule-firer.ts
- apps/web/src/app/(app)/projects/[projectId]/schedules/page.tsx
- apps/web/src/app/(app)/projects/[projectId]/schedules/schedule-dialog.tsx

## Decision
D-09 — the last editor of what it runs is the principal; run-now runs as the caller (00-decisions.md)

## Must not run in parallel with
- WI-19
- WI-64


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
