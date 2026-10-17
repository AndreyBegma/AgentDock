# C-117: Security [Medium]: Isolate each Telegram update so one bad callback cannot stall the poller

> Security audit 2026-10-16 · **WI-15** · severity **Medium** · size **S** · findings: F-15 (Z2 INT-02), Z2 INT-10, Z2 INT-11
> Do not create a public GitHub issue before the fix is merged (the repository is public).

## Problem
F-15 (Z2 INT-02). `apps/api/src/telegram/telegram-poller.ts:216-217` awaits `this.handle(update)` and only then `storeOffset(update_id + 1)`. The callback regexes accept up to 19 digits (`approval-actions.ts:33`, `action-request-actions.ts:23`), which can exceed PostgreSQL `int8`; `authorize()` in `telegram-approval.service.ts` throws on such an id before the offset is stored, so the poller re-fetches the same update forever. Z2 INT-11: `markRead` (`notifications/notifications.service.ts:99`) turns an out-of-range id into a 500. Z2 INT-10: approval buttons are offered to viewers, and `press.pr` is not checked against the notification's PR.

**Attacker.** Anyone in a chat linked to AgentDock (a linked user, or whoever controls a linked chat).

**Scenario.** One crafted callback payload with an oversized id makes the poller throw on every poll.

**Impact.** All Telegram notifications and approvals stop for every user until the update is removed by hand.

## Fix
- Wrap `handle()` per update in try/catch; log the failure and always `storeOffset(update_id + 1)`.
- Bound ids to `\d{1,18}` (or check `<= 2^63-1`) in both callback regexes and in `markRead`; an out-of-range id is answered as unknown.
- Offer approve/deny buttons only to recipients with operator or higher on the project.
- Check that `press.pr` equals the notification's PR before deciding.

## Acceptance criteria
- Poller regression test: an update carrying an out-of-range callback id followed by a `/start <code>` update — the second is handled and the stored offset advances past both.
- `markRead` with a 19-digit id answers 404, not 500 (e2e).
- A viewer recipient gets the notification text without buttons; an operator gets buttons.
- A press whose PR differs from the notification's PR is refused.

## Touches
- apps/api/src/telegram/telegram-poller.ts
- apps/api/src/telegram/approval-actions.ts
- apps/api/src/telegram/action-request-actions.ts
- apps/api/src/telegram/telegram-approval.service.ts
- apps/api/src/telegram/telegram-delivery.service.ts
- apps/api/src/notifications/notifications.service.ts

## Decision
none needed

## Must not run in parallel with
- WI-45
- WI-47


Full audit material: orchestrator scratchpad `security/00-consolidated.md`, `security/00-decisions.md`.
