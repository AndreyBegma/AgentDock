# ADR-0061: Free text in Telegram goes to the API assistant as the linked user, never to a runner

Status: accepted · Date: 2026-10-17 ·
Card: C-240 (stack S-3, stage 3) ·
Issue: [#620](https://github.com/AndreyBegma/AgentDock/issues/620) ·
Spec: [`docs/specs/620-route-free-text-in-telegram-to-the-ai-as.md`](../specs/620-route-free-text-in-telegram-to-the-ai-as.md) ·
Amends: [ADR-0046](0046-the-telegram-bot-acts-on-the-board-through-a-command-router.md) §2 and §7 ·
Builds on: [ADR-0059](0059-the-api-calls-llm-providers-directly-for-assistant-features.md), [ADR-0060](0060-assistant-conversations-are-personal-and-bilingual-from-one-model-call.md) ·
Keeps: ADR-0046 §5 and §6, [ADR-0010](0010-typed-command-allowlist-on-the-runner.md), [ADR-0031](0031-attachments-are-stored-by-the-api-on-a-local-volume.md)

## Context

ADR-0046 §2 says the bot ignores any text that is not a reply to one of its prompts or a command. §7 says the bot never sends free-form input to a runner. Stack S-3 adds an AI assistant to AgentDock (ADR-0060), and its design shows the same assistant in Telegram: a person writes to the bot in their own words and gets an answer in their language, with the existing approval buttons on any action it asks for.

Two things have to be settled. The first is where free text goes now that the bot no longer ignores it. The second is how that stays within §7, because the assistant can read sessions and code that runners report and can ask for actions that runners carry out.

## Decision

1. **Free text goes to the API assistant.** `TelegramRouter` gets one more route, `freeText`. It takes a message that no reply handler claimed and that is not a command. `TelegramAssistantService` runs it as one assistant turn (ADR-0060) in the API, as the chat's linked user. Replies to the bot's prompts and the `/new` intake still come first, so the text they wait for never reaches the assistant. Group chats, unlinked chats and media other than photos are still ignored, and an inactive user gets the guard's refusal.

2. **Still never to a runner.** The text becomes a stored message of an assistant conversation and a model call through the LLM gateway (ADR-0059). It is never a runner command, a prompt to a session, or a pane input. The assistant reaches the fleet only through its tools: reads go through the services the web reads with, and a stop, merge or handoff only creates a pending action request (ADR-0060 §6). The runner still accepts typed commands only (ADR-0010). This keeps §7's promise, and §7 now reads "the bot never sends free-form input to a runner; free text goes to the API assistant".

3. **The person, with the person's checks.** A turn runs as the chat's linked, active user (`TelegramGuard.linkedUser`), from scratch for each message. Every tool checks the person's project role as it does on the web: a read needs any member, and a write needs operator or higher (ADR-0046 §6). The gateway meters and caps every call. When a provider is at its cap, the chat gets a fixed message that names the provider and the day calls resume (UTC). Other failures get a fixed message too, and the error's own text is never shown.

4. **One conversation per chat, shared with the web.** `telegram_links.assistantConversationId` holds the conversation the chat continues. It is null until the chat's first message and after `/newchat`, and it is cleared when the conversation is deleted. The conversation is an ordinary one of the user's (ADR-0060 §1), so the web rail lists it, and it can be continued, renamed or deleted there. A new conversation starts on the chat's current project (`/project`, ADR-0046 §4) when there is one. Otherwise it starts on Auto, and the assistant works the project out. A conversation still on Auto takes the chat's project once one is chosen. `/newchat` is in `BOT_COMMANDS`, so `/help` and the menu list it.

5. **Replies.** The bot shows "typing…" while the turn runs. The reply is the one the web stores in the person's language. It is converted from the model's Markdown to MarkdownV2, with bold, italic, strikethrough, code, http(s) links and quotes kept and every other character escaped. A reply longer than Telegram's limit is split between lines, never inside a mark. When Telegram still refuses a part's markup, that part is sent as plain text.

6. **Approvals reuse the existing buttons.** When the turn created action requests, the reply carries the Approve / Deny buttons of each request's `action.requested` notification to the person. These are the same `x:` / `y:` callbacks, and they are checked the same way when pressed (spec 201 D18). Nothing is approved by the reply itself.

7. **Photos.** A photo with a caption is stored as a file of the conversation, the same way the web's upload is stored (ADR-0031). It goes against the conversation project's quota and needs operator or higher, and the caption is the message. Without a project, or without a caption, the chat is told what to do and nothing is stored.

8. **Beside the poller, one turn per chat.** A turn runs beside the poller rather than inside it, so a slow model never holds up anyone's buttons. A chat has at most one turn at a time. A message that arrives while one runs is refused with a fixed text, and nothing is queued.

## Consequences

- The bot is now also a surface of the assistant. Everything the assistant may do from the web, it may do from Telegram, with the same checks, caps and audit. It can do nothing more.
- A turn that is running when the API stops is lost: the update was already consumed, and the person sends the message again. The turn stores nothing until it has finished (ADR-0060).
- A requested action can show its buttons twice: once on the reply, and again when the `action.requested` notification is delivered to the chat. Both work. A press after the request was decided is refused, because the request is no longer pending.
- Voice messages to the assistant are not part of this decision, and neither are the Board commands of stack S-1.
