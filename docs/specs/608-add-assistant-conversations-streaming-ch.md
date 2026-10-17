# C-238: Add assistant conversations, streaming chat API and Board tools

Issue: #608

## What to do
Build `apps/api/src/assistant/` on top of the LLM gateway (`apps/api/src/llm/`). Use `luna-projects/luna-watch/apps/api/src/luna-chat/` as a reference, but stream real tokens: Luna sends the whole reply as a single chunk.

**Storage.** Add Prisma models through `prisma migrate dev`:
- `AssistantConversation`: `userId`, nullable `projectId`, `title`, `model`, `provider`, timestamps. It is personal: only its owner can access it.
- `AssistantMessage`:
  - `role`;
  - `content`, the English canonical text;
  - `displayContent`, the text in the person's language;
  - `language`;
  - tool calls and results as JSON;
  - model, provider and a usage reference.
- `AssistantAttachment`, one of three kinds:
  - a Board card;
  - an agent session, only for projects with session content opted in (ADR-0021);
  - a file or screenshot, stored as in ADR-0031. Images go to vision-capable models.

**Endpoints.** CRUD for conversations, a message list, attachments, and `POST /assistant/conversations/:id/stream`. The stream sends SSE text deltas and tool progress, then `done`, or a typed error such as `llm_cap_reached`. Every input is a DTO, and the stream endpoint is throttled.

**Model and title.** The model is picked from the enabled models, or the default is used. The title comes from the cheapest enabled model, tagged `title`.

**Project.**
- The person picks a project, or leaves it on Auto.
- On Auto, the assistant resolves the project from the message against the projects the person can access. If several match, it asks which one; once resolved, it records the project on the conversation.

**Language.** The reply is in the language of the latest message. The same model call produces the English `content`. DeepL is not used, an exception to ADR-0033 recorded in an ADR.

**Tools.** Add a tool registry that later cards extend:
- Read tools over the existing services (projects, cards, fleet, queue, budget, activity, sessions, approvals), with the same role checks as the web.
- Draft and queue cards, as the New work intake does.
- Request stop, handoff or merge through the existing action requests and approvals. These are never executed directly, and writes require operator or higher.

## Acceptance criteria
- [ ] The migration adds the three models. Tests check that another person's conversation is inaccessible.
- [ ] The stream emits incremental deltas, not one chunk, and ends with `done` or a typed error.
- [ ] On Auto, a message naming one accessible project binds the conversation to it; an ambiguous message makes the assistant ask.
- [ ] A Russian message gets a Russian reply, with English `content` and Russian `displayContent`, and no DeepL call (a test asserts this).
- [ ] The read tools return only data from projects the person can access.
- [ ] A requested action creates a pending action request instead of running.
- [ ] Attaching a session from a project without session content opted in is refused.
- [ ] Every call is metered and respects the caps.

## Out of scope
- The web UI, Telegram, code tools and the other AI features.
- Shared conversations.

## Open questions
- How a reopened conversation is shown. Default: it shows `displayContent`; `content` is the English text used for model context and search.
