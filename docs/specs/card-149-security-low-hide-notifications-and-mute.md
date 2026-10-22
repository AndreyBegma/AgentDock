# C-149: Security [Low]: Hide notifications and mutes of projects the user can no longer see

> Security audit 2026-10-16 · **WI-47** · severity **Low** · size **S** · findings: L-19 (Z2 INT-09, Z6 P2-B1-1)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-19.** `NotificationsService.list` filters by `userId` only (`apps/api/src/notifications/notifications.service.ts:59-80`), so a member removed from a project keeps reading its old notifications. `NotificationRulesService.mute`/`setMute` upsert a mute for any project id and join its `displayName` (`apps/api/src/notifications/notification-rules.service.ts:151-193`).

**Attacker.** A former project member, or any user probing project ids.

**Scenario.** After removal, the user keeps reading notification titles and links; a mute on a foreign id reveals the project's name.

**Impact.** Information disclosure after access is revoked.

## Fix
Filter `GET /notifications` (and the unread count) with `project: access.visibleWhere(user)` or `projectId: null`. Refuse `GET/PUT/DELETE /notifications/mutes/:projectId` for a project the user cannot see with 404, and never join `projectName` for one.

## Acceptance criteria
- An e2e test removes the user from a project; their list and unread count no longer include its notifications (regression test).
- `PUT /notifications/mutes/<foreign>` gives 404 and stores nothing.

## Touches
- apps/api/src/notifications/notifications.service.ts
- apps/api/src/notifications/notification-rules.service.ts
- apps/api/src/notifications/*.e2e.spec.ts

## Decision
none needed

## Must not run in parallel with
- WI-15


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
