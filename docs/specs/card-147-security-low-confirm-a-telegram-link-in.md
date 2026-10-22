# C-147: Security [Low]: Confirm a Telegram link in the app before it becomes active

> Security audit 2026-10-16 · **WI-45** · severity **Low** · size **M** · findings: L-18 (Z2 INT-06)
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
**L-18.** `/start <code>` binds the chat that redeems the code first and activates it at once (`apps/api/src/telegram/telegram-linking.service.ts:134-195`, upsert at `:168`). The linked chat then receives notifications and can press approval buttons.

**Attacker.** Anyone who sees the link code or URL before its owner uses it (shoulder surfing, a shared screen, a forwarded link).

**Scenario.** The attacker redeems the code from their own chat first.

**Impact.** The attacker's chat receives the user's notifications and can approve PRs and action requests as that user.

## Fix
After `/start <code>`, create the link as **pending** with the chat id and `@username`. The web app shows "Link @username? Confirm" on the account notifications page; only the confirmation activates the link. A pending link receives no notifications and its button presses are refused (`not_linked`). Notify in-app when a pending link is created. A pending link expires with the code's lifetime.

## Acceptance criteria
- An e2e test: after `/start <code>` alone, no notification is delivered to the chat and an approve press is refused with `not_linked` (regression test).
- After the web confirmation, deliveries and presses work.
- An unconfirmed pending link expires and is removed.
- The confirmation and the link are audited.

## Touches
- apps/api/src/telegram/telegram-linking.service.ts
- apps/api/src/telegram/*.spec.ts
- apps/api/prisma/schema.prisma
- apps/api/prisma/migrations/20261209000000_telegram_link_confirmation/**
- packages/shared/src/telegram/**
- apps/web/src/app/(app)/account/notifications/telegram-card.tsx

## Decision
D-16 — a link becomes active only after confirmation in the web app (00-decisions.md)

## Must not run in parallel with
- WI-15


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
