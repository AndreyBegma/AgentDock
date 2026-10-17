# ADR-0045: A person may message a running session; a fleet worker's message is recorded for the orchestrator

Status: accepted · Date: 2026-10-16 ·
Issue: [#489](https://github.com/AndreyBegma/AgentDock/issues/489) ·
Spec: [`docs/specs/489-message-a-running-session-and-answer-its.md`](../specs/489-message-a-running-session-and-answer-its.md) ·
Amends [ADR-0005](0005-drive-the-cs-orchestrator-skill-do-not-reimplement-it.md) · Scopes [ADR-0040](0040-steward.md) §4 · Scoped by [ADR-0047](0047-a-runner-local-security-policy-the-server-cannot-change.md) §6

## Context

A person who wants to tell a running agent something has two ways today. **Take control** attaches the terminal for writing. It is admin-only, and every keystroke goes to the live session. A **feedback round** starts a new round, which only works once the card is finished. Neither helps with the common case: the agent is working or asks a question (`AskUserQuestion`, #473), and the person wants to add one line or pick option 2. They should be able to do that from the card, from the read-only terminal, from Telegram or from the Fleet page.

For a fleet worker this conflicts with how ADR-0005 has been read so far. The fleet is the orchestrator's, the orchestrator is the one brain, and AgentDock observes it. ADR-0005 already allows control that bypasses the orchestrator (stop a slot, message a worker), as long as it uses the skill's own mechanisms and *is recorded as an event so the orchestrator sees it on its next wake*. AgentDock's `slot.message` wrote `.orchestrator-msg.md` and typed a prompt, but it never wrote that event. The orchestrator learned of the message only when the worker happened to mention it.

## Decision

1. **One typed command, text only.** `session.message` (ADR-0010) takes a target and a message:
   - a target is either a card round (`cardId`, `runId`) or a fleet slot (`root`, `slot`);
   - a message is either text, an option number, or an "Other" text, and an answer names the question screen it answers.

   The runner works out the tmux session itself. The text goes in with `send-keys -l` and is submitted with Enter in a separate call. An answer is cursor moves plus Enter, computed from the pane the runner reads. No key ever comes from the request. The runner offers the command under the capability `sessionMessage`. Steward's nudge and the trailer guard's notice use the same delivery path, restricted to an idle prompt.

2. **Who and what.** Operators and admins may send, the same people as for card feedback; a viewer gets 403. The API cleans the text and the runner refuses text that is not clean: escape sequences, control characters, line breaks and zero-width or bidi characters are stripped, and the length is capped at 4 000 characters. Every message gets an audit row, `card.message` or `slot.session_message`. The row holds the text's hash and length, never the text, and says where the message came from (`web` or `telegram`).

3. **Busy is queued, not interrupted.** Text sent while the agent works is typed into Claude Code's input. Claude Code queues it and reads it at its next step. The runner types nothing into a question selector, a dialog or a permission prompt, and the result says so.

4. **Question selectors.** The runner reads a round's question selector from its pane, using the #473 detector extended to parse the screen. It reports the screen as `card_run.pending_question`, so the Board and Telegram can show the options. The question is session content (ADR-0021), so it is reported only for a project that ships content.

5. **Fleet workers (amends ADR-0005).** A person's message to a `cs-*` slot is typed into that worker's pane. In the same step it is appended to the orchestrator's own `events.jsonl` as `slot.message_sent` with `by: person`, in the format the plugin writes. The file-based `slot.message` now writes the same line. The orchestrator therefore stays the one that knows what each of its workers was told. It reads that from its own log, not from AgentDock.

6. **Steward stays out of the fleet (scopes ADR-0040 §4).** The fleet remains observe-only for *automation*. Steward sends fleet slots no command. Only a person, through the routes above, writes to a fleet worker.

7. **Telegram.** A `card.waiting` message carries one button per option of the question the session shows. A reply to that message is sent as text, or, while the question offers "Other", as the typed answer. Each press and each reply is checked from scratch: the chat must be a private chat linked to an AgentDock user with the one-time `/start` code, the message must have been sent to that user, and the user must be active and an operator of the project now.

## Consequences

- A person can steer a running agent without the admin-only Take control and without waiting for the round to finish. The read-only terminal view has a message line under it.
- A fleet worker can be told something the orchestrator did not decide. The orchestrator reads that in its own log on its next wake, and it can still disagree. Improvements to how it reacts belong in the skill (ADR-0005 still holds).
- Answers depend on Claude Code's selector rendering. The detector and the key plan are tested against captured panes, and a real-tmux test checks that option 2 selects option 2. A change in Claude Code's rendering shows up as `question_changed`, and nothing wrong is typed.
- Fleet slots do not report their question selector yet. On the Fleet page a person writes text, or answers in the terminal.
