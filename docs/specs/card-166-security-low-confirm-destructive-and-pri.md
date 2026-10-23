# C-166: Security [Low]: Confirm destructive and privilege-granting one-click actions

> Security audit 2026-10-16 · **WI-64** · severity **Low** · size **M** · findings: L-44 (Z8 W8-05, Z6 P2-B2-2, P2-B1-3, P2-B2-3, P2-B4-7)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
These act on one click, with no confirmation:
- approving a pending user as admin — `apps/web/src/app/admin/users/page.tsx:171-177,280-300`;
- single-card Dismiss — `components/board/board-view.tsx`, `suggestion-sheet.tsx`;
- Remove attachment — `components/attachments/attachment-list.tsx:64`;
- Share plan and Make private — `components/planner/plan-header.tsx:166,179`;
- changing the runner's local user — `app/admin/runners/local-settings.tsx`;
- webhook Redeliver and schedule Run now.

**Attacker.** None directly; a misclick, or a UI-redress/clickjacking page if headers are missing (WI-27).
**Scenario.** One stray click grants admin, deletes an attachment or starts a run.
**Impact.** Privilege granted or data removed without intent.

## Fix
Route each listed action through glass-ui `ConfirmDialog`, naming what will happen (role granted, item removed, run started).

## Acceptance criteria
- A component test per action shows that the handler fires only after the dialog is confirmed, and not on cancel.
- Approving a pending user as admin shows the role in the dialog title.

## Touches
- apps/web/src/app/admin/users/**
- apps/web/src/app/admin/runners/**
- apps/web/src/app/admin/integrations/webhooks/**
- apps/web/src/components/board/board-view.tsx
- apps/web/src/components/board/suggestion-sheet.tsx
- apps/web/src/components/attachments/attachment-list.tsx
- apps/web/src/components/planner/plan-header.tsx
- apps/web/src/app/(app)/projects/[projectId]/schedules/**

## Decision
none needed

## Must not run in parallel with
- WI-18
- WI-62
- WI-75


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
