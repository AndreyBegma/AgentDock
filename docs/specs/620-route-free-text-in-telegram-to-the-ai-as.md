# C-240: Route free text in Telegram to the AI assistant

Issue: #620

## What to do
`TelegramRouter` ignores free text today (ADR-0046). Add a route in `apps/api/src/telegram/telegram-routes.ts` that sends free text from a linked chat to the assistant as the linked user, with the checks `TelegramGuard` already applies.

- **Conversations.** A chat continues its current conversation. `/newchat`, added to `BOT_COMMANDS` in `telegram-commands.ts`, starts a fresh one. These conversations also appear in the web rail.
- **Project.** The chat's current project (`/project`) is the default; without one, the assistant resolves it.
- **Replies.** Show a typing indicator, then send one MarkdownV2 reply, split when it is too long.
- **Approvals.** Action requests reuse the existing approval buttons.
- **Photos.** A photo with a caption is attached as a file.

Record a new ADR amending ADR-0046: free text goes to the API assistant, and it still never reaches a runner directly.

## Acceptance criteria
- [ ] Free text from a linked chat gets a reply in the same language, and the conversation shows in the web rail.
- [ ] Text from unlinked chats is still ignored.
- [ ] Write requests from a member below operator are refused.
- [ ] `/newchat` works and is listed in `/help`.
- [ ] The current project is used when set.
- [ ] Long replies are split, and MarkdownV2 escaping is tested.
- [ ] When the cap is reached, the chat gets a fixed message with the provider and the reset date.
- [ ] A new ADR records the change.

## Out of scope
- The Board commands of stack S-1 (`/new`, `/board`).
- Voice messages.

## Open questions
None.
