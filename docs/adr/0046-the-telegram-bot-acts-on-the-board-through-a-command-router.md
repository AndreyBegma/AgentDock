# ADR-0046: The Telegram bot acts on the Board through a command router, with a per-chat current project

Status: accepted · Date: 2026-10-16 ·
Issue: [#500](https://github.com/AndreyBegma/AgentDock/issues/500) ·
Spec: [`docs/specs/500-add-a-telegram-command-router-and-per-ch.md`](../specs/500-add-a-telegram-command-router-and-per-ch.md) ·
Widens [spec 22](../specs/22-notifications-and-telegram.md) scope · Keeps spec 22 D7, D10 and D12 ·
Amended by [ADR-0061](0061-telegram-free-text-goes-to-the-api-assistant.md) (free text goes to the API assistant, never to a runner)

## Context

Spec 22 made the bot a notification channel. It links a chat with `/start <code>`, unlinks it with `/stop`, and sends messages. Its only actions are buttons and replies on those messages: Approve and Request changes on a pull request (D12, #82), Approve and Deny on an action request (spec 201 D18), and the option buttons and replies of a waiting card (#489). The poller routed each update by hand to one of four services, and it ignored every other text.

Stack S-1 runs the Board from Telegram. People will create cards with `/new`, browse columns with `/board`, and move, stop and accept cards. That turns the bot from a channel into a second surface of the Board, and it needs three things the hand routing does not have:

- a place where a command plugs in;
- a way to know which project a command means;
- one check of who the chat is and what they may do.

## Decision

1. **The bot acts on the Board, not only on notifications.** This widens spec 22. Spec 22 scoped Telegram to notifications plus D12's buttons. Board commands are now in scope, each delivered by its own card. The bot stays on long polling (D7) and in private chats only.

2. **One router.** `TelegramRouter` routes every update:
   - a button press goes to the handler of its `callback_data` prefix (`<prefix>:…`), and a press with an unrouted prefix goes to the approval handler, which refuses it as an invalid button;
   - a message goes to the reply handlers in order, so a reply to one of the bot's prompts is handled as before;
   - otherwise a message goes to its command (`/cmd args` or `/cmd@Bot args`);
   - an unknown command in a private chat gets a pointer to `/help`, and other text is still ignored.

   All routes are listed in one table, `TelegramRoutes`. The existing handlers moved onto the router with unchanged behaviour.

3. **Typed callback data.** A new button's `callback_data` is built by `callbackCodec(prefix, fields)`. The codec computes its longest payload when it is defined and refuses one that could pass Telegram's 64 bytes. Decoding returns null for anything malformed and never throws. Cards are carried by their 8-character `shortId` and projects by their id. The prefixes already in chats (`a`, `r`, `x`, `y`, `q`) are reserved and keep their hand-written codecs.

4. **A current project per chat.** `telegram_links.currentProjectId` (null until chosen, cleared when the project is deleted) holds the project the chat's Board commands act on, so it survives restarts.
   - `/project` lists the projects the linked user is an active member of as buttons, each with the user's role.
   - `/project <name>` switches by repository name.
   - A user with exactly one project has it selected without being asked.
   - Every choice is audited as `telegram.project`.
   - Every Board reply names its project first.

5. **Buttons carry their own project.** A button on a notification or a Board message names its own project, or reaches it through its notification. Pressing it never reads the chat's current project, so switching projects never redirects a button that is already in the chat.

6. **One guard.** `TelegramGuard` resolves the chat's linked user and checks that the user is active. It then checks membership through `ProjectAccessService` (spec 10 D11) and the role the action needs:
   - a read needs any active member;
   - a write needs operator or higher.

   Every press, reply and command runs the check from scratch, and nothing is cached across updates. The approval, action-request and session-message services use the guard in place of their own copies of this check.

7. **D10 and D12 still hold.** Board replies are fixed text about cards, columns and projects. They never include pane text, prompts, code or secrets (D10). Every action goes through the same typed service the web app calls, with the same role check and an audit row with `meta.via = "telegram"`. The bot never sends free-form input to a runner (D12, ADR-0010).

8. **One command list.** `BOT_COMMANDS` is the list that `/help` prints and that `setMyCommands` registers for private chats. The menu is set when an admin configures the bot. The poller sets it again for a bot it has not set it for yet, which covers bots configured before this change and API restarts. A Board command added later goes into the list.

## Consequences

- A Board command is a handler plus a line in `TelegramRoutes` and `BOT_COMMANDS`. It gets the current project from `TelegramProjectService.current()` and the role check from `TelegramGuard`.
- The bot is now a second Board surface, so a bug in a Telegram handler can change Board state. The guard, the shared services and the audit row bound this risk the same way they bound D12's buttons.
- A user who leaves a project loses it as the current project on their next command. They are asked to choose again, or their only remaining project is taken.
- `/start` stays out of the command menu, because it needs the one-time code that only AgentDock's link hands out.
