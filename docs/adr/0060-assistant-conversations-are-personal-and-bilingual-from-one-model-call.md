# ADR-0060: Assistant conversations are personal, stored in English and the person's language from one model call, and act through Board tools as the person

Status: accepted · Date: 2026-10-17 ·
Card: C-238 (stack S-3, stage 2) ·
Issue: [#608](https://github.com/AndreyBegma/AgentDock/issues/608) ·
Spec: [`docs/specs/608-add-assistant-conversations-streaming-ch.md`](../specs/608-add-assistant-conversations-streaming-ch.md) ·
Builds on: [ADR-0059](0059-the-api-calls-llm-providers-directly-for-assistant-features.md) ·
Exception to: [ADR-0033](0033-deepl-translates-stored-text-at-save-time.md) ·
Keeps: [ADR-0021](0021-session-content-is-opt-in-per-project.md), [ADR-0031](0031-attachments-are-stored-by-the-api-on-a-local-volume.md), [ADR-0046](0046-the-telegram-bot-acts-on-the-board-through-a-command-router.md) §6, [ADR-0058](0058-new-work-cards-are-candidates-until-accepted.md)

## Context

ADR-0059 gave the API one LLM gateway. Stack S-3 stage 2 puts a chat
assistant on it: the web window and the Telegram bot of later stages both talk
to it. The assistant reads the Board, the fleet, the queue, budgets, activity,
sessions and approvals, drafts cards, and asks for stop, merge and handoff. It
answers in the person's language, while the rest of AgentDock stores English
(ADR-0027, ADR-0033).

## Decision

1. **A conversation is personal.** `assistant_conversations` belongs to one
   user. Every route reads it by id *and* owner, so another person's
   conversation, an admin's included, is 404, like one that does not exist.
   Shared conversations are out of scope.
2. **Models.** A conversation may pick any model enabled for a provider with a
   key and a cap above 0 (`GET /assistant/models`); without a pick it uses the
   instance default. The title is written after the first reply by the
   cheapest of the enabled models, priced at a million tokens in and out with
   the current price table, and metered with the feature tag `title`. A title
   that fails is skipped; the reply stands.
3. **Project: picked, or Auto.** `projectId` null is Auto. On Auto, each
   message is matched against the projects the person can access, by display
   name, `owner/name` or repository name as whole words (or the first word of a
   multi-word name when no full name matches).
   - When one project matches, it is recorded on the conversation, and the
     stream says so with a `project` event.
   - When several match, the system prompt lists them and tells the model to
     ask which one, and the conversation stays on Auto.
   - Once the person answers, the model records the project with
     `choose_project`.
   - A person with a single project gets it without being asked.
   - A bound project the person can no longer access returns the
     conversation to Auto.
4. **One model call gives both languages; DeepL is not used.** The model
   replies in the language of the person's latest message, and then, after a
   fixed marker, writes a JSON trailer with the language code, the reply in
   English and the person's message in English.
   - The stream sends the reply up to the marker. A piece that could be the
     start of the marker is held back until the next chunk.
   - The trailer is never streamed.
   - `content` stores the English text and is what later turns send the model
     as context and what search reads. `displayContent` stores the text in the
     person's language and is what a reopened conversation shows.
   - A reply without a valid trailer is stored as it is, with language `und`.

   **This is an exception to ADR-0033.** That ADR covers text a person saves
   on a card or plan. A chat turn already pays for a model call that sees the
   whole context, so translating in the same call costs a few hundred output
   tokens. A DeepL call would cost more, add up to 4 s to every turn, and
   translate without the conversation's context. DeepL stays the translator
   for saved Board text.
5. **Attachments.** An attachment is one of three kinds. A pending attachment
   (`messageId` null) is taken by the next message sent. Access is checked
   again when the attachment is sent to the model, so content the person has
   lost access to is never read.
   - **A card** of a project the person can see.
   - **An agent session**, only of a project that ships session content
     (ADR-0021). Any other session is refused with 409
     `session_content_off`, including a session with no project. The newest
     60 content items are sent.
   - **A file or screenshot**, uploaded through the Board's upload path
     (ADR-0031: the content is sniffed, the size and the project's quota are
     checked, and the file is stored on the local volume). It is stored
     against the conversation's project, so a conversation on Auto refuses a
     file with 409 `project_required`. The upload needs operator, as the
     Board's upload route does. The attachment row is claimed at once, so the
     pending-upload sweep never deletes it. Deleting the attachment or the
     conversation deletes the file.
     - Images go to a model that takes images (`llmModelSeesImages`). Any
       other model is sent a note in their place.
     - Text files are sent as text.
6. **Tools are a registry that later cards extend.**
   - **How a tool is added.** `AssistantToolRegistry` holds every tool. A
     module adds its own in `onModuleInit`. Each tool has a zod input, which is
     sent to the provider as JSON Schema and checked again before the tool
     runs.
   - **Project and role check.** A tool gets its project from
     `ctx.project(need, id?)`, which checks it the way the web does (spec 10
     D11; the same rule as `TelegramGuard`, ADR-0046 §6):
     - a project the person cannot see is refused;
     - reads need any member;
     - writes need operator or higher.
   - **Refusals.** A refusal goes back to the model as a tool error, never as
     data.
   - **Board tools.**
     - Reads: `list_projects`, `read_board`, `read_card`, `read_fleet`,
       `read_queue`, `read_budget`, `read_activity`, `read_sessions` (metadata
       only) and `read_approvals`. They call the same services the web routes
       use.
     - `draft_card` returns a draft and writes nothing. The step carries the
       draft, so the chat can show Edit and Queue.
     - `queue_card` writes the card to the top of To Do, as accepting a New
       work candidate does (ADR-0058). It runs only when the person asks to
       queue the card.
     - `request_action` only ever creates a pending action request (spec 201
       D18), which a person approves in Approvals or Telegram:
       - `stop` is `orchestrator_stop`;
       - `merge` is `pr_approve` of the card's PR;
       - `handoff` files the card as an issue held without the ready label,
         with an `issue_queue` request (C-112, ADR-0051).

       The existing self-approval rule applies. Nothing is executed directly,
       and no new action-request kind is added.
7. **Streaming.** `POST /assistant/conversations/:id/stream` answers
   `text/event-stream`, one `data:` line of JSON per event:
   - `delta` events, as the provider sends text;
   - `tool` events, `started` then `done` with the step's summary;
   - `project`;
   - `title`;
   - then exactly one of `done`, with both stored messages, or `error`, with a
     typed code: the gateway's `LlmErrorCode` (e.g. `llm_cap_reached` with
     `resetsAt`) or an assistant code.

   A conversation the person does not own is a plain 404 before the stream
   opens. A turn that fails deletes its user message, so a retry does not
   duplicate it, and its attachments become pending again. A closed connection
   aborts the provider call; the gateway records it as `aborted`.

   The route is throttled to 20 turns a minute per user.
8. **Every call is metered and capped by the gateway.** A turn makes at most 8
   model calls (tool rounds, then the answer; the last call is offered no
   tools). Each call goes through `LlmGateway` with the person's id and the
   feature tag `assistant`. The gateway refuses a call over the cap before it
   is sent and writes one `llm_calls` row for every call that is sent. The
   assistant message keeps the ids of its rows (`llmCallIds`).

## Consequences

- Stored conversations stay searchable in English whatever the person writes.
  A reply's English is the model's own translation, and it is as good as the
  model.
- The trailer costs output tokens on every reply. A model that ignores the
  format leaves `content` equal to `displayContent`, in the person's language.
- Tools act with the person's own rights. A viewer can ask anything but
  change nothing, and every write is the same audited service call the web
  makes.
- The fleet, queue, approvals and sessions query services are now exported
  by their modules for the assistant to call.
- Rejected:
  - **DeepL for each message.** A second paid call with latency, and it
    translates without the conversation's context.
  - **New action-request kinds for card stop and merge.** The existing kinds,
    with their executors, their approval rules and their Telegram buttons,
    already cover the orchestrator, the PR and the fleet queue.
