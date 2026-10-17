# C-209: Add a Telegram command router and per-chat project selection

Issue: #500

## What to do
Give the Telegram bot a real command layer that the Board features can plug into. Today `apps/api/src/telegram/telegram-poller.ts` (around lines 248-283) routes updates by hand to linking (`telegram-linking.service.ts`), approval callbacks (`approval-actions.ts`), action-request callbacks (`action-request-actions.ts`) and session-message callbacks and replies (`session-message-actions.ts`). Every other text is ignored.

- Add a router module in `apps/api/src/telegram/`:
  - commands (`/cmd args`, `/cmd@Bot args`);
  - callback-data prefixes;
  - reply-to-bot-message handlers.
  Move the existing handlers onto it without changing their behaviour.
- Add a typed callback-data codec that keeps every payload within Telegram's 64-byte cap. Use short ids for cards and projects.
- Add a per-chat "current project" (Prisma model or column on the Telegram link, via `prisma migrate dev`).
  - `/project` lists the projects where the linked user is an active member as buttons, and the choice is remembered.
  - `/project <slug>` switches directly.
  - With exactly one project, it is selected automatically.
- Every Board reply names its project.
- Buttons inside notifications carry their own project, so acting on them never depends on the current project.
- Add a shared guard helper that resolves the linked user and checks project membership and role (reuse the check in `telegram-approval.service.ts` around lines 286-307):
  - read actions need any active member;
  - write actions need operator or higher.
- `/help` lists the available commands.
- Register the command menu with `setMyCommands` when the bot is configured (`telegram-integration.service.ts`). Add the needed methods to `telegram-client.ts`.
- Add a new ADR in `docs/adr/` (next number after 0045). It records that the bot now acts on the Board beyond notifications, which widens `docs/specs/22-notifications-and-telegram.md` scope. It keeps D10 (no pane text or code in messages) and D12 (typed actions only). Update spec 22 to point to it.

## Acceptance criteria
- [ ] Existing flows behave exactly as before, and their e2e specs still pass:
  - `/start <code>` and `/stop`;
  - PR approve / request changes;
  - away-mode approve / deny;
  - session question buttons and replies.
- [ ] `/project` shows only projects where the linked user is an active member. A choice persists across messages and API restarts.
- [ ] `/project <slug>` switches. An unknown slug or a project without membership gets a clear refusal.
- [ ] A user with exactly one project has it selected without asking.
- [ ] The callback codec has unit tests showing that every encoded payload is ≤ 64 bytes and that a malformed payload is rejected, not thrown.
- [ ] The guard helper refuses unlinked chats, non-members and members below operator for write actions. Each case is covered by a spec.
- [ ] `/help` and the Telegram command menu list the commands.
- [ ] A new ADR is merged in the same PR, and spec 22 references it.

## Out of scope
- Any Board command beyond `/project` and `/help`: `/new`, `/board`, card actions and the Mini App are separate cards.
- Webhooks: the bot stays on long polling (spec 22 D7).
- Group chats: the bot stays private-chat only.

## Open questions
None.
